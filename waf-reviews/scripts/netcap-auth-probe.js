// READ-ONLY authenticated endpoint probe. Injects the session token, then issues
// GET-only fetches (Authorization: Bearer) to the known service endpoints to confirm
// each path + whether it's same-origin (this WAF's scope) or cross-origin. No writes.
const { chromium } = require('C:/svn/f8/f8/node_modules/playwright-core');
const fs = require('fs');
const TOK = fs.readFileSync(process.env.EFW_TOK_FILE,'utf8').trim();
const ORIGIN = 'https://preview2-il.db101.org';
// service hosts per preview2 efw.logon2.services.js
const SVC = { logon:'https://preview-logon.db101.org', fav:'https://preview-favorites.db101.org', session:'/planning/SavedSessions' };
const SITE = 17;

(async () => {
  const b = await chromium.launch({ headless:true });
  const page = await (await b.newContext({ userAgent:'EFW-WAFTEST-authprobe' })).newPage();
  await page.goto(ORIGIN+'/', { waitUntil:'domcontentloaded', timeout:30000 });
  const targets = [
    ['SavedSessions (same-origin)', `${ORIGIN}${SVC.session}?max=8`],
    ['Favorites (cross-origin)',    `${SVC.fav}/api/Favorites?site=${SITE}`],
    ['Organizations (cross-origin)',`${SVC.logon}/api/Organizations?site=${SITE}`],
    ['Account/UserInfo (cross-origin)', `${SVC.logon}/api/Account/UserInfo`],
  ];
  const out = await page.evaluate(async ({TOK,targets}) => {
    const res=[];
    for (const [label,url] of targets) {
      try { const r = await fetch(url, { method:'GET', headers:{ 'Authorization':'Bearer '+TOK } });
        res.push(`${label}\t${r.status}\t${url.replace(/https:\/\/[^/]+/,m=>m)}`); }
      catch(e){ res.push(`${label}\tERR ${e.message}\t${url}`); }
    }
    return res;
  }, { TOK, targets });
  console.log('-- authenticated GET probes (read-only) --');
  out.forEach(l=>console.log('  '+l));
  await b.close();
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
