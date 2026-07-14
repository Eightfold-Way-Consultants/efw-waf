#!/usr/bin/env node
/*
 * Turnstile soak report — reproducible, all-API (no SSM), self-contained HTML.
 *   node soak-report.js [--env prod|preview] [--hours 72] [--out file.html]
 *
 * Visualizes the FULL LIFECYCLE per form, each stage labeled with allow-status today (Observe) vs Enforce:
 *   Cloudflare issuance  ->  CLIENT GATE (widget/beacon: solved->server / failed->blocked now)
 *                        ->  SERVER GATE (turnstile siteverify: pass/pass-ratelimited/bypassed = allowed;
 *                            fail/absent = allow now -> 403 under Enforce; absent = direct-API/tokenless attack)
 * joined on the form/action. Two gates: the client widget blocks page-loading bots that can't solve; the
 * server turnstile gate blocks DIRECT-API bots that skip the page (tokenless/invalid POST) — Enforce only.
 *
 * Sources (all API, no SSM in core): CF GraphQL turnstileAdaptiveGroups (issuance) + Insights /logon(-preview)/events
 * (type=widget beacon, type=turnstile siteverify) + twproxy-logs/* (feedback proxy, plain-text) + CloudWatch alarms.
 * "Organic" = ua~/curl/ excluded. NOTE: pdfshare verifies on the ESTIMATOR (still not covered); feedback on TWPROXY
 * IS now covered via its own CloudWatch group as a dedicated attack-surface panel.
 * Deps: none (shells out to `aws` CLI + `curl`).
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
const CFG = { prod: { group: '/logon/events', label: 'production' }, preview: { group: '/logon-preview/events', label: 'preview' } }[ENV];
// twproxy (Teamwork feedback proxy) plain-text CloudWatch group, per env box (web-06=public, web-04=preview2).
// Feedback verifies on twproxy, NOT /logon/events — this is the surface the Logon lake structurally can't see.
const TWGROUP = { prod: 'twproxy-logs/ip-10-3-0-63.us-west-1.compute.internal', preview: 'twproxy-logs/ip-10-3-0-122.us-west-1.compute.internal' }[ENV];
const TW_HOURS = 24 * 14;   // twproxy files are month-accumulating + bulk re-shipped on rotation deploy — read the full retained window, labeled as such (not the Logon HOURS window)
const SERVER_OF = { register: 'logon', forgot: 'logon', resend: 'logon', pdfshare: 'estimator', share: 'estimator', feedback: 'twproxy' };
const FORM_ORDER = ['register', 'forgot', 'resend', 'pdfshare', 'share', 'feedback'];
const TH = { failRed: 10, absentYellow: 40, ratelimitedRed: 1 };
const BLOT = 'not (ua like /curl/)';

const now = Date.now(), startMs = now - HOURS * 3600 * 1000;
const twStartMs = now - TW_HOURS * 3600 * 1000;
const aws = (a) => JSON.parse(execFileSync('aws', a.concat(['--region', REGION, '--output', 'json']), { encoding: 'utf8', maxBuffer: 64 << 20 }));
const iso = (ms) => new Date(ms).toISOString();
const sleep = (ms) => execFileSync(process.execPath, ['-e', `setTimeout(()=>{},${ms})`]);
const warn = [];
const tryd = (label, fn, d) => { try { return fn(); } catch (e) { warn.push(label + ': ' + e.message); return d; } };

function insights(q, group = CFG.group, s0 = startMs, e0 = now) {
  const s = aws(['logs', 'start-query', '--log-group-name', group, '--start-time', String(Math.floor(s0 / 1000)), '--end-time', String(Math.floor(e0 / 1000)), '--query-string', q]);
  for (let i = 0; i < 40; i++) {
    const r = aws(['logs', 'get-query-results', '--query-id', s.queryId]);
    if (r.status === 'Complete') return r.results.map(row => Object.fromEntries(row.map(f => [f.field, f.value])));
    if (r.status === 'Failed' || r.status === 'Cancelled') throw new Error('Insights ' + r.status);
    sleep(1500);
  }
  throw new Error('Insights timeout');
}

// ---- gather ----
const beaconRows = tryd('beacon', () => insights(`filter type="widget" and ${BLOT} | stats count() as n by action, event`), []);
const beaconFail = tryd('beacon reasons', () => insights(`filter type="widget" and event="failed" and ${BLOT} | stats count() as n by action, reason | sort n desc`), []);
const serverRows = tryd('server', () => insights(`filter type="turnstile" and ${BLOT} | stats count() as n by endpoint, outcome, allowed`), []);
const serverDay = tryd('server-by-day', () => insights(`filter type="turnstile" and ${BLOT} | stats count() as n by outcome, bin(1d) as day | sort day asc`), []);
const alarms = tryd('alarms', () => (aws(['cloudwatch', 'describe-alarms', '--alarm-names', 'logon-widget-failed-spike', 'logon-verify-absent-spike']).MetricAlarms || []).map(a => ({ name: a.AlarmName, state: a.StateValue })), []);
const cfRowsRaw = tryd('CF issuance', () => {
  const { account_id, api_token } = JSON.parse(aws(['secretsmanager', 'get-secret-value', '--secret-id', 'cloudflare/api', '--query', 'SecretString']));
  const body = execFileSync('curl', ['-s', '-H', `Authorization: Bearer ${api_token}`, '-H', 'Content-Type: application/json',
    '--data', JSON.stringify({ query: `{ viewer { accounts(filter:{accountTag:"${account_id}"}) { turnstileAdaptiveGroups(limit:200, filter:{date_geq:"${iso(startMs).slice(0, 10)}"}) { count dimensions { action } } } } }` }),
    'https://api.cloudflare.com/client/v4/graphql'], { encoding: 'utf8', maxBuffer: 32 << 20 });
  const j = JSON.parse(body); if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 120));
  return ((((j.data || {}).viewer || {}).accounts || [])[0] || { turnstileAdaptiveGroups: [] }).turnstileAdaptiveGroups;
}, []);

// ---- twproxy (feedback surface) — plain-text log group, full retained window ----
const twG = (label, q) => tryd('twproxy ' + label, () => insights(q, TWGROUP, twStartMs, now), []);
const twStartRows = twG('start', `filter @message like /Start request/ | stats count() as n`);
const twOutcomeRows = twG('outcome', `parse @message /Turnstile outcome: (?<oc>[A-Za-z]+)/ | filter ispresent(oc) | stats count() as n by oc | sort n desc`);
const twExitRows = twG('exits', `parse @message /Exit: (?<ex>[A-Za-z][A-Za-z ]*\\([^)]*\\)|[A-Za-z]+)/ | filter ispresent(ex) | stats count() as n by ex | sort n desc | limit 20`);
const twSqliRows = twG('sqli', `parse @message /Exit: Invalid validationType (?<vt>.+)$/ | filter ispresent(vt) | stats count() as n by vt | sort n desc | limit 12`);
const twModeRows = twG('mode', `parse @message /valid=(?<v>True|False) observe=(?<obs>True|False)/ | filter ispresent(obs) | stats count() as n by v, obs`);

const twTotal = +((twStartRows[0] || {}).n || 0);
const twExits = twExitRows.map(r => ({ ex: r.ex, n: +r.n }));
const twExitTotal = twExits.reduce((a, e) => a + e.n, 0);
const twRobot = twExits.filter(e => /robot/i.test(e.ex)).reduce((a, e) => a + e.n, 0);
const twReached = twOutcomeRows.reduce((a, r) => a + (+r.n), 0);               // reached siteverify (past all pre-checks)
const twPass = twOutcomeRows.filter(r => /pass/i.test(r.oc)).reduce((a, r) => a + (+r.n), 0);
const twSqli = twSqliRows.map(r => ({ vt: r.vt, n: +r.n })).filter(r => /select|union|sleep|if\(|now\(|sysdate|char\(|concat|--|;|'|\bor\b|\band\b|=/i.test(r.vt));
const twSqliTotal = twSqli.reduce((a, r) => a + r.n, 0);
const twHostile = Math.max(0, twTotal - twReached);                            // everything that never reached siteverify
const twHostilePct = twTotal ? Math.round(twHostile * 100 / twTotal) : null;
const twMode = { observe: 0, require: 0 };
for (const r of twModeRows) { if (r.obs === 'True') twMode.observe += +r.n; else twMode.require += +r.n; }
const twModeLive = (twMode.observe && twMode.require) ? 'mixed' : twMode.observe ? 'Observe' : twMode.require ? 'Require' : 'unknown';

// ---- shape ----
const cf = {}; for (const r of cfRowsRaw) cf[r.dimensions.action] = (cf[r.dimensions.action] || 0) + r.count;
const beacon = {}; for (const r of beaconRows) (beacon[r.action] = beacon[r.action] || {})[r.event] = +r.n;
const server = {}; for (const r of serverRows) { const ep = (server[r.endpoint] = server[r.endpoint] || {}); const oc = (ep[r.outcome] = ep[r.outcome] || { a: 0, b: 0 }); if (r.allowed === '0') oc.b += +r.n; else oc.a += +r.n; }  // a=allowed, b=blocked(403)

const forms = [...new Set([...Object.keys(cf), ...Object.keys(beacon), ...Object.keys(server), 'register', 'forgot'])]
  .filter(f => f && f !== 'other').sort((a, b) => (FORM_ORDER.indexOf(a) + 1 || 99) - (FORM_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b));

const pipe = forms.map(f => {
  const b = beacon[f] || {}, s = server[f] || {};
  const bSolved = b.solved || 0, bFailed = b.failed || 0, bTot = bSolved + bFailed;
  const sys = SERVER_OF[f] || null;
  const g = (oc) => { const x = s[oc] || { a: 0, b: 0 }; return x.a + x.b; };
  const srv = (sys === 'logon') ? { pass: g('pass'), fail: g('fail'), absent: g('absent'), rl: g('pass-ratelimited'), byp: g('bypassed-auth'), tokens: g('pass') + g('fail') + g('pass-ratelimited'), blocked: Object.values(s).reduce((a, x) => a + (x.b || 0), 0), raw: s } : null;
  return { form: f, cf: cf[f] || 0, bSolved, bFailed, bTot, solvePct: bTot ? Math.round(bSolved * 100 / bTot) : null, server: srv, serverSystem: sys, cfToBeacon: (cf[f] && bTot) ? bTot * 100 / cf[f] : null };
});

// ---- verdict + prevention (auth forms register+forgot) ----
const authForms = pipe.filter(p => p.serverSystem === 'logon');
const vSum = (k) => authForms.reduce((a, p) => a + (p.server ? p.server[k] : 0), 0);
const vPass = vSum('pass'), vFail = vSum('fail'), vAbsent = vSum('absent'), vRl = vSum('rl'), vByp = vSum('byp');
const vBlocked = authForms.reduce((a, p) => a + (p.server ? p.server.blocked : 0), 0);  // actual server 403s (allowed=false)
const alarmFiring = alarms.some(a => a.state === 'ALARM');
const flags = [];
if (alarmFiring) flags.push({ sev: 'critical', msg: 'A CloudWatch alarm is in ALARM state.' });
if (vRl >= TH.ratelimitedRed) flags.push({ sev: 'critical', msg: `ratelimited:global softpass fired (${vRl}) — weaponization signal; consider flipping Turnstile.AllowRateLimited off.` });
if (vFail > TH.failRed) flags.push({ sev: 'critical', msg: `organic server fail = ${vFail} (> ${TH.failRed}) on auth forms.` });
if (vAbsent > TH.absentYellow) flags.push({ sev: 'warning', msg: `direct-API tokenless (absent) = ${vAbsent} (> ${TH.absentYellow}) — the server gate would 403 these under Enforce.` });
const verdict = flags.some(f => f.sev === 'critical') ? 'critical' : flags.some(f => f.sev === 'warning') ? 'warning' : 'good';
const verdictText = { good: 'GREEN — soak clean', warning: 'YELLOW — watch items', critical: 'RED — action needed' }[verdict];

const preventClient = authForms.reduce((a, p) => a + p.bFailed, 0);
const preventClientAll = pipe.reduce((a, p) => a + p.bFailed, 0);
const preventServer = vAbsent + vFail;          // direct-API/tokenless + invalid -> 403 under Enforce
const allowedHuman = vPass + vRl + vByp;
const preventedTotal = preventClient + preventServer;
const preventRate = (allowedHuman + preventedTotal) ? Math.round(preventedTotal * 100 / (allowedHuman + preventedTotal)) : null;

// ---- render ----
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (n) => n == null ? '—' : (+n).toLocaleString('en-US');
const days = [...new Set(serverDay.map(r => (r.day || '').slice(0, 10)))].sort();
const OUTCOMES = ['pass', 'absent', 'fail', 'pass-ratelimited', 'bypassed-auth'];
const OC = { pass: 'var(--s2)', absent: 'var(--s3)', fail: 'var(--s6)', 'pass-ratelimited': 'var(--s5)', 'bypassed-auth': 'var(--s1)' };
// allow-status disposition per server outcome
const DISP = {
  pass: { sym: '●', cls: 'ok', note: 'allowed (now + Enforce)' },
  'pass-ratelimited': { sym: '●', cls: 'ok', note: 'allowed — softpass (now + Enforce)' },
  'bypassed-auth': { sym: '●', cls: 'ok', note: 'allowed — trusted caller' },
  fail: { sym: '◑', cls: 'enf', note: 'allow now · 403 under Enforce' },
  absent: { sym: '◑', cls: 'enf', note: 'allow now · 403 under Enforce · direct-API tokenless' },
};

function stageBar(segs) {
  const any = segs.some(s => s.n);
  return `<div class="sbar">${any ? segs.filter(s => s.n).map(s => `<div style="flex:${s.n};background:${s.color}" title="${esc(s.title)}"></div>`).join('') : '<div class="empty"></div>'}</div>`;
}
function trend() {
  if (!days.length) return '<p class="muted">No server-verify events in window.</p>';
  const per = days.map(d => { const o = {}; for (const r of serverDay.filter(x => (x.day || '').slice(0, 10) === d)) o[r.outcome] = +r.n; return { d, o, tot: OUTCOMES.reduce((a, oc) => a + (o[oc] || 0), 0) }; });
  return `<div class="days">${per.map(p => `<div class="day-col" title="${p.d}: ${p.tot}"><div class="day-stack" style="height:92px">
    ${OUTCOMES.filter(oc => p.o[oc]).map(oc => `<div style="flex:${p.o[oc]};background:${OC[oc]}" title="${oc}: ${p.o[oc]}"></div>`).join('') || '<div class="empty" style="flex:1"></div>'}
    </div><div class="day-lbl">${p.d.slice(5)}</div></div>`).join('')}</div>
    <div class="legend">${OUTCOMES.map(oc => `<span class="lg"><i style="background:${OC[oc]}"></i>${oc}</span>`).join('')}</div>`;
}

function lifecycle(p) {
  const s = p.server;
  const badges = () => {
    const R = s.raw, parts = [];
    for (const k of ['pass', 'pass-ratelimited', 'bypassed-auth']) { const x = R[k] || { a: 0, b: 0 }, t = x.a + x.b; if (t > 0 || k === 'pass') { const d = DISP[k]; parts.push(`<span class="o ${d.cls}" title="${esc(d.note)}"><b>${d.sym}</b>${esc(k)} <em>${t}</em></span>`); } }
    for (const k of ['fail', 'absent']) {
      const x = R[k] || { a: 0, b: 0 };
      if (x.b > 0) parts.push(`<span class="o blk" title="403'd — blocked under Enforce${k === 'absent' ? ' · direct-API tokenless' : ''}"><b>■</b>${esc(k)} <em>${x.b}</em> 403'd</span>`);
      if (x.a > 0 || (x.b === 0 && k === 'absent')) parts.push(`<span class="o enf" title="allow now · 403 under Enforce${k === 'absent' ? ' · direct-API tokenless' : ''}"><b>◑</b>${esc(k)} <em>${x.a}</em></span>`);
    }
    return parts.join('');
  };
  const serverCol = s
    ? `<div class="lc-v">${fmt(s.tokens)}</div><div class="lc-s">tokens${s.absent ? ` · +${s.absent} tokenless` : ''}${s.blocked ? ` · <b style="color:var(--critical)">${s.blocked} 403'd</b>` : ''}</div>
       ${stageBar([{ n: s.pass, color: 'var(--s2)', title: 'pass ' + s.pass }, { n: s.rl, color: 'var(--s5)', title: 'pass-ratelimited ' + s.rl }, { n: s.byp, color: 'var(--s1)', title: 'bypassed ' + s.byp }, { n: s.fail, color: 'var(--s6)', title: 'fail ' + s.fail }, { n: s.absent, color: 'var(--s3)', title: 'absent ' + s.absent }])}
       <div class="lc-out">${badges()}</div>`
    : `<div class="lc-v na">n/a</div><div class="lc-s">verified on ${esc(p.serverSystem || '?')} — not in /logon/events</div>`;
  return `<div class="lc">
    <div class="lc-form">${esc(p.form)}${p.serverSystem === 'logon' ? '' : `<span class="tag">${esc(p.serverSystem || '')}</span>`}</div>
    <div class="lc-stage"><div class="lc-k">Cloudflare</div><div class="lc-v">${fmt(p.cf)}</div><div class="lc-s">issued</div>${stageBar([{ n: p.cf, color: 'var(--s1)', title: 'issued ' + p.cf }])}</div>
    <div class="lc-arr">${p.cfToBeacon != null ? p.cfToBeacon.toFixed(1) + '%' : ''}<span>&rarr;</span></div>
    <div class="lc-stage"><div class="lc-k">Client gate <i>widget</i></div><div class="lc-v">${fmt(p.bTot)}</div><div class="lc-s">${p.solvePct != null ? p.solvePct + '% solved' : 'beacon'}</div>
      ${stageBar([{ n: p.bSolved, color: 'var(--s2)', title: 'solved ' + p.bSolved }, { n: p.bFailed, color: 'var(--s6)', title: 'failed ' + p.bFailed }])}
      <div class="lc-out"><span class="o ok" title="solved → token → server"><b>✓</b>${p.bSolved} →server</span><span class="o blk" title="failed → no token → blocked at client, never reaches server"><b>✗</b>${p.bFailed} blocked now</span></div></div>
    <div class="lc-arr"><span>&rarr;</span></div>
    <div class="lc-stage"><div class="lc-k">Server gate <i>turnstile</i></div>${serverCol}</div>
  </div>`;
}

const tile = (l, v, s, sev) => `<div class="tile ${sev || ''}"><div class="tile-val">${v}</div><div class="tile-lbl">${esc(l)}</div>${s ? `<div class="tile-sub">${esc(s)}</div>` : ''}</div>`;

// --accounts: ground-truth account creation + garbage indicators from logon2.AspNetUsers (opt-in; SSM/DB, not all-API)
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
      <p class="muted" style="margin-top:8px">Ground truth: actual accounts created (not a gate metric). Garbage indicators should stay near-zero post-Turnstile. Needs SSM/DB (opt-in <code>--accounts</code>) — not part of the all-API core.</p>
    </div>`;
}
function prevBar() {
  const segs = [{ n: allowedHuman, color: 'var(--s2)', label: 'human verified' }, { n: preventClient, color: 'var(--s6)', label: 'client-gate blocked' }, { n: preventServer, color: 'var(--s3)', label: 'server-gate (Enforce)' }];
  return `<div class="pbar">${segs.some(s => s.n) ? segs.filter(s => s.n).map(s => `<div style="flex:${s.n};background:${s.color}" title="${esc(s.label)}: ${s.n}"></div>`).join('') : '<div class="empty" style="flex:1"></div>'}</div>
    <div class="legend">${segs.map(s => `<span class="lg"><i style="background:${s.color}"></i>${esc(s.label)} <b>${s.n}</b></span>`).join('')}</div>`;
}
function twproxySection() {
  if (!twTotal && !twExitTotal) return `<h2>Feedback proxy <span class="muted">(twproxy)</span></h2><div class="card"><p class="muted">No twproxy events in <code>${esc(TWGROUP)}</code> for the retained window.${warn.filter(w => w.startsWith('twproxy')).length ? ' See data warnings.' : ''}</p></div>`;
  const funnel = [
    { n: twReached, color: 'var(--s2)', label: 'reached siteverify' },
    { n: twRobot, color: 'var(--s6)', label: 'Turnstile-blocked (robot)' },
    { n: Math.max(0, twHostile - twRobot), color: 'var(--s3)', label: 'rejected pre-gate (method/tags/payload)' },
  ];
  const modeCls = twModeLive === 'Observe' ? 'warning' : twModeLive === 'Require' ? 'good' : '';
  return `<h2>Feedback proxy <span class="muted">(twproxy · ${esc(ENV === 'prod' ? 'web-06 public' : 'web-04 preview2')} · retained ${TW_HOURS / 24}d)</span></h2>
  <p class="sub">The feedback → Teamwork-task proxy. Its telemetry is plain-text in <code>${esc(TWGROUP)}</code>, a separate CloudWatch group from the Logon lake — <b>this surface is invisible to the funnel above</b>. Requests that fail method/tag/payload/token checks exit before siteverify; only survivors reach the Turnstile gate.</p>
  <div class="card">
    <div class="tiles">
      ${tile('total requests', fmt(twTotal), 'retained window', twHostilePct >= 80 ? 'critical' : twHostilePct >= 50 ? 'warning' : '')}
      ${tile('hostile / non-legit', twHostilePct != null ? twHostilePct + '%' : '—', `${fmt(twHostile)} never reached siteverify`, twHostilePct >= 80 ? 'critical' : 'warning')}
      ${tile('Turnstile robot-blocks', fmt(twRobot), twRobot ? 'gate denied (Require mode)' : 'none in window', twRobot ? 'good' : '')}
      ${tile('SQLi probes', fmt(twSqliTotal), twSqliTotal ? 'in validationType field' : 'none', twSqliTotal ? 'critical' : 'good')}
      ${tile('reached siteverify', fmt(twReached), `${fmt(twPass)} passed`, 'good')}
      ${tile('live mode (inferred)', twModeLive, twMode.observe || twMode.require ? `${fmt(twMode.require)} Require · ${fmt(twMode.observe)} Observe lines` : 'no scheme lines', modeCls)}
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
    <p class="muted" style="margin-top:12px">${twModeLive === 'Observe' ? '<b style="color:var(--warning)">Live mode reads Observe</b> — Turnstile-only bot failures are NOT blocked here today; they proceed toward task creation. Flip to Require to close it.' : twModeLive === 'Require' ? '<b style="color:var(--good)">Live mode reads Require</b> — the gate is actively denying bots.' : 'Mode not inferable from this window (no <code>valid=/observe=</code> scheme lines).'} "Robot-block" lines only emit under Require, so their presence dates Require-mode traffic. Window is the twproxy group\'s full retention (bulk re-shipped on the rotation deploy), not the ${HOURS}h Logon window.</p>
  </div>`;
}
const bTotAll = pipe.reduce((a, p) => a + p.bTot, 0), bSolvedAll = pipe.reduce((a, p) => a + p.bSolved, 0);

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Turnstile soak — ${esc(CFG.label)}</title><style>
:root{--surface:#fcfcfb;--plane:#f9f9f7;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--grid:#e1e0d9;--ring:rgba(11,11,11,.10);
--s1:#2a78d6;--s2:#1baf7a;--s3:#eda100;--s5:#4a3aa7;--s6:#e34948;--good:#0ca30c;--warning:#e08600;--critical:#d03b3b;}
@media(prefers-color-scheme:dark){:root{--surface:#1a1a19;--plane:#0d0d0d;--ink:#fff;--ink2:#c3c2b7;--muted:#898781;--grid:#2c2c2a;--ring:rgba(255,255,255,.10);
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
.key{display:flex;gap:16px;flex-wrap:wrap;font-size:.76em;color:var(--ink2);margin:4px 0 10px}
.o{display:inline-flex;align-items:center;gap:3px;color:var(--ink2);white-space:nowrap}.o b{font-size:1.1em;line-height:1}.o em{font-style:normal;font-weight:650;color:var(--ink)}
.o.ok b{color:var(--good)}.o.enf b{color:var(--warning)}.o.blk b{color:var(--critical)}
.lc{display:grid;grid-template-columns:84px 1fr 44px 1.1fr 26px 1.55fr;gap:9px;align-items:start;padding:14px 2px;border-top:1px solid var(--grid)}
.lc-form{font-weight:600;font-size:.92em;padding-top:14px}.tag{display:inline-block;background:var(--grid);border-radius:20px;padding:0 6px;font-size:.68em;color:var(--ink2);font-weight:500}
.lc-k{font-size:.66em;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:1px}.lc-k i{font-style:normal;text-transform:none;letter-spacing:0;background:var(--grid);border-radius:20px;padding:0 6px;color:var(--ink2);font-size:1.05em}
.lc-v{font-size:1.25em;font-weight:650;font-variant-numeric:tabular-nums;line-height:1.1}.lc-v.na{color:var(--muted);font-weight:500}
.lc-s{font-size:.7em;color:var(--muted)}
.lc-arr{text-align:center;color:var(--muted);font-size:.66em;font-variant-numeric:tabular-nums;padding-top:16px}.lc-arr span{display:block;font-size:1.2em;color:var(--grid)}
.lc-out{display:flex;flex-wrap:wrap;gap:3px 9px;margin-top:6px;font-size:.72em;font-variant-numeric:tabular-nums}
.sbar{height:8px;border-radius:3px;overflow:hidden;display:flex;gap:1.5px;margin-top:5px;background:var(--grid)}.sbar>div{min-width:2px}
.pbar{height:22px;border-radius:5px;overflow:hidden;display:flex;gap:2px;background:var(--grid);margin-top:4px}.pbar>div{min-width:3px}
.empty{background:var(--grid);opacity:.4;flex:1}
.days{display:flex;gap:7px;align-items:flex-end;padding:6px 0}.day-col{flex:1;display:flex;flex-direction:column;align-items:center;min-width:24px}
.day-stack{width:100%;max-width:42px;display:flex;flex-direction:column-reverse;border-radius:4px 4px 0 0;overflow:hidden;gap:2px}
.day-lbl{font-size:.7em;color:var(--muted);margin-top:5px;font-variant-numeric:tabular-nums}
.legend{display:flex;gap:14px;flex-wrap:wrap;margin-top:8px;font-size:.76em;color:var(--ink2)}.lg{display:flex;gap:5px;align-items:center}.lg i{width:10px;height:10px;border-radius:3px}
.flags{list-style:none;padding:0;margin:12px 0}.flags li{padding:8px 12px;border-radius:8px;margin-bottom:6px;border:1px solid var(--ring)}
.flags .critical{border-left:3px solid var(--critical)}.flags .warning{border-left:3px solid var(--warning)}
table{width:100%;border-collapse:collapse;font-size:.82em;margin-top:8px}th,td{text-align:left;padding:5px 9px;border-bottom:1px solid var(--grid)}th{color:var(--muted);font-weight:600}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
.foot{color:var(--muted);font-size:.77em;margin-top:32px;border-top:1px solid var(--grid);padding-top:13px}
.pill{display:inline-block;background:var(--grid);border-radius:20px;padding:1px 9px;color:var(--ink2)}
</style></head><body><div class="wrap">
<h1>Turnstile soak report</h1>
<div class="meta"><span class="pill">${esc(CFG.label)}</span> &middot; last ${HOURS}h &middot; ${esc(iso(startMs))} → ${esc(iso(now))} &middot; generated ${esc(iso(now))}<br>
CF GraphQL issuance + Insights <code>${esc(CFG.group)}</code> (beacon + siteverify) + <code>twproxy-logs</code> (feedback) + CloudWatch alarms &middot; organic (ua~curl excluded)</div>
<div class="banner ${verdict}"><span class="dot">${verdict === 'good' ? '●' : verdict === 'warning' ? '▲' : '■'}</span><span>${esc(verdictText)}</span></div>

<div class="tiles">
${tile('server pass', fmt(vPass), 'register+forgot, organic', 'good')}
${tile('server fail', fmt(vFail), 'invalid token', vFail > TH.failRed ? 'critical' : vFail ? 'warning' : 'good')}
${tile('direct-API tokenless', fmt(vAbsent), 'absent → 403 under Enforce', vAbsent > TH.absentYellow ? 'warning' : '')}
${tile('server 403s served', fmt(vBlocked), vBlocked ? 'actual blocks (allowed=false)' : 'Observe: 0 (recorded, not blocked)', vBlocked ? 'warning' : 'good')}
${tile('ratelimited softpass', fmt(vRl), 'allowed through (now+Enforce)', vRl >= TH.ratelimitedRed ? 'critical' : 'good')}
${tile('beacon solve-rate', bTotAll ? Math.round(bSolvedAll * 100 / bTotAll) + '%' : '—', `${fmt(bSolvedAll)}/${fmt(bTotAll)} all forms`)}
${tile('alarms', alarmFiring ? 'FIRING' : 'OK', alarms.map(a => a.name.replace('logon-', '')).join(', ') || 'n/a', alarmFiring ? 'critical' : 'good')}
</div>
${flags.length ? `<ul class="flags">${flags.map(f => `<li class="${f.sev}"><b>${f.sev.toUpperCase()}</b> — ${esc(f.msg)}</li>`).join('')}</ul>` : '<p class="muted">No threshold flags — all watch signals nominal.</p>'}

<h2>Bot / non-human prevention <span class="muted">(two gates · auth forms)</span></h2>
<p class="sub"><b>Client gate</b> (widget): page-loading bots that can't solve → no token → blocked before the server (enforced now under Observe). <b>Server gate</b> (turnstile): <b>direct-API</b> bots that skip the page and POST tokenless/invalid → reach siteverify → allowed under Observe today, <b>403 under Enforce</b>.</p>
<div class="card">
  <div class="tiles">
    ${tile('bot-like prevented', fmt(preventedTotal), preventRate != null ? preventRate + '% of submit attempts' : '', preventedTotal ? 'good' : '')}
    ${tile('client gate — now', fmt(preventClient), 'widget failed → no token')}
    ${tile('server gate — Enforce', fmt(preventServer), 'direct-API tokenless/invalid → 403', preventServer > TH.absentYellow ? 'warning' : '')}
    ${tile('human verified', fmt(allowedHuman), 'pass + softpass + trusted', 'good')}
  </div>
  ${prevBar()}
  <p class="muted" style="margin-top:11px">Widget-gate friction across <b>all</b> forms (incl estimator/twproxy): <b>${fmt(preventClientAll)}</b> failed beacons blocked before any server. Caveat: "client-gate blocked" includes real users who couldn't load the widget (iOS ratelimited, slow networks, blockers) — it is <i>bot-like</i>, not certified bots (the beacon carries no IP).</p>
</div>

${twproxySection()}

<h2>Full form lifecycle</h2>
<p class="sub">Cloudflare issuance → client gate (widget) → server gate (siteverify), per form. % under the first arrow = issued→beacon conversion.</p>
<div class="key">
  <span class="o ok"><b>●</b>allowed now + Enforce</span>
  <span class="o enf"><b>◑</b>allowed now → 403 under Enforce</span>
  <span class="o blk"><b>✗</b>blocked at client gate (no token)</span>
</div>
<div class="card">${pipe.map(lifecycle).join('')}</div>

<h2>Server verify — outcomes by day</h2>
<div class="card">${trend()}</div>

<h2>Beacon failure reasons — by form</h2>
<div class="card"><table><thead><tr><th>form</th><th>reason</th><th class="n">count</th></tr></thead><tbody>
${beaconFail.length ? beaconFail.map(r => `<tr><td>${esc(r.action)}</td><td>${esc(r.reason || '(none)')}</td><td class="n">${r.n}</td></tr>`).join('') : '<tr><td colspan="3" class="muted">no organic beacon failures</td></tr>'}
</tbody></table></div>

${accountsSection()}

${warn.length ? `<h2>Data warnings</h2><div class="card"><ul>${warn.map(w => `<li class="muted">${esc(w)}</li>`).join('')}</ul></div>` : ''}

<div class="foot">
Two gates: the <b>client gate</b> (widget) blocks page-loading bots that fail the challenge (enforced now, mode-independent); the <b>server gate</b> (turnstile siteverify) blocks direct-API bots that skip the page and POST tokenless/invalid — only under Enforce (Observe today allows+records). pass / pass-ratelimited (softpass) / bypassed-auth are allowed in both modes; fail / absent are the Enforce delta.<br>
Thresholds (tunable): fail&gt;${TH.failRed}=RED, absent&gt;${TH.absentYellow}=YELLOW, ratelimited-softpass&ge;${TH.ratelimitedRed}=RED. Verdict on auth forms (register+forgot); pdfshare/feedback lack a Logon server stage.<br>
Caveats: CF issuance is fleet-wide and counts every challenge/render, so issued ≫ beacon ≫ verified is expected. "Organic" excludes only ua~curl synthetic tests — it does NOT separate bots from humans (beacon has no IP). Real clients behind the web-06 ARR proxy are recorded by their true XFF IP (port-stripped by ClientIp.From).<br>
Regenerate: <code>node soak-report.js --env ${ENV} --hours ${HOURS}</code>
</div>
</div></body></html>`;

fs.writeFileSync(OUT, html);
console.log(`wrote ${OUT}  verdict=${verdict}  auth pass=${vPass} fail=${vFail} absent=${vAbsent} rl=${vRl}  prevented=${preventedTotal} (client ${preventClient}/server ${preventServer})  forms=${forms.length}  twproxy=${twTotal}req/${twHostilePct}%hostile/robot${twRobot}/sqli${twSqliTotal}/mode=${twModeLive}  warnings=${warn.length}`);
