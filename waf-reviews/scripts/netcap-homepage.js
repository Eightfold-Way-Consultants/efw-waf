// Capture ALL network traffic on the preview2-il homepage load (+ post-load XHR
// like logon/favorites/sessions polls) to inventory POST/dynamic/API paths for
// cache-bypass + WAF scope. Categorizes same-origin dynamic vs static vs cross-origin services.
const { chromium } = require('C:/svn/f8/f8/node_modules/playwright-core');
const HOME = 'https://preview2-il.db101.org/';
(async () => {
  const b = await chromium.launch({ headless:true });
  const p = await (await b.newContext({ userAgent:'EFW-WAFTEST-netcap' })).newPage();
  const reqs = [];
  p.on('requestfinished', async req => {
    let status=null, ctype='';
    try { const r = await req.response(); if(r){ status=r.status(); ctype=(r.headers()['content-type']||'').split(';')[0]; } } catch{}
    reqs.push({ m:req.method(), url:req.url(), type:req.resourceType(), status, ctype });
  });
  await p.goto(HOME, { waitUntil:'networkidle', timeout:40000 });
  await p.waitForTimeout(7000);  // let deferred XHR (logon state, orgs, favorites, sessions) fire
  await b.close();

  const U = u => { try { const x=new URL(u); return {host:x.host, path:x.pathname}; } catch { return {host:'?',path:u}; } };
  const ME = 'preview2-il.db101.org';
  const ANALYTICS = /google|gstatic|doubleclick|googletagmanager|facebook|twitter|twimg|youtube|jwp|cloudflareinsights|pure\.cloud/i;

  const norm = p => p.replace(/\(S\([^)]+\)\)/,'(S(..))').replace(/\/\d{3,}/g,'/<n>');
  const seen = new Set(), rows = [];
  for (const r of reqs){ const {host,path}=U(r.url); const key=`${r.m} ${host}${norm(path)}`; if(seen.has(key))continue; seen.add(key); rows.push({...r,host,path:norm(path)}); }

  const isDyn = r => r.m!=='GET' || r.type==='xhr' || r.type==='fetch' ||
    /\.(aspx|ashx|asmx|axd)$/i.test(r.path) || /\/(l2svc|f2svc|api|planning)\b/i.test(r.path) ||
    /SavedSessions|AutosaveSession/i.test(r.path);

  const sameDyn = rows.filter(r=>r.host===ME && isDyn(r));
  const sameStatic = rows.filter(r=>r.host===ME && !isDyn(r));
  const svc = rows.filter(r=>r.host!==ME && !ANALYTICS.test(r.host));
  const ext = rows.filter(r=>r.host!==ME && ANALYTICS.test(r.host));

  const pr = (t,a)=>{ console.log(`\n=== ${t} (${a.length}) ===`); a.forEach(r=>console.log(`  ${r.m.padEnd(5)} ${(r.status||'').toString().padEnd(4)} ${r.type.padEnd(8)} ${r.host}${r.path}  [${r.ctype}]`)); };
  console.log('total requests:', reqs.length, ' unique routes:', rows.length);
  pr('SAME-ORIGIN DYNAMIC / API / POST (WAF + cache-bypass scope)', sameDyn);
  pr('CROSS-ORIGIN SERVICE CALLS (logon/favorites/vault/etc.)', svc);
  pr('SAME-ORIGIN STATIC (cacheable)', sameStatic);
  pr('THIRD-PARTY ANALYTICS/EXTERNAL (ignore for WAF)', ext);
  console.log('\nALL non-GET methods:'); rows.filter(r=>r.m!=='GET').forEach(r=>console.log('  ',r.m,r.host+r.path));
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
