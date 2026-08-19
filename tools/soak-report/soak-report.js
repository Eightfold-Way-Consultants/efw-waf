#!/usr/bin/env node
/*
 * Turnstile soak report — reproducible, all-API (no SSM in core), self-contained HTML.
 *   node soak-report.js [--env prod|preview] [--hours 72] [--out file.html] [--accounts]
 *
 * ONE unified server-gate telemetry view across every surface that enforces Turnstile:
 *   Logon (register/forgot/resend) · estimator (share) · twproxy (feedback) · pdfreport (pdfshare).
 * The report is DATA-DRIVEN: it reads the per-system CloudWatch event groups, derives `system`
 * from the event field (falling back to the source group) and DISCOVERS endpoints from the data —
 * there is no hardcoded form→server map, so a new surface/form appears automatically in every panel.
 *
 * Lifecycle per form (each stage labeled with the OBSERVED disposition):
 *   [1] Cloudflare issuance (turnstileAdaptiveGroups)
 *   [2] widget mounted  (type=widget beacon; not-loaded = mount fail)
 *   [3] challenge solved (beacon solved; each fail `reason` is a separate exit)
 *   [4] server receipt   (type=turnstile: pass / fail / pass-ratelimited / bypassed = allowed;
 *                         fail/absent = 403 under Enforce; absent = tokenless direct-to-server bot)
 *   [4] rate-limit exit  (type=ratelimit: 429 — Logon only)
 * The centerpiece is a left→right STAGE FLOW DIAGRAM (inline SVG) quantifying flow-through vs
 * every drop-off, with the tokenless/`absent` bypass entering directly at the server stage.
 *
 * Sources (all API): CF GraphQL turnstileAdaptiveGroups + Logs Insights over /logon/events,
 * /twproxy/events, /estimator/events, /pdfreport/events (prod, lake-tapped) or their
 * /{surface}-preview/events counterparts (env split by the emitter's {surface}-{env}-events
 * filename, NOT by box) + twproxy-logs/* (pre-gate
 * plain text) + CloudWatch alarms. The new groups do not exist until their apps deploy; queries
 * against a missing group are swallowed and the surface renders "awaiting data" (never n/a, never
 * an error). The combined Athena `events` table (logon-telemetry.yaml) is the durable cross-surface
 * sink; this report uses per-group Insights for the live view. See athenaQueryStub() for the
 * forward-compat cross-lake path (WAF edge layer).
 *
 * "Organic" = ua~/curl/ excluded. Deps: none (shells out to `aws` CLI + `curl`). Output: one rich
 * self-contained HTML (inline CSS + SVG) that renders identically in a browser and in the PDF that
 * soak-mail.ps1 produces via headless Chromium. (The old email-safe --email render is retired.)
 */
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
// aws CLI is Python; on Windows it renders JSON to cp1252 stdout and throws on non-latin1 bytes
// (e.g. SQLi payloads in twproxy logs), corrupting the JSON we parse. Force UTF-8 for all subprocesses.
process.env.PYTHONUTF8 = '1';
process.env.PYTHONIOENCODING = 'utf-8';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ENV = (opt('env', 'prod') === 'preview') ? 'preview' : 'prod';
const ACCOUNTS = args.includes('--accounts');   // opt-in: query logon2.AspNetUsers via SSM/DB (breaks all-API purity)
const HOURS = parseInt(opt('hours', '72'), 10);
const OUT = opt('out', `soak-report-${ENV}.html`);
const REGION = 'us-west-1';
const CFG = { prod: { label: 'production' }, preview: { label: 'preview' } }[ENV];

// Per-system event sources. `system` here is the FALLBACK when an event lacks its own `system`
// field (the field is authoritative once each app deploys it). This is infra config, not a
// form→server map: endpoints are discovered from the data, so a new form appears automatically.
const SOURCES = ENV === 'prod'
  ? [
    { group: '/logon/events', system: 'logon', primary: true },
    { group: '/twproxy/events', system: 'twproxy' },
    { group: '/estimator/events', system: 'estimator' },
    { group: '/pdfreport/events', system: 'estimator' },
  ]
  : [
    { group: '/logon-preview/events', system: 'logon', primary: true },
    { group: '/twproxy-preview/events', system: 'twproxy' },
    { group: '/estimator-preview/events', system: 'estimator' },
    { group: '/pdfreport-preview/events', system: 'estimator' },
  ];
const PRIMARY = SOURCES.find(s => s.primary).group;
const SYSTEMS_CONFIGURED = [...new Set(SOURCES.map(s => s.system))];

// twproxy (feedback proxy) PRE-GATE plain-text group, per env box (web-06=public, web-04=preview2).
// This carries the attack detail that exits BEFORE the verify point (method/tags/SQLi) — the
// structured /twproxy/events group (above) will carry the verify-decision events once deployed.
const TWGROUP = { prod: 'twproxy-logs/ip-10-3-0-63.us-west-1.compute.internal', preview: 'twproxy-logs/ip-10-3-0-122.us-west-1.compute.internal' }[ENV];
const TW_HOURS = 24 * 14;   // twproxy files are month-accumulating + bulk re-shipped on rotation deploy — read the full retained window

// cosmetic sort orders only (NOT a system/endpoint map — anything unlisted still renders, sorted last)
const SYS_ORDER = ['logon', 'estimator', 'twproxy'];
const EP_ORDER = ['register', 'forgot', 'resend', 'share', 'pdfshare', 'feedback'];
const sysSort = (a, b) => (SYS_ORDER.indexOf(a) + 1 || 99) - (SYS_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b);
const epSort = (a, b) => (EP_ORDER.indexOf(a) + 1 || 99) - (EP_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b);
const MOUNTFAIL = new Set(['not-loaded', 'not-mounted', 'notloaded', 'notmounted']);  // beacon reasons that mean the widget never rendered

const TH = { failRed: 10, absentYellow: 40, ratelimitedRed: 1 };
const BLOT = args.includes('--allua') ? 'ispresent(type)' : 'not (ua like /curl/)';

// derived `layer` axis (forward-compat for WAF unification): a pure function of `system`, NOT a
// stored field. Every current surface is the app layer; the WAF edge layer prepends later (§5, Future).
const layerOf = (_system) => 'app';   // edge=WAF, app=Turnstile; edge added when the WAF lake joins

const now = Date.now(), startMs = now - HOURS * 3600 * 1000;
const twStartMs = now - TW_HOURS * 3600 * 1000;
const aws = (a) => JSON.parse(execFileSync('aws', a.concat(['--region', REGION, '--output', 'json']), { encoding: 'utf8', maxBuffer: 64 << 20 }));
const iso = (ms) => new Date(ms).toISOString();
const sleep = (ms) => execFileSync(process.execPath, ['-e', `setTimeout(()=>{},${ms})`]);
const warn = [];
const tryd = (label, fn, d) => { try { return fn(); } catch (e) { warn.push(label + ': ' + e.message); return d; } };

function insights(q, group = PRIMARY, s0 = startMs, e0 = now) {
  const s = aws(['logs', 'start-query', '--log-group-name', group, '--start-time', String(Math.floor(s0 / 1000)), '--end-time', String(Math.floor(e0 / 1000)), '--query-string', q]);
  for (let i = 0; i < 40; i++) {
    const r = aws(['logs', 'get-query-results', '--query-id', s.queryId]);
    if (r.status === 'Complete') return r.results.map(row => Object.fromEntries(row.map(f => [f.field, f.value])));
    if (r.status === 'Failed' || r.status === 'Cancelled') throw new Error('Insights ' + r.status);
    sleep(1500);
  }
  throw new Error('Insights timeout');
}
function groupExists(g) {
  return tryd('probe ' + g, () => {
    const r = aws(['logs', 'describe-log-groups', '--log-group-name-prefix', g, '--query', 'logGroups[].logGroupName']);
    return Array.isArray(r) && r.includes(g);
  }, false);
}
// Last event ANY time (not window-bounded) -- turns "0 rows in window" into a datable fact:
// a live-but-quiet surface reports when it last spoke instead of being mislabeled "not deployed".
function lastEventMs(g) {
  return tryd('last-event ' + g, () => {
    const r = aws(['logs', 'describe-log-streams', '--log-group-name', g, '--order-by', 'LastEventTime',
      '--descending', '--max-items', '1', '--query', 'logStreams[0].lastEventTimestamp']);
    return typeof r === 'number' ? r : null;
  }, null);
}
const agoWords = (ms) => {
  if (ms == null) return null;
  const h = (now - ms) / 3600000;
  return h < 1 ? Math.max(1, Math.round(h * 60)) + 'm ago' : h < 48 ? h.toFixed(1) + 'h ago' : Math.round(h / 24) + 'd ago';
};

