// Logged-in dynamic-path capture (READ-ONLY). Injects a real session token into
// localStorage['efw.logon.token'] on preview2-il so the bundle's IsLoggedIn() fires
// the authenticated XHR (Favorites, SavedSessions, vault, logon services), then
// navigates homepage -> /my.htm -> a /planning page and inventories the network.
// Token is read from a temp file (NOT in this script); never logged here. No mutating calls.
const { chromium } = require('C:/svn/f8/f8/node_modules/playwright-core');
const fs = require('fs');
const TOK = fs.readFileSync(process.env.EFW_TOK_FILE, 'utf8').trim();
const ORIGIN = 'https://preview2-il.db101.org';
const LSVAL = JSON.stringify({ access_token: TOK, token_type: 'bearer', UserName: 'jeastman@eightfoldway.com' });

(async () => {
  const b = await chromium.launch({ headless:true });
  const ctx = await b.newContext({ userAgent:'EFW-WAFTEST-authcap' });
  await ctx.addInitScript(v => { try { localStorage.setItem('efw.logon.token', v); } catch(e){} }, LSVAL);
  const page = await ctx.newPage();
  const reqs = [];
  page.on('requestfinished', async req => {
    let status=null; try{const r=await req.response(); if(r)status=r.status();}catch{}
    const auth = !!(req.headers()['authorization']);
    reqs.push({ m:req.method(), url:req.url(), type:req.resourceType(), status, auth, bodyLen:(req.method()!=='GET'?(req.postData()||'').length:0) });
  });
  const visit = async (path,label) => {
    try { await page.goto(ORIGIN+path,{waitUntil:'networkidle',timeout:40000}); await page.waitForTimeout(5000);
      console.log(`visited ${label} (${path}) loggedIn=`+await page.evaluate(()=>{try{return !!JSON.parse(localStorage.getItem('efw.logon.token')||'null');}catch{return false;}}));
    } catch(e){ console.log(`visit ${label} err: ${e.message}`); }
  };
  await visit('/','homepage');
  await visit('/my.htm','my-vault');
  await visit('/planning/b2w2_il_index.aspx','estimator-entry');
  await b.close();

  const U=u=>{try{const x=new URL(u);return{host:x.host,path:x.pathname};}catch{return{host:'?',path:u};}};
  const norm=p=>p.replace(/\(S\([^)]+\)\)/,'(S(..))').replace(/\/\d{4,}/g,'/<n>');
  const ME='preview2-il.db101.org';
  const seen=new Map();
  for(const r of reqs){const {host,path}=U(r.url);const k=`${r.m} ${host}${norm(path)}`;const e=seen.get(k)||{...r,host,path:norm(path),n:0};e.n++;e.auth=e.auth||r.auth;seen.set(k,e);}
  const rows=[...seen.values()];
  const ext=/google|gstatic|youtube|doubleclick|mastodon|facebook|twitter|jwp|recaptcha/i;
  const authd = rows.filter(r=>r.auth);
  const dyn = rows.filter(r=>r.host===ME && !ext.test(r.host) && (r.m!=='GET'||r.type==='xhr'||r.type==='fetch'||/\.(aspx|ashx|asmx|axd)$/i.test(r.path)||/\/(l2svc|f2svc|api|planning)/i.test(r.path)||/SavedSessions|AutosaveSession/i.test(r.path)));
  const svc = rows.filter(r=>r.host!==ME && !ext.test(r.host));
  const pr=(t,a)=>{console.log(`\n=== ${t} (${a.length}) ===`);a.sort((x,y)=>(x.host+x.path).localeCompare(y.host+y.path)).forEach(r=>console.log(`  ${r.m.padEnd(5)} ${(r.status||'').toString().padEnd(4)} ${r.auth?'AUTH ':'     '}${r.type.padEnd(8)} ${r.host===ME?'':r.host}${r.path}${r.m!=='GET'?' body~'+r.bodyLen+'B':''}`));};
  console.log('\ntotal reqs:',reqs.length,'unique:',rows.length);
  pr('AUTHENTICATED (Authorization: Bearer) calls', authd);
  pr('SAME-ORIGIN DYNAMIC', dyn);
  pr('CROSS-ORIGIN SERVICES', svc);
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