// Forward-compat stub: the WAF edge lake is Athena-only, so Athena is the common denominator for
// cross-LAYER (edge+app) reporting. Unification = adding a source here, not a rewrite. Unused today
// (the live view reads per-group Insights); wired when the public WAF ACL logs flow (§5, Future phase).
function athenaQueryStub(sql, { database = 'logon_telemetry', workgroup = 'primary', output = 's3://efw-athena-results/soak/' } = {}) {
  const start = aws(['athena', 'start-query-execution', '--query-string', sql,
    '--query-execution-context', `Database=${database}`, '--work-group', workgroup,
    '--result-configuration', `OutputLocation=${output}`]);
  const id = start.QueryExecutionId;
  for (let i = 0; i < 60; i++) {
    const st = aws(['athena', 'get-query-execution', '--query-execution-id', id]).QueryExecution.Status.State;
    if (st === 'SUCCEEDED') return aws(['athena', 'get-query-results', '--query-execution-id', id]).ResultSet;
    if (st === 'FAILED' || st === 'CANCELLED') throw new Error('Athena ' + st);
    sleep(2000);
  }
  throw new Error('Athena timeout');
}
void athenaQueryStub;  // reserved for the edge-layer (WAF) join; see §5 forward-compat / Future phase

// ---- gather: unified per-system event sources ----
const serverRows = [], beaconRows = [], beaconFailRows = [], rlRows = [], siteRows = [];
let serverDayRows = [];
for (const src of SOURCES) {
  src.exists = groupExists(src.group);
  if (!src.exists) continue;
  const g = src.group, sf = src.system;
  const tag = rows => { for (const r of rows) if (!r.system) r.system = sf; return rows; };
  const srvRows = tag(tryd(g + ' server', () => insights(`filter type='turnstile' and ${BLOT} | stats count() as n by system, endpoint, outcome, allowed`, g), []));
  src.serverN = srvRows.reduce((a, r) => a + (+r.n || 0), 0);
  serverRows.push(...srvRows);
  beaconRows.push(...tag(tryd(g + ' beacon', () => insights(`filter type='widget' and ${BLOT} | stats count() as n by system, action, event`, g), [])));
  beaconFailRows.push(...tag(tryd(g + ' beacon-fail', () => insights(`filter type='widget' and event='failed' and ${BLOT} | stats count() as n by system, action, reason | sort n desc`, g), [])));
  rlRows.push(...tag(tryd(g + ' ratelimit', () => insights(`filter type='ratelimit' and ${BLOT} | stats count() as n by system, action`, g), [])));
  siteRows.push(...tag(tryd(g + ' sites', () => insights(`filter type='turnstile' and ${BLOT} | stats count() as n by system, hostname, config, targetState, outcome | sort n desc | limit 80`, g), [])));
  if (src.primary) serverDayRows = tag(tryd(g + ' by-day', () => insights(`filter type='turnstile' and ${BLOT} | stats count() as n by outcome, bin(1d) as day | sort day asc`, g), []));
}
const alarms = tryd('alarms', () => (aws(['cloudwatch', 'describe-alarms', '--alarm-names', 'logon-widget-failed-spike', 'logon-verify-absent-spike']).MetricAlarms || []).map(a => ({ name: a.AlarmName, state: a.StateValue })), []);
const cfRowsRaw = tryd('CF issuance', () => {
  const { account_id, api_token } = JSON.parse(aws(['secretsmanager', 'get-secret-value', '--secret-id', 'cloudflare/api', '--query', 'SecretString']));
  const body = execFileSync('curl', ['-s', '-H', `Authorization: Bearer ${api_token}`, '-H', 'Content-Type: application/json',
    '--data', JSON.stringify({ query: `{ viewer { accounts(filter:{accountTag:"${account_id}"}) { turnstileAdaptiveGroups(limit:200, filter:{date_geq:"${iso(startMs).slice(0, 10)}"}) { count dimensions { action } } } } }` }),
    'https://api.cloudflare.com/client/v4/graphql'], { encoding: 'utf8', maxBuffer: 32 << 20 });
  const j = JSON.parse(body); if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 120));
  return ((((j.data || {}).viewer || {}).accounts || [])[0] || { turnstileAdaptiveGroups: [] }).turnstileAdaptiveGroups;
}, []);

// ---- twproxy PRE-GATE (feedback surface) — plain-text log group, full retained window ----
const twG = (label, q) => tryd('twproxy ' + label, () => insights(q, TWGROUP, twStartMs, now), []);
const twStartRows = twG('start', `filter @message like /Start request/ | stats count() as n`);
const twOutcomeRows = twG('outcome', `parse @message /Turnstile outcome: (?<oc>[A-Za-z]+)/ | filter ispresent(oc) | stats count() as n by oc | sort n desc`);
const twExitRows = twG('exits', `parse @message /Exit: (?<ex>[A-Za-z][A-Za-z ]*\\([^)]*\\)|[A-Za-z]+)/ | filter ispresent(ex) | stats count() as n by ex | sort n desc | limit 20`);
const twSqliRows = twG('sqli', `parse @message /Exit: Invalid validationType (?<vt>.+)$/ | filter ispresent(vt) | stats count() as n by vt | sort n desc | limit 12`);
const twModeRows = twG('mode', `parse @message /observe=(?<obs>True|False)/ | filter ispresent(obs) | stats count() as n, latest(@timestamp) as t by obs`);
const twRobotLatest = twG('robot-latest', `filter @message like /think you.re a robot/ | stats latest(@timestamp) as t`);

const twTotal = +((twStartRows[0] || {}).n || 0);
const twExits = twExitRows.map(r => ({ ex: r.ex, n: +r.n }));
const twExitTotal = twExits.reduce((a, e) => a + e.n, 0);
const twRobot = twExits.filter(e => /robot/i.test(e.ex)).reduce((a, e) => a + e.n, 0);
const twReached = twOutcomeRows.reduce((a, r) => a + (+r.n), 0);
const twPass = twOutcomeRows.filter(r => /pass/i.test(r.oc)).reduce((a, r) => a + (+r.n), 0);
const twSqli = twSqliRows.map(r => ({ vt: r.vt, n: +r.n })).filter(r => /select|union|sleep|if\(|now\(|sysdate|char\(|concat|--|;|'|\bor\b|\band\b|=/i.test(r.vt));
const twSqliTotal = twSqli.reduce((a, r) => a + r.n, 0);
const twHostile = Math.max(0, twTotal - twReached);
const twHostilePct = twTotal ? Math.round(twHostile * 100 / twTotal) : null;
const twMode = { observe: 0, require: 0 };
let tObsTrue = 0, tObsFalse = 0;
for (const r of twModeRows) { if (r.obs === 'True') { twMode.observe += +r.n; tObsTrue = +r.t || 0; } else { twMode.require += +r.n; tObsFalse = +r.t || 0; } }
const tRobot = (twRobotLatest[0] && +twRobotLatest[0].t) || 0;
const tRequireSig = Math.max(tObsFalse, tRobot);
const twModeLive = (!tObsTrue && !tRequireSig) ? 'unknown' : (tRequireSig >= tObsTrue ? 'Require' : 'Observe');

// ---- shape: unified, data-driven ----
const cfByEp = {}; for (const r of cfRowsRaw) { const ep = (r.dimensions.action || '').toLowerCase(); cfByEp[ep] = (cfByEp[ep] || 0) + r.count; }
const beaconByAction = {};   // ep -> {solved,failed}
for (const r of beaconRows) { const ep = (r.action || 'other'); const b = beaconByAction[ep] = beaconByAction[ep] || { solved: 0, failed: 0 }; b[r.event] = (b[r.event] || 0) + (+r.n); }
const reasonByAction = {};   // ep -> {reason:n}
for (const r of beaconFailRows) { const ep = (r.action || 'other'); const m = reasonByAction[ep] = reasonByAction[ep] || {}; const k = r.reason || '(none)'; m[k] = (m[k] || 0) + (+r.n); }
const serverByKey = {};      // "system|ep" -> {outcome:{a,b}}
const serverOf = {};         // ep -> system (discovered from whichever group's server events name it)
for (const r of serverRows) { const ep = r.endpoint || 'other'; const key = r.system + '|' + ep; const s = serverByKey[key] = serverByKey[key] || {}; const oc = s[r.outcome] = s[r.outcome] || { a: 0, b: 0 }; if (r.allowed === '0' || r.allowed === 'false') oc.b += +r.n; else oc.a += +r.n; if (!serverOf[ep]) serverOf[ep] = r.system; }
const rlByEp = {};           // ep -> 429 count (Logon only today)
for (const r of rlRows) { const ep = (r.action || 'other').toLowerCase(); rlByEp[ep] = (rlByEp[ep] || 0) + (+r.n); }

const systemsWithServer = [...new Set(serverRows.map(r => r.system))].sort(sysSort);

// ---- why is a surface silent? NOT-DEPLOYED vs LIVE-BUT-QUIET (never conflate the two) ----
// A group that exists but returned 0 verifies in the window is a TRUSTWORTHY ZERO -- the emitter
// shipped, the surface was simply unused. Only a group that does not exist is "not yet deployed".
const missingGroups = SOURCES.filter(s => !s.exists).map(s => s.group);
const idleGroups = SOURCES.filter(s => s.exists && !s.serverN)
  .map(s => ({ group: s.group, lastMs: lastEventMs(s.group) }));
const silentServerVal = missingGroups.length ? 'awaiting' : 'zero';
// copy for a form whose server stage produced nothing in the window (defined as a function: `esc`
// lands further down the file, so this must evaluate at render time, not here)
function silentServerNote() {
  if (missingGroups.length) return `server telemetry pending -- producer group not yet deployed (${esc(missingGroups.join(', '))})`;
  const idle = idleGroups.map(x => `<code>${esc(x.group)}</code>${x.lastMs ? ` (last event ${esc(iso(x.lastMs).slice(0, 16).replace('T', ' '))}Z, ${esc(agoWords(x.lastMs))})` : ' (no events ever)'}`).join(', ');
  return `no verifies in window -- every producer group is live${idle ? `: ${idle}` : ''}. Trustworthy zero, not a gap.`;
}
// live mode from the authoritative `mode` field on the primary (Logon) plane. The fleet rolls
// Observe→Enforce per site, so the window is often MIXED — reflect the split, and treat Enforce as
// "live" (fail/absent actually 403'd) if ANY Enforce verify or any blocked event is present.
const modeRows = tryd('mode', () => insights(`filter type='turnstile' and ${BLOT} | stats count() as n by mode`, PRIMARY), []);
const modeCounts = {}; for (const r of modeRows) modeCounts[r.mode || '?'] = (modeCounts[r.mode || '?'] || 0) + (+r.n);
const enfN = modeCounts.Enforce || 0, obsN = modeCounts.Observe || 0, modeTot = enfN + obsN;
const anyBlock = serverRows.some(r => (r.allowed === '0' || r.allowed === 'false'));
const enforceActive = enfN > 0 || anyBlock;
const modeWord = (enfN && obsN) ? `Observe→Enforce (${Math.round(enfN * 100 / modeTot)}% Enforce)` : enfN ? 'Enforce' : obsN ? 'Observe' : (anyBlock ? 'Enforce' : 'Observe');

// all endpoints seen anywhere (discovered from data)
const allEps = [...new Set([...Object.keys(beaconByAction), ...Object.keys(reasonByAction), ...Object.keys(cfByEp), ...serverRows.map(r => r.endpoint || 'other')])]
  .filter(e => e && e !== 'other').sort(epSort);

// aggregate a flow model over a set of endpoints
function collect(eps) {
  let cf = 0, solved = 0, failed = 0, mountFail = 0, pass = 0, fail = 0, rl = 0, byp = 0, absent = 0, absentBlock = 0, failBlock = 0, block = 0, rl429 = 0;
  const reasons = {};
  for (const ep of eps) {
    cf += cfByEp[ep] || 0;
    const b = beaconByAction[ep] || {}; solved += b.solved || 0; failed += b.failed || 0;
    for (const [k, n] of Object.entries(reasonByAction[ep] || {})) { if (MOUNTFAIL.has(k)) mountFail += n; else reasons[k] = (reasons[k] || 0) + n; }
    const sk = serverOf[ep]; if (sk) {
      const s = serverByKey[sk + '|' + ep] || {}; const g = oc => s[oc] || { a: 0, b: 0 };
      pass += g('pass').a + g('pass').b; fail += g('fail').a + g('fail').b; rl += g('pass-ratelimited').a + g('pass-ratelimited').b;
      byp += g('bypassed-auth').a + g('bypassed-auth').b; absent += g('absent').a + g('absent').b; absentBlock += g('absent').b; failBlock += g('fail').b;
      for (const oc of Object.keys(s)) block += s[oc].b;
    }
    rl429 += rlByEp[ep] || 0;
  }
  const beaconTot = solved + failed, mounted = beaconTot - mountFail;
  const reasonsArr = Object.entries(reasons).map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n);
  return { eps, cf, beaconTot, mounted, mountFail, solved, failed, reasons: reasonsArr, pass, fail, rl, byp, absent, absentBlock, failBlock, block, rl429, tokens: pass + fail + rl };
}
const epsOf = (sys) => allEps.filter(ep => serverOf[ep] === sys);
const combined = collect(allEps);
const perSystemFlows = systemsWithServer.map(sys => ({ sys, m: collect(epsOf(sys)) }));

// ---- verdict + prevention (auth = logon server surface) ----
const logonEps = epsOf('logon');
const v = collect(logonEps);
const vPass = v.pass, vFail = v.fail, vAbsent = v.absent, vRl = v.rl, vByp = v.byp, vBlocked = v.block, vRl429 = v.rl429;
const alarmFiring = alarms.some(a => a.state === 'ALARM');
const flags = [];
if (alarmFiring) flags.push({ sev: 'critical', msg: 'A CloudWatch alarm is in ALARM state.' });
if (vRl >= TH.ratelimitedRed) flags.push({ sev: 'critical', msg: `ratelimited:global softpass fired (${vRl}) — weaponization signal; consider flipping Turnstile.AllowRateLimited off.` });
if (vFail > TH.failRed) flags.push({ sev: 'critical', msg: `organic server fail = ${vFail} (> ${TH.failRed}) on auth forms.` });
if (vAbsent > TH.absentYellow) flags.push({ sev: 'warning', msg: `direct-to-server tokenless (absent) = ${vAbsent} (> ${TH.absentYellow}) — ${enforceActive ? 'the server gate 403s these' : 'the server gate would 403 these under Enforce'}.` });
const verdict = flags.some(f => f.sev === 'critical') ? 'critical' : flags.some(f => f.sev === 'warning') ? 'warning' : 'good';
const verdictText = { good: 'GREEN — soak clean', warning: 'YELLOW — watch items', critical: 'RED — action needed' }[verdict];

const preventClient = logonEps.reduce((a, ep) => a + (beaconByAction[ep] ? beaconByAction[ep].failed || 0 : 0), 0);
const preventClientAll = combined.failed;
const preventServer = vAbsent + vFail;
const allowedHuman = vPass + vRl + vByp;
const preventedTotal = preventClient + preventServer;
const preventRate = (allowedHuman + preventedTotal) ? Math.round(preventedTotal * 100 / (allowedHuman + preventedTotal)) : null;

// cross-surface tokenless (absent) — per system, from server events (bypass = the obvious bot signal)
const absentBySystem = systemsWithServer.map(sys => { const m = collect(epsOf(sys)); return { sys, absent: m.absent, block: m.absentBlock }; }).filter(x => x.absent);
const absentTotal = absentBySystem.reduce((a, x) => a + x.absent, 0);

// per-target-site attribution (§5d): group turnstile events by hostname (+ config / targetState)
const siteAgg = {};
for (const r of siteRows) {
  const host = r.hostname || '(none)';
  const extra = r.config || r.targetState || '';
  const key = host + '' + r.system + '' + extra;
  const a = siteAgg[key] = siteAgg[key] || { host, system: r.system, extra, total: 0, absent: 0, fail: 0, pass: 0 };
  const n = +r.n; a.total += n;
  if (r.outcome === 'absent') a.absent += n; else if (r.outcome === 'fail') a.fail += n; else if (/pass/.test(r.outcome || '')) a.pass += n;
}
const sites = Object.values(siteAgg).sort((a, b) => (b.absent + b.fail) - (a.absent + a.fail) || b.total - a.total).slice(0, 16);

// ---- render helpers ----
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (n) => n == null ? '—' : (+n).toLocaleString('en-US');
const pct = (a, b) => b ? Math.round(a * 100 / b) + '%' : '—';
const days = [...new Set(serverDayRows.map(r => (r.day || '').slice(0, 10)))].sort();
const OUTCOMES = ['pass', 'absent', 'fail', 'pass-ratelimited', 'bypassed-auth'];
const OC = { pass: 'var(--s2)', absent: 'var(--s3)', fail: 'var(--s6)', 'pass-ratelimited': 'var(--s5)', 'bypassed-auth': 'var(--s1)' };
const tile = (l, val, s, sev) => `<div class="tile ${sev || ''}"><div class="tile-val">${val}</div><div class="tile-lbl">${esc(l)}</div>${s ? `<div class="tile-sub">${esc(s)}</div>` : ''}</div>`;

// ===== §5a STAGE FLOW DIAGRAM (inline SVG) =====
// Fixed small topology, hand-rolled: 4 stage nodes L→R, quantified flow-through arrows, one labeled
// exit arrow per drop-off (not-loaded at [2]; each beacon reason at [3]; 403 + 429 at [4]), and the
// tokenless/absent bypass entering DIRECTLY at [4]. Renders identically in browser + PDF (Chromium).
function flowSvg(title, m, note) {
  const W = 980;
  // node geometry — 4 stages L→R, generous inter-node gaps so connector labels never touch a box
  const NODES = [
    { x: 14, w: 138, tier: 'CF issued', sub: 'adaptiveGroups', val: m.cf, accent: '#86b6ef' },
    { x: 244, w: 138, tier: 'widget mounted', sub: 'beacon', val: m.mounted, accent: '#5598e7' },
    { x: 474, w: 138, tier: 'challenge solved', sub: 'token issued', val: m.solved, accent: '#2a78d6' },
    { x: 706, w: 160, tier: 'server receipt', sub: 'turnstile verify', val: m.tokens + m.absent, accent: '#184f95' },
  ];
  const nh = 60, ntop = 30, ncy = ntop + nh / 2, base = ntop + nh;  // base = node bottom edge
  const cx = n => n.x + n.w / 2, rt = n => n.x + n.w;
  const n4 = NODES[3];
  const maxVal = Math.max(1, ...NODES.map(n => n.val));
  // vertical bands below the nodes
  const reasons = m.reasons.slice(0, 5);
  const listTop = base + 26, rowH = 17;
  const bottomOfReasons = reasons.length ? listTop + (reasons.length - 1) * rowH : (m.mountFail ? base + 41 : base + 12);
  const bottomOfServer = base + 16 + 49 + (m.rl429 ? 17 : 0);
  const H = Math.max(184, Math.ceil(Math.max(bottomOfReasons, bottomOfServer, m.mountFail ? base + 41 : 0, m.absent ? base + 122 : 0)) + 14);
  let s = `<svg viewBox="0 0 ${W} ${H}" class="flow-svg" role="img" aria-label="${esc(title)} stage flow" preserveAspectRatio="xMidYMid meet">`;
  s += `<defs><marker id="ah" markerWidth="9" markerHeight="9" refX="6.5" refY="3.2" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L7,3.2 L0,6.4 Z" fill="context-stroke"/></marker></defs>`;
  // stage-connector arrows (flow-through) — short labels centered in the wide gap
  const conn = (a, b, count, pctStr) => {
    const x1 = rt(a) + 3, x2 = b.x - 5, y = ncy, mid = (x1 + x2) / 2;
    s += `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="var(--ink2)" stroke-width="2" marker-end="url(#ah)"/>`;
    s += `<text x="${mid}" y="${y - 7}" text-anchor="middle" class="fl-flow">${esc(count)}</text>`;
    if (pctStr) s += `<text x="${mid}" y="${y + 14}" text-anchor="middle" class="fl-note">${esc(pctStr)}</text>`;
  };
  conn(NODES[0], NODES[1], fmt(m.beaconTot), m.cf ? pct(m.beaconTot, m.cf) + ' issued' : '');
  conn(NODES[1], NODES[2], fmt(m.solved), 'solved');
  conn(NODES[2], NODES[3], fmt(m.solved), '→token');
  // nodes
  for (const n of NODES) {
    const bw = Math.max(6, Math.round((n.w - 24) * Math.sqrt(n.val) / Math.sqrt(maxVal)));
    s += `<rect x="${n.x}" y="${ntop}" width="${n.w}" height="${nh}" rx="9" fill="var(--surface)" stroke="var(--ring)"/>`;
    s += `<rect x="${n.x + 9}" y="${ntop + 1}" width="${n.w - 18}" height="3" rx="1.5" fill="${n.accent}"/>`;
    s += `<text x="${cx(n)}" y="${ntop - 8}" text-anchor="middle" class="fl-tier">${esc(n.tier)}</text>`;
    s += `<text x="${cx(n)}" y="${ntop + 31}" text-anchor="middle" class="fl-val">${fmt(n.val)}</text>`;
    s += `<text x="${cx(n)}" y="${ntop + 48}" text-anchor="middle" class="fl-sub">${esc(n.sub)}</text>`;
    s += `<rect x="${cx(n) - bw / 2}" y="${ntop + nh - 8}" width="${bw}" height="3" rx="1.5" fill="${n.accent}" opacity="0.6"/>`;
  }
  // [2] not-loaded (mount-fail) exit — orthogonal elbow: straight down the box's left edge, then a
  // right-angle turn pointing right at the cause label.
  if (m.mountFail) {
    const trunkX = NODES[1].x + 6, armX = trunkX + 16, ay = base + 22;
    s += `<line x1="${trunkX}" y1="${base}" x2="${trunkX}" y2="${ay}" stroke="var(--warning)" stroke-width="2"/>`;
    s += `<line x1="${trunkX}" y1="${ay}" x2="${armX}" y2="${ay}" stroke="var(--warning)" stroke-width="2" marker-end="url(#ah)"/>`;
    s += `<text x="${armX + 6}" y="${ay + 4}" text-anchor="start" class="fl-drop">not-loaded <tspan class="fl-n">${fmt(m.mountFail)}</tspan> <tspan class="fl-note">· mount fail</tspan></text>`;
  }
  // [3] challenge fail reasons — orthogonal "comb": one trunk straight down the box's left edge, with a
  // right-angle branch peeling off to point right at each cause label.
  if (reasons.length) {
    const trunkX = NODES[2].x + 6, armX = trunkX + 16;
    s += `<text x="${armX}" y="${base + 12}" class="fl-caption">challenge exits</text>`;
    const arms = reasons.map((r, i) => ({ r, ay: listTop + i * rowH - 4 }));
    const lastY = arms[arms.length - 1].ay;
    s += `<line x1="${trunkX}" y1="${base}" x2="${trunkX}" y2="${lastY}" stroke="var(--s6)" stroke-width="1.4" opacity="0.6"/>`;
    arms.forEach(({ r, ay }) => {
      s += `<line x1="${trunkX}" y1="${ay}" x2="${armX}" y2="${ay}" stroke="var(--s6)" stroke-width="1.4" opacity="0.6" marker-end="url(#ah)"/>`;
      s += `<text x="${armX + 6}" y="${ay + 4}" class="fl-reason"><tspan fill="var(--s6)">◆</tspan> ${esc(r.reason)} <tspan class="fl-n">${fmt(r.n)}</tspan></text>`;
    });
  }
  // [4] server outcome split + exits (403 block, 429 rate-limit), stacked under node 4
  const splitY = base + 16, sx = n4.x, sw = n4.w;
  const segs = [{ n: m.pass, c: 'var(--s2)', t: 'pass' }, { n: m.rl, c: 'var(--s5)', t: 'pass-rl' }, { n: m.byp, c: 'var(--s1)', t: 'bypassed' }, { n: m.fail, c: 'var(--s6)', t: 'fail' }].filter(x => x.n);
  const stot = segs.reduce((a, x) => a + x.n, 0) || 1;
  s += `<text x="${sx}" y="${splitY - 1}" class="fl-caption">verify outcomes</text>`;
  let ox = sx;
  for (const g of segs) { const gw = Math.max(3, sw * g.n / stot); s += `<rect x="${ox}" y="${splitY + 4}" width="${Math.max(2, gw - 2)}" height="9" rx="2" fill="${g.c}"><title>${g.t}: ${g.n}</title></rect>`; ox += gw; }
  s += `<text x="${sx}" y="${splitY + 32}" class="fl-outk"><tspan fill="var(--s2)">●</tspan> allowed <tspan class="fl-n">${fmt(m.pass + m.rl + m.byp)}</tspan></text>`;
  const ex403 = m.block ? `<tspan fill="var(--critical)">■</tspan> 403'd <tspan class="fl-n">${fmt(m.block)}</tspan>` : `<tspan fill="var(--muted)">■</tspan> 403'd <tspan class="fl-n">0</tspan>`;
  s += `<text x="${sx}" y="${splitY + 49}" class="fl-outk">${ex403}</text>`;
  if (m.rl429) s += `<text x="${sx}" y="${splitY + 66}" class="fl-outk"><tspan fill="var(--critical)">▼</tspan> 429 rate-limit <tspan class="fl-n">${fmt(m.rl429)}</tspan></text>`;
  // [4] tokenless / absent bypass — a DISTINCT dashed inbound arrow entering node 4 from below (far
  // right, clear of the left-aligned outcome stack) — bots that skip [1]-[3] and POST straight to the server
  if (m.absent) {
    const ax = n4.x + n4.w - 24, py = base + 102, pw = 116;
    s += `<line x1="${ax}" y1="${py - 16}" x2="${ax}" y2="${base + 2}" stroke="var(--critical)" stroke-width="2" stroke-dasharray="4 2" marker-end="url(#ah)"/>`;
    s += `<rect x="${ax - pw / 2}" y="${py - 15}" width="${pw}" height="21" rx="10.5" fill="none" stroke="var(--critical)" stroke-dasharray="3 2"/>`;
    s += `<text x="${ax}" y="${py - 1}" text-anchor="middle" class="fl-bypass"><tspan fill="var(--critical)">⇧</tspan> absent <tspan class="fl-n">${fmt(m.absent)}</tspan></text>`;
    s += `<text x="${ax}" y="${py + 16}" text-anchor="middle" class="fl-note">tokenless — skips [1]–[3]${m.absentBlock ? ' · ' + fmt(m.absentBlock) + " 403'd" : ''}</text>`;
  }
  if (note) s += `<text x="${W - 6}" y="14" text-anchor="end" class="fl-note">${esc(note)}</text>`;
  s += `</svg>`;
  return s;
}

function flowSection() {
  const one = systemsWithServer.length <= 1;
  const modeTag = (enfN && obsN) ? `${Math.round(enfN * 100 / modeTot)}% Enforce` : modeWord;
  let body = '';
  if (!allEps.length) {
    body = `<div class="card"><p class="muted">No Turnstile events in the window across any source group.</p></div>`;
  } else if (one) {
    const sys = systemsWithServer[0] || 'logon';
    body = `<div class="card flow-card"><div class="flow-title">${esc(sys)} <span class="muted">— all active app surfaces (${esc(allEps.length)} forms)</span></div>${flowSvg(sys, combined, modeTag)}</div>`;
  } else {
    body = `<div class="card flow-card"><div class="flow-title">combined <span class="muted">— all surfaces</span></div>${flowSvg('combined', combined, modeTag)}</div>`;
    for (const f of perSystemFlows) body += `<div class="card flow-card"><div class="flow-title">${esc(f.sys)} <span class="muted">(${esc(f.m.eps.length)} forms · layer ${layerOf(f.sys)})</span></div>${flowSvg(f.sys, f.m)}</div>`;
  }
  // awaiting-data strips for configured systems with no server telemetry yet
  const awaiting = SYSTEMS_CONFIGURED.filter(s => !systemsWithServer.includes(s));
  if (awaiting.length) {
    body += `<div class="await-wrap">` + awaiting.map(sys => {
      const srcs = SOURCES.filter(x => x.system === sys);
      const missing = srcs.filter(x => !x.exists).map(x => x.group);
      const beaconOnly = allEps.filter(ep => !serverOf[ep] && (beaconByAction[ep] || reasonByAction[ep]));
      const bnote = (sys === 'estimator' || sys === 'twproxy') && beaconOnly.length ? ` · client-gate already visible via Logon beacon for ${beaconOnly.filter(ep => (sys === 'twproxy' ? ep === 'feedback' : ep === 'share' || ep === 'pdfshare')).join(', ') || 'shared forms'}` : '';
      const idle = srcs.map(x => idleGroups.find(i => i.group === x.group)).filter(i => i && i.lastMs);
      const quiet = idle.length ? ` (group live, no events in window -- last event ${esc(iso(idle[0].lastMs).slice(0, 16).replace('T', ' '))}Z, ${esc(agoWords(idle[0].lastMs))})` : ' (group present, no events in window)';
      return `<div class="await"><b>${esc(sys)}</b> -- ${missing.length ? `awaiting server telemetry (${esc(missing.join(', '))} not yet deployed)` : `no server verifies in window${quiet}`}${bnote}</div>`;
    }).join('') + `</div>`;
  }
  return body;
}

// ===== §5b lifecycle (data-driven; no hardcoded n/a) =====
function lifecycleRow(ep) {
  const b = beaconByAction[ep] || { solved: 0, failed: 0 };
  const bTot = (b.solved || 0) + (b.failed || 0);
  const sys = serverOf[ep];
  const cf = cfByEp[ep] || 0;
  const cfPct = (cf && bTot) ? (bTot * 100 / cf).toFixed(1) + '%' : '';
  const clientBar = bTot
    ? `<div class="sbar">${[{ n: b.solved, color: 'var(--s2)' }, { n: b.failed, color: 'var(--s6)' }].filter(x => x.n).map(x => `<div style="flex:${x.n};background:${x.color}"></div>`).join('') || '<div class="empty"></div>'}</div>`
    : `<div class="sbar"><div class="empty"></div></div>`;
  let serverCell;
  if (sys) {
    const s = serverByKey[sys + '|' + ep] || {};
    const g = oc => s[oc] || { a: 0, b: 0 };
    const tokens = g('pass').a + g('pass').b + g('fail').a + g('fail').b + g('pass-ratelimited').a + g('pass-ratelimited').b;
    const absent = g('absent').a + g('absent').b, block = Object.keys(s).reduce((a, oc) => a + s[oc].b, 0);
    const parts = [];
    for (const k of ['pass', 'pass-ratelimited', 'bypassed-auth']) { const t = g(k).a + g(k).b; if (t || k === 'pass') parts.push(`<span class="o ok" title="allowed"><b>●</b>${esc(k)} <em>${t}</em></span>`); }
    for (const k of ['fail', 'absent']) { const x = g(k); if (x.b) parts.push(`<span class="o blk" title="403'd"><b>■</b>${esc(k)} <em>${x.b}</em> 403'd</span>`); if (x.a) parts.push(`<span class="o enf" title="${enforceActive ? 'allowed this event' : 'allow now · 403 under Enforce'}${k === 'absent' ? ' · tokenless' : ''}"><b>◑</b>${esc(k)} <em>${x.a}</em></span>`); }
    const bar = [{ n: g('pass').a + g('pass').b, color: 'var(--s2)' }, { n: g('pass-ratelimited').a + g('pass-ratelimited').b, color: 'var(--s5)' }, { n: g('bypassed-auth').a + g('bypassed-auth').b, color: 'var(--s1)' }, { n: g('fail').a + g('fail').b, color: 'var(--s6)' }, { n: absent, color: 'var(--s3)' }].filter(x => x.n);
    serverCell = `<div class="lc-v">${fmt(tokens)}</div><div class="lc-s">tokens${absent ? ` · +${absent} tokenless` : ''}${block ? ` · <b style="color:var(--critical)">${block} 403'd</b>` : ''}</div>
      <div class="sbar">${bar.map(x => `<div style="flex:${x.n};background:${x.color}"></div>`).join('') || '<div class="empty"></div>'}</div>
      <div class="lc-out">${parts.join('')}</div>`;
  } else {
    // No server events for this endpoint IN WINDOW. That is NOT evidence the emitter is missing:
    // `serverOf` is discovered from in-window rows, so a live-but-unused surface lands here too.
    // Distinguish the two off `SOURCES[].exists` (same test flowSection uses) -- never claim
    // "not deployed" when every producer group is present and merely quiet.
    serverCell = `<div class="lc-v await-v">${silentServerVal}</div><div class="lc-s">${silentServerNote()}</div>`;
  }
  const badge = sys ? (sys === 'logon' ? '' : `<span class="tag">${esc(sys)}</span>`)
    : `<span class="tag await-tag">${missingGroups.length ? 'pending' : 'quiet'}</span>`;
  return `<div class="lc">
    <div class="lc-form">${esc(ep)}${badge}</div>
    <div class="lc-stage"><div class="lc-k">Cloudflare</div><div class="lc-v">${fmt(cf)}</div><div class="lc-s">issued</div><div class="sbar"><div style="flex:1;background:var(--s1)"></div></div></div>
    <div class="lc-arr">${cfPct}<span>&rarr;</span></div>
    <div class="lc-stage"><div class="lc-k">Client gate <i>widget</i></div><div class="lc-v">${fmt(bTot)}</div><div class="lc-s">${bTot ? Math.round((b.solved || 0) * 100 / bTot) + '% solved' : 'no beacons'}</div>
      ${clientBar}
      <div class="lc-out"><span class="o ok" title="solved → token → server"><b>✓</b>${b.solved || 0} →server</span><span class="o blk" title="failed → no token → blocked at client"><b>✗</b>${b.failed || 0} blocked</span></div></div>
    <div class="lc-arr"><span>&rarr;</span></div>
    <div class="lc-stage"><div class="lc-k">Server gate <i>${esc(sys || '…')}</i></div>${serverCell}</div>
  </div>`;
}

function trend() {
  if (!days.length) return '<p class="muted">No server-verify events in window.</p>';
  const per = days.map(d => { const o = {}; for (const r of serverDayRows.filter(x => (x.day || '').slice(0, 10) === d)) o[r.outcome] = +r.n; return { d, o, tot: OUTCOMES.reduce((a, oc) => a + (o[oc] || 0), 0) }; });
  return `<div class="days">${per.map(p => `<div class="day-col" title="${p.d}: ${p.tot}"><div class="day-stack" style="height:92px">
    ${OUTCOMES.filter(oc => p.o[oc]).map(oc => `<div style="flex:${p.o[oc]};background:${OC[oc]}" title="${oc}: ${p.o[oc]}"></div>`).join('') || '<div class="empty" style="flex:1"></div>'}
    </div><div class="day-lbl">${p.d.slice(5)}</div></div>`).join('')}</div>
    <div class="legend">${OUTCOMES.map(oc => `<span class="lg"><i style="background:${OC[oc]}"></i>${oc}</span>`).join('')}</div>`;
}

function prevBar() {
  const segs = [{ n: allowedHuman, color: 'var(--s2)', label: 'human verified' }, { n: preventClient, color: 'var(--s6)', label: 'client-gate blocked' }, { n: preventServer, color: 'var(--s3)', label: 'server-gate (tokenless/invalid)' }];
  return `<div class="pbar">${segs.some(s => s.n) ? segs.filter(s => s.n).map(s => `<div style="flex:${s.n};background:${s.color}" title="${esc(s.label)}: ${s.n}"></div>`).join('') : '<div class="empty" style="flex:1"></div>'}</div>
    <div class="legend">${segs.map(s => `<span class="lg"><i style="background:${s.color}"></i>${esc(s.label)} <b>${s.n}</b></span>`).join('')}</div>`;
}

// §5c tokenless panel
function tokenlessSection() {
  return `<h2>Tokenless / direct-to-server <span class="muted">(the bot bypass — <code>outcome=absent</code>, all surfaces)</span></h2>
  <p class="sub">POSTs that carry no Turnstile token skip the widget entirely and hit the server gate directly — the clearest non-human signal. Under ${esc(modeWord)} these ${enforceActive ? "are 403'd" : 'are allowed+recorded today (403 under Enforce)'}.</p>
  <div class="card"><div class="tiles">
    ${tile('tokenless total', fmt(absentTotal), 'outcome=absent, organic', absentTotal > TH.absentYellow ? 'warning' : absentTotal ? '' : 'good')}
    ${absentBySystem.length ? absentBySystem.map(x => tile(esc(x.sys), fmt(x.absent), x.block ? `${x.block} already 403'd` : 'recorded', x.block ? 'warning' : '')).join('') : tile('per-system', '0', 'none in window', 'good')}
  </div>
  <p class="muted" style="margin-top:8px">Per-system totals populate as each surface's events group deploys (twproxy/estimator/pdfreport). Today only the Logon server plane is live, so its absent count is the whole cross-surface total.</p>
  </div>`;
}

// §5d per-target-site attack breakdown
function siteSection() {
  if (!sites.length) return `<h2>Per-target-site attack breakdown</h2><div class="card"><p class="muted">No per-hostname server events in the window.</p></div>`;
  const max = Math.max(1, ...sites.map(s => s.total));
  return `<h2>Per-target-site attack breakdown <span class="muted">(who is being attacked — by CF-signed hostname)</span></h2>
  <div class="card"><table><thead><tr><th>target site</th><th>surface</th><th class="n">verifies</th><th class="n">tokenless</th><th class="n">fail</th><th style="width:34%">volume</th></tr></thead><tbody>
  ${sites.map(s => `<tr>
    <td>${esc(s.host)}${s.extra ? ` <span class="pill">${esc(s.extra)}</span>` : ''}</td>
    <td>${esc(s.system)}</td>
    <td class="n">${fmt(s.total)}</td>
    <td class="n">${s.absent ? `<b style="color:var(--warning)">${fmt(s.absent)}</b>` : '·'}</td>
    <td class="n">${s.fail ? `<b style="color:var(--critical)">${fmt(s.fail)}</b>` : '·'}</td>
    <td><div class="hbar"><div style="width:${Math.max(2, Math.round(s.total / max * 100))}%;background:var(--s1)"></div></div></td>
  </tr>`).join('')}
  </tbody></table>
  <p class="muted" style="margin-top:8px">Attribution: Logon = CF-signed siteverify hostname; twproxy adds <code>config</code>, estimator adds <code>targetState</code> (shown as a pill) once those groups deploy.</p>
  </div>`;
}

// --accounts (opt-in): ground-truth account creation from logon2.AspNetUsers via SSM/DB
function accountsSection() {
  if (!ACCOUNTS) return '';
  const INST = 'i-0997a73b08f6e5862';
  const ps = [
    "$j=(Get-SECSecretValue -SecretId 'efw/logon/db-production' -Region us-west-1).SecretString|ConvertFrom-Json",
    '$cs="Server=$($j.host),$($j.port);Database=$($j.database);User Id=$($j.username);Password=$($j.password);TrustServerCertificate=true;Connect Timeout=20"',
    '$cn=New-Object System.Data.SqlClient.SqlConnection $cs;$cn.Open()',
    'function Q($sql){$c=$cn.CreateCommand();$c.CommandTimeout=90;$c.CommandText=$sql;$r=$c.ExecuteReader();while($r.Read()){$o=@();for($i=0;$i -lt $r.FieldCount;$i++){$o+="$($r.GetValue($i))"};($o -join [char]9)};$r.Close()}',
    "$dot=\"(LEN(LEFT(Email,CHARINDEX('@',Email)-1))-LEN(REPLACE(LEFT(Email,CHARINDEX('@',Email)-1),'.','')))>=3\"",
    "$susp=\"(Email LIKE '%.ru' OR Email LIKE '%.xyz' OR Email LIKE '%.top' OR Email LIKE '%.click' OR Email LIKE '%.icu' OR Email LIKE '%.buzz')\"",
    '"DAILY"',
    'Q "SELECT CONVERT(varchar(10),Created,120),COUNT(*),SUM(CAST(EmailConfirmed AS int)) FROM AspNetUsers WHERE Created>=DATEADD(day,-30,GETUTCDATE()) GROUP BY CONVERT(varchar(10),Created,120) ORDER BY 1"',
    '"SUMMARY"',
    "Q \"SELECT COUNT(*),SUM(CAST(EmailConfirmed AS int)),SUM(CASE WHEN Email LIKE '%@gmail.com' AND $dot THEN 1 ELSE 0 END),SUM(CASE WHEN $susp THEN 1 ELSE 0 END) FROM AspNetUsers WHERE Created>=DATEADD(day,-30,GETUTCDATE())\"",
    '$cn.Close()',
  ].join("\n");
  let out = '';
  try {
    const tmp = require('os').tmpdir() + '/soak-acct-' + process.pid + '.json';
    fs.writeFileSync(tmp, JSON.stringify({ commands: [ps] }));
    const cid = execFileSync('aws', ['ssm', 'send-command', '--region', REGION, '--instance-ids', INST, '--document-name', 'AWS-RunPowerShellScript', '--parameters', 'file://' + tmp, '--query', 'Command.CommandId', '--output', 'text'], { encoding: 'utf8' }).trim();
    for (let i = 0; i < 30; i++) {
      const inv = aws(['ssm', 'get-command-invocation', '--command-id', cid, '--instance-id', INST]);
      if (inv.Status === 'Success') { out = inv.StandardOutputContent || ''; break; }
      if (inv.Status === 'Failed' || inv.Status === 'Cancelled') throw new Error('SSM ' + inv.Status + ': ' + (inv.StandardErrorContent || '').slice(0, 100));
      sleep(3000);
    }
    fs.unlinkSync(tmp);
  } catch (e) { warn.push('accounts: ' + e.message); return `<h2>Account creation</h2><div class="card"><p class="muted">unavailable: ${esc(e.message)}</p></div>`; }

  let mode = '', daily = [], sum = null;
  for (const ln of out.split(/\r?\n/)) {
    const t = ln.trim();
    if (t === 'DAILY') { mode = 'd'; continue; } if (t === 'SUMMARY') { mode = 's'; continue; }
    const p = ln.split('\t');
    if (mode === 'd' && /^\d{4}-\d\d-\d\d/.test(p[0])) daily.push({ day: p[0], n: +p[1], conf: +p[2] });
    if (mode === 's' && /^\d/.test(p[0] || '')) sum = { total: +p[0], conf: +p[1], dottrick: +p[2], susptld: +p[3] };
  }
  const mean = daily.length ? Math.round(daily.reduce((a, d) => a + d.n, 0) / daily.length) : 0;
  const max = Math.max(1, ...daily.map(d => d.n));
  const bars = daily.map(d => `<div class="day-col" title="${d.day}: ${d.n} created, ${d.conf} confirmed"><div class="day-stack" style="height:${Math.round(d.n / max * 78) + 4}px"><div style="flex:1;background:var(--s1)"></div></div><div class="day-lbl">${d.day.slice(5)}</div></div>`).join('');
  return `<h2>Account creation <span class="muted">(logon2.AspNetUsers · 30d · ground truth via SSM/DB)</span></h2>
    <div class="card">
      <div class="tiles">
        ${tile('mean / day', fmt(mean), '30-day')}
        ${sum ? tile('total (30d)', fmt(sum.total), (sum.total ? Math.round(sum.conf * 100 / sum.total) : 0) + '% confirmed') : ''}
        ${sum ? tile('dot-trick gmail', fmt(sum.dottrick), 'bot signature (30d)', sum.dottrick > 5 ? 'warning' : 'good') : ''}
        ${sum ? tile('suspicious TLD', fmt(sum.susptld), '.ru/.xyz/… (30d)', sum.susptld > 3 ? 'warning' : 'good') : ''}
      </div>
      <div class="days">${bars || '<span class="muted">no rows</span>'}</div>
      <p class="muted" style="margin-top:8px">Ground truth: actual accounts created (not a gate metric). Garbage indicators should stay near-zero post-Turnstile. Needs SSM/DB (opt-in <code>--accounts</code>).</p>
    </div>`;
}

function twproxySection() {
  if (!twTotal && !twExitTotal) return `<h2>Feedback proxy — pre-gate <span class="muted">(twproxy plain-text)</span></h2><div class="card"><p class="muted">No twproxy events in <code>${esc(TWGROUP)}</code> for the retained window.</p></div>`;
  const funnel = [
    { n: twReached, color: 'var(--s2)', label: 'reached siteverify' },
    { n: twRobot, color: 'var(--s6)', label: 'Turnstile-blocked (robot)' },
    { n: Math.max(0, twHostile - twRobot), color: 'var(--s3)', label: 'rejected pre-gate (method/tags/payload)' },
  ];
  const modeCls = twModeLive === 'Observe' ? 'warning' : twModeLive === 'Require' ? 'good' : '';
  return `<h2>Feedback proxy — pre-gate detail <span class="muted">(twproxy · ${esc(ENV === 'prod' ? 'web-06 public' : 'web-04 preview2')} · retained ${TW_HOURS / 24}d plain-text)</span></h2>
  <p class="sub">The pre-gate attack detail that exits <b>before</b> the verify point (method/tag/payload/SQLi) -- not visible to the structured funnel above. The verify-decision (pass/absent/fail) already rides the unified funnel via <code>/twproxy/events</code>; this panel remains the source for pre-gate floods.<br>
  <b>Different window:</b> every number below covers the full retained <b>${TW_HOURS / 24} days</b> (the plain-text file is month-accumulating and bulk re-shipped on rotation), <i>not</i> the ${esc(HOURS)}h window used by the funnel and lifecycle sections above. Do not compare the two directly.</p>
  <div class="card">
    <div class="tiles">
      ${tile('total requests', fmt(twTotal), `retained ${TW_HOURS / 24}d, not ${HOURS}h`, twHostilePct >= 80 ? 'critical' : twHostilePct >= 50 ? 'warning' : '')}
      ${tile('hostile / non-legit', twHostilePct != null ? twHostilePct + '%' : '—', `${fmt(twHostile)} never reached siteverify`, twHostilePct >= 80 ? 'critical' : 'warning')}
      ${tile('Turnstile robot-blocks', fmt(twRobot), twRobot ? 'gate denied (Require mode)' : 'none in window', twRobot ? 'good' : '')}
      ${tile('SQLi probes', fmt(twSqliTotal), twSqliTotal ? 'in validationType field' : 'none', twSqliTotal ? 'critical' : 'good')}
      ${tile('reached siteverify', fmt(twReached), `${fmt(twPass)} passed`, 'good')}
      ${tile('live mode (inferred)', twModeLive, twModeLive === 'unknown' ? 'no signal in window' : `newest signal: ${tRequireSig >= tObsTrue ? 'robot-block/observe=False' : 'observe=True'}`, modeCls)}
    </div>
    <div class="pbar">${funnel.some(s => s.n) ? funnel.filter(s => s.n).map(s => `<div style="flex:${s.n};background:${s.color}" title="${esc(s.label)}: ${s.n}"></div>`).join('') : '<div class="empty" style="flex:1"></div>'}</div>
    <div class="legend">${funnel.map(s => `<span class="lg"><i style="background:${s.color}"></i>${esc(s.label)} <b>${fmt(s.n)}</b></span>`).join('')}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:16px">
      <div><div class="lc-k" style="margin-bottom:5px">Exit reasons</div><table><tbody>
        ${twExits.length ? twExits.map(e => `<tr><td>${esc(e.ex)}</td><td class="n">${fmt(e.n)}</td></tr>`).join('') : '<tr><td class="muted">none</td></tr>'}
      </tbody></table></div>
      <div><div class="lc-k" style="margin-bottom:5px">SQL-injection probes <span class="muted">(validationType)</span></div><table><tbody>
        ${twSqli.length ? twSqli.map(r => `<tr><td><code>${esc(r.vt.slice(0, 48))}</code></td><td class="n">${fmt(r.n)}</td></tr>`).join('') : '<tr><td class="muted">none detected</td></tr>'}
      </tbody></table></div>
    </div>
    <p class="muted" style="margin-top:12px">${twModeLive === 'Observe' ? '<b style="color:var(--warning)">Live mode reads Observe</b> — Turnstile-only bot failures are NOT blocked here today.' : twModeLive === 'Require' ? '<b style="color:var(--good)">Live mode reads Require</b> — the gate is actively denying bots.' : 'Mode not inferable from this window.'} Window is the twproxy group\'s full retention (bulk re-shipped on the rotation deploy), not the ${HOURS}h event window.</p>
  </div>`;
}

// ---- assemble ----
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Turnstile soak — ${esc(CFG.label)}</title><style>
:root{--surface:#fcfcfb;--plane:#f9f9f7;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--grid:#e1e0d9;--ring:rgba(11,11,11,.12);
--s1:#2a78d6;--s2:#1baf7a;--s3:#eda100;--s5:#4a3aa7;--s6:#e34948;--good:#0ca30c;--warning:#e08600;--critical:#d03b3b;}
@media(prefers-color-scheme:dark){:root{--surface:#1a1a19;--plane:#0d0d0d;--ink:#fff;--ink2:#c3c2b7;--muted:#898781;--grid:#2c2c2a;--ring:rgba(255,255,255,.14);
--s1:#3987e5;--s2:#199e70;--s3:#c98500;--s5:#9085e9;--s6:#e66767;--good:#0ca30c;--warning:#fab219;}}
*{box-sizing:border-box}body{margin:0;background:var(--plane);color:var(--ink);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:1040px;margin:0 auto;padding:28px 20px 60px}h1{font-size:1.5em;margin:0 0 2px}
h2{font-size:1.05em;margin:30px 0 4px}.sub{color:var(--muted);font-size:.82em;margin:0 0 12px}
.meta{color:var(--ink2);font-size:.85em;margin-bottom:20px}.muted{color:var(--muted)}code{font-size:.92em}
.banner{border-radius:10px;padding:15px 20px;display:flex;align-items:center;gap:14px;font-weight:600;color:#fff}
.banner.good{background:var(--good)}.banner.warning{background:var(--warning);color:#fff}.banner.critical{background:var(--critical)}.banner .dot{font-size:1.4em}
.card{background:var(--surface);border:1px solid var(--ring);border-radius:10px;padding:16px 18px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:16px 0}
.tile{background:var(--surface);border:1px solid var(--ring);border-radius:10px;padding:13px 15px}
.tile-val{font-size:1.8em;font-weight:650;letter-spacing:-.02em}.tile-lbl{color:var(--ink2);font-size:.82em;margin-top:2px}.tile-sub{color:var(--muted);font-size:.74em;margin-top:4px}
.tile.good .tile-val{color:var(--good)}.tile.warning .tile-val{color:var(--warning)}.tile.critical .tile-val{color:var(--critical)}
.o{display:inline-flex;align-items:center;gap:3px;color:var(--ink2);white-space:nowrap}.o b{font-size:1.1em;line-height:1}.o em{font-style:normal;font-weight:650;color:var(--ink)}
.o.ok b{color:var(--good)}.o.enf b{color:var(--warning)}.o.blk b{color:var(--critical)}
/* flow diagram */
.flow-card{padding:10px 14px 14px}.flow-title{font-weight:600;font-size:.92em;margin:4px 2px 2px}
.flow-svg{width:100%;height:auto;display:block}
.fl-tier{fill:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.03em}
.fl-val{fill:var(--ink);font-size:21px;font-weight:650}
.fl-sub{fill:var(--muted);font-size:10px}
.fl-flow{fill:var(--ink2);font-size:11px;font-weight:600}
.fl-caption{fill:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.03em}
.fl-drop,.fl-reason,.fl-bypass,.fl-outk{fill:var(--ink2);font-size:11px}
.fl-n{fill:var(--ink);font-weight:650}
.fl-note{fill:var(--muted);font-size:10px}
.await-wrap{margin-top:10px;display:flex;flex-direction:column;gap:6px}
.await{background:var(--surface);border:1px dashed var(--ring);border-radius:8px;padding:8px 12px;font-size:.82em;color:var(--ink2)}
.await-v{color:var(--muted);font-weight:500;font-style:italic}.await-tag{background:transparent;border:1px dashed var(--muted);color:var(--muted)}
.lc{display:grid;grid-template-columns:96px 1fr 44px 1.1fr 26px 1.55fr;gap:9px;align-items:start;padding:14px 2px;border-top:1px solid var(--grid)}
.lc-form{font-weight:600;font-size:.92em;padding-top:14px;display:flex;flex-direction:column;gap:3px}.tag{display:inline-block;background:var(--grid);border-radius:20px;padding:0 6px;font-size:.68em;color:var(--ink2);font-weight:500;width:fit-content}
.lc-k{font-size:.66em;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:1px}.lc-k i{font-style:normal;text-transform:none;letter-spacing:0;background:var(--grid);border-radius:20px;padding:0 6px;color:var(--ink2);font-size:1.05em}
.lc-v{font-size:1.25em;font-weight:650;font-variant-numeric:tabular-nums;line-height:1.1}
.lc-s{font-size:.7em;color:var(--muted)}
.lc-arr{text-align:center;color:var(--muted);font-size:.66em;font-variant-numeric:tabular-nums;padding-top:16px}.lc-arr span{display:block;font-size:1.2em;color:var(--grid)}
.lc-out{display:flex;flex-wrap:wrap;gap:3px 9px;margin-top:6px;font-size:.72em;font-variant-numeric:tabular-nums}
.sbar{height:8px;border-radius:3px;overflow:hidden;display:flex;gap:1.5px;margin-top:5px;background:var(--grid)}.sbar>div{min-width:2px}
.pbar{height:22px;border-radius:5px;overflow:hidden;display:flex;gap:2px;background:var(--grid);margin-top:4px}.pbar>div{min-width:3px}
.hbar{height:11px;border-radius:3px;overflow:hidden;background:var(--grid)}.hbar>div{height:100%}
.empty{background:var(--grid);opacity:.4;flex:1}
.days{display:flex;gap:7px;align-items:flex-end;padding:6px 0}.day-col{flex:1;display:flex;flex-direction:column;align-items:center;min-width:24px}
.day-stack{width:100%;max-width:42px;display:flex;flex-direction:column-reverse;border-radius:4px 4px 0 0;overflow:hidden;gap:2px}
.day-lbl{font-size:.7em;color:var(--muted);margin-top:5px;font-variant-numeric:tabular-nums}
.legend{display:flex;gap:14px;flex-wrap:wrap;margin-top:8px;font-size:.76em;color:var(--ink2)}.lg{display:flex;gap:5px;align-items:center}.lg i{width:10px;height:10px;border-radius:3px}
.flags{list-style:none;padding:0;margin:12px 0}.flags li{padding:8px 12px;border-radius:8px;margin-bottom:6px;border:1px solid var(--ring)}
.flags .critical{border-left:3px solid var(--critical)}.flags .warning{border-left:3px solid var(--warning)}
table{width:100%;border-collapse:collapse;font-size:.82em;margin-top:8px}th,td{text-align:left;padding:5px 9px;border-bottom:1px solid var(--grid)}th{color:var(--muted);font-weight:600}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
.foot{color:var(--muted);font-size:.77em;margin-top:32px;border-top:1px solid var(--grid);padding-top:13px}
.pill{display:inline-block;background:var(--grid);border-radius:20px;padding:1px 9px;color:var(--ink2);font-size:.9em}
/* PDF/print: A3-portrait is ~1123px wide (fits the 1040px report at full width); keep cards/rows
   whole across page breaks and preserve the colored fills. Chromium headless renders light by default. */
@media print{body{background:#fff}.wrap{max-width:none;padding:10px 16px}
.card,.flow-card,.lc,.tile,.await,.flow-svg,table{break-inside:avoid}h1,h2{break-after:avoid}
body,.banner,.tile,.card{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style></head><body><div class="wrap">
<h1>Turnstile soak report</h1>
<div class="meta"><span class="pill">${esc(CFG.label)}</span> &middot; <span class="pill">${esc(modeWord)} mode</span> &middot; last ${HOURS}h &middot; ${esc(iso(startMs))} → ${esc(iso(now))}<br>
Unified per-system Insights (${SOURCES.map(s => `<code>${esc(s.group)}</code>${s.exists ? '' : ' <span class="muted">(pending)</span>'}`).join(' · ')}) + CF GraphQL issuance + <code>twproxy-logs</code> pre-gate + CloudWatch alarms &middot; organic (ua~curl excluded)</div>
<div class="banner ${verdict}"><span class="dot">${verdict === 'good' ? '●' : verdict === 'warning' ? '▲' : '■'}</span><span>${esc(verdictText)}</span></div>

<div class="tiles">
${tile('server pass', fmt(vPass), 'register+forgot, organic', 'good')}
${tile('server fail', fmt(vFail), 'invalid token', vFail > TH.failRed ? 'critical' : vFail ? 'warning' : 'good')}
${tile('tokenless (absent)', fmt(absentTotal), enforceActive ? '403 under Enforce' : 'absent → 403 under Enforce', absentTotal > TH.absentYellow ? 'warning' : '')}
${tile('server 403s served', fmt(vBlocked), vBlocked ? 'actual blocks (allowed=false)' : (enforceActive ? 'none in window' : 'Observe: recorded, not blocked'), vBlocked ? 'warning' : 'good')}
${tile('429 rate-limit', fmt(vRl429), 'Logon per-IP throttle', vRl429 ? 'warning' : 'good')}
${tile('ratelimited softpass', fmt(vRl), 'allowed through', vRl >= TH.ratelimitedRed ? 'critical' : 'good')}
${tile('beacon solve-rate', combined.beaconTot ? Math.round(combined.solved * 100 / combined.beaconTot) + '%' : '—', `${fmt(combined.solved)}/${fmt(combined.beaconTot)} all forms`)}
${tile('alarms', alarmFiring ? 'FIRING' : 'OK', alarms.map(a => a.name.replace('logon-', '')).join(', ') || 'n/a', alarmFiring ? 'critical' : 'good')}
</div>
${flags.length ? `<ul class="flags">${flags.map(f => `<li class="${f.sev}"><b>${f.sev.toUpperCase()}</b> — ${esc(f.msg)}</li>`).join('')}</ul>` : '<p class="muted">No threshold flags — all watch signals nominal.</p>'}

<h2>Stage flow <span class="muted">(the funnel — issuance → widget → challenge → server, quantified end-to-end)</span></h2>
<p class="sub">Each node is the volume reaching that stage; each arrow is quantified flow-through. Drop-offs exit as labeled arrows: <b>not-loaded</b> (mount fail) at the widget, one arrow <b>per challenge fail reason</b>, and <b>403 / 429</b> at the server. The <b style="color:var(--critical)">tokenless/absent</b> bypass enters directly at the server — bots that skip [1]–[3].</p>
${flowSection()}

<h2>Bot / non-human prevention <span class="muted">(two gates · auth forms)</span></h2>
<p class="sub"><b>Client gate</b> (widget): page-loading bots that can't solve → no token → blocked before the server (mode-independent). <b>Server gate</b> (turnstile): <b>direct-to-server</b> bots that skip the page and POST tokenless/invalid → ${enforceActive ? '403 under Enforce (live)' : 'allowed under Observe, 403 under Enforce'}.</p>
<div class="card">
  <div class="tiles">
    ${tile('bot-like prevented', fmt(preventedTotal), preventRate != null ? preventRate + '% of submit attempts' : '', preventedTotal ? 'good' : '')}
    ${tile('client gate', fmt(preventClient), 'widget failed → no token')}
    ${tile('server gate', fmt(preventServer), 'tokenless/invalid → 403', preventServer > TH.absentYellow ? 'warning' : '')}
    ${tile('human verified', fmt(allowedHuman), 'pass + softpass + trusted', 'good')}
  </div>
  ${prevBar()}
  <p class="muted" style="margin-top:11px">Widget-gate friction across <b>all</b> forms (incl estimator/twproxy beacons): <b>${fmt(preventClientAll)}</b> failed beacons blocked before any server. Caveat: "client-gate blocked" includes real users who couldn't load the widget (iOS ratelimited, slow networks, blockers) — <i>bot-like</i>, not certified bots (the beacon carries no IP).</p>
</div>

${tokenlessSection()}

<h2>Full form lifecycle <span class="muted">(per form · exact numbers)</span></h2>
<p class="sub">Cloudflare issuance → client gate (widget) → server gate (siteverify), per discovered form. A silent server cell reads <b>awaiting</b> only when that producer log group does not exist yet; when the group is live and merely had no traffic it reads <b>zero</b> with the group's last-event time -- a trustworthy zero, not a blind spot.<br>
<b>Window caveat:</b> the Cloudflare column comes from <code>turnstileAdaptiveGroups</code>, which is <b>day-granular and fleet-wide</b> (whole calendar days from ${esc(iso(startMs).slice(0, 10))}, every host, both tiers) -- the beacon and server columns are the exact ${esc(HOURS)}h window. Issued ≫ beacon is expected and the ratio is <i>not</i> a drop-off rate.</p>
<div class="key" style="display:flex;gap:16px;flex-wrap:wrap;font-size:.76em;color:var(--ink2);margin:4px 0 10px">
  <span class="o ok"><b>●</b>allowed</span>
  <span class="o enf"><b>◑</b>${enforceActive ? 'allowed this event' : 'allow now → 403 Enforce'}</span>
  <span class="o blk"><b>■</b>403'd</span>
  <span class="o blk"><b>✗</b>client-gate blocked</span>
</div>
<div class="card">${allEps.map(lifecycleRow).join('')}</div>

<h2>Server verify — outcomes by day <span class="muted">(Logon plane)</span></h2>
<div class="card">${trend()}</div>

${siteSection()}

<h2>Beacon failure reasons — by form</h2>
<div class="card"><table><thead><tr><th>form</th><th>reason</th><th class="n">count</th></tr></thead><tbody>
${beaconFailRows.length ? beaconFailRows.map(r => `<tr><td>${esc(r.action)}</td><td>${esc(r.reason || '(none)')}</td><td class="n">${r.n}</td></tr>`).join('') : '<tr><td colspan="3" class="muted">no organic beacon failures</td></tr>'}
</tbody></table></div>

${twproxySection()}

${accountsSection()}

${warn.length ? `<h2>Data warnings</h2><div class="card"><ul>${warn.map(w => `<li class="muted">${esc(w)}</li>`).join('')}</ul></div>` : ''}

<div class="foot">
<b>One unified schema across every surface.</b> Each system emits <code>{system, endpoint, outcome, allowed, hostname, …}</code> to its own CloudWatch group; the report derives <code>system</code> from the event (or its source group) and discovers <code>endpoint</code>s from the data, so a new form/surface appears automatically with no report edit. Live mode is <b>${esc(modeWord)}</b>.<br>
Two gates: the <b>client gate</b> (widget) blocks page-loading bots that fail the challenge (mode-independent); the <b>server gate</b> (turnstile siteverify) blocks direct-to-server bots that skip the page and POST tokenless/invalid. pass / pass-ratelimited (softpass) / bypassed-auth are allowed; fail / absent are 403'd under Enforce; <b>429</b> is the Logon per-IP rate-limit (a distinct exit). The <b>layer</b> axis (edge=WAF, app=Turnstile; all surfaces here = <code>app</code>) is derived from <code>system</code>, reserved for the future WAF-edge join.<br>
Thresholds (tunable): fail&gt;${TH.failRed}=RED, absent&gt;${TH.absentYellow}=YELLOW, ratelimited-softpass&ge;${TH.ratelimitedRed}=RED. Verdict on the Logon auth surface (register+forgot). CF issuance is fleet-wide (issued ≫ beacon ≫ verified is expected). "Organic" excludes ua~curl only — it does not separate bots from humans (beacon has no IP).<br>
Regenerate: <code>node soak-report.js --env ${ENV} --hours ${HOURS}</code> &middot; generated ${esc(iso(now))}
</div>
</div></body></html>`;

fs.writeFileSync(OUT, html);
console.log(`wrote ${OUT}  verdict=${verdict}  mode=${modeWord}  auth pass=${vPass} fail=${vFail} absent=${vAbsent} rl=${vRl} 429=${vRl429} 403s=${vBlocked}  prevented=${preventedTotal} (client ${preventClient}/server ${preventServer})  forms=${allEps.length} [${allEps.join(',')}]  systems=[${systemsWithServer.join(',')||'none'}]  sites=${sites.length}  twproxy=${twTotal}req/${twHostilePct}%hostile  warnings=${warn.length}`);
