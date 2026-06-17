// Estimator-walk network capture: walk preview2-il b2w2 to results and inventory
// EVERY request (method/path/type/status + POST body sizes) to enumerate the
// dynamic/POST/API surface (query.aspx postbacks, AutosaveSession, SavedSessions,
// results, engine .asmx). For cache-bypass + WAF scope. Count mode: nothing blocks.
const { chromium } = require('C:/svn/f8/f8/node_modules/playwright-core');
const ENTRY = 'https://preview2-il.db101.org/planning/b2w2_il_index.aspx';
const MAXSTEPS = 22;
(async () => {
  const browser = await chromium.launch({ headless:true });
  const page = await (await browser.newContext({ userAgent:'EFW-WAFTEST-netcapwalk' })).newPage();
  page.on('dialog', d => d.accept().catch(()=>{}));
  const reqs = [];
  page.on('requestfinished', async req => {
    let status=null; try{const r=await req.response(); if(r)status=r.status();}catch{}
    const body = (req.method()!=='GET') ? (req.postData()||'') : '';
    reqs.push({ m:req.method(), url:req.url(), type:req.resourceType(), status, bodyLen:body.length });
  });

  const fillRequired = async () => {
    for (const el of await page.locator('input:visible').elementHandles()){
      const type=(await el.getAttribute('type')||'text').toLowerCase();
      if(['hidden','submit','button','radio','checkbox','image','file'].includes(type))continue;
      if(await el.inputValue().catch(()=> '')) continue;
      const n=((await el.getAttribute('name'))||(await el.getAttribute('id'))||'').toLowerCase();
      let v='0';
      if(/_month|(^|[^a-z])month/.test(n))v='6'; else if(/birth|_year|dob/.test(n))v='1980';
      else if(/year/.test(n))v='2026'; else if(/zip/.test(n))v='60601'; else if(/age/.test(n))v='40';
      else if(/hour/.test(n))v='40'; else if(/wage|pay|income|amount|earn/.test(n))v='1500';
      else if(/nick/.test(n))v='WAFTEST-netcap'; else if(type==='text'&&/name|first|last/.test(n))v='WAFTEST';
      await el.fill(v).catch(()=>{});
    }
    for (const el of await page.locator('select:visible').elementHandles()){
      const opts=await el.$$eval('option',os=>os.map(o=>o.value)); const pick=opts.find(v=>v&&v!=='-1'&&v!=='0'&&v.trim()!=='');
      if(pick) await el.selectOption(pick).catch(()=>{});
    }
    const seen=new Set();
    for (const el of await page.locator('input[type=radio]:visible').elementHandles()){ const n=(await el.getAttribute('name'))||''; if(seen.has(n))continue; seen.add(n); await el.check().catch(()=>{}); }
  };
  const advance = async () => { for (const s of ['a:has-text("Get Started")','button:has-text("Get Started")','a:has-text("Continue")','button:has-text("Continue")','input[value*="Continue" i]','a:has-text("Next")','a:has-text("See Results")','a:has-text("Results")','.nav-next','input[type=submit]:visible','button[type=submit]:visible']){ const l=page.locator(s).first(); if(await l.count()&&await l.isVisible().catch(()=>false)){await l.click({timeout:5000}).catch(()=>{}); return true;} } return false; };

  await page.goto(ENTRY,{waitUntil:'networkidle',timeout:30000});
  let last='',stall=0;
  for(let i=1;i<=MAXSTEPS;i++){
    await page.waitForLoadState('domcontentloaded',{timeout:20000}).catch(()=>{});
    const scr=(page.url().match(/screen=([^&]+)/)||[])[1]||'?';
    if(/res_summary|results|next_steps/i.test(page.url())){console.log('reached',scr);break;}
    if(scr===last){if(++stall>=2){console.log('stall',scr);break;}}else{stall=0;last=scr;}
    await fillRequired(); if(!await advance())break;
    await page.waitForLoadState('networkidle',{timeout:20000}).catch(()=>{});
  }
  await browser.close();

  const U=u=>{try{const x=new URL(u);return{host:x.host,path:x.pathname};}catch{return{host:'?',path:u};}};
  const norm=p=>p.replace(/\(S\([^)]+\)\)/,'(S(..))');
  const ME='preview2-il.db101.org';
  const seen=new Map();
  for(const r of reqs){const {host,path}=U(r.url);const key=`${r.m} ${host}${norm(path)}`;const e=seen.get(key)||{...r,host,path:norm(path),n:0,maxBody:0};e.n++;e.maxBody=Math.max(e.maxBody,r.bodyLen);seen.set(key,e);}
  const rows=[...seen.values()];
  const dyn=rows.filter(r=>r.host===ME&&(r.m!=='GET'||r.type==='xhr'||r.type==='fetch'||/\.(aspx|ashx|asmx|axd)$/i.test(r.path)||/\/(l2svc|f2svc|api|planning)/i.test(r.path)||/SavedSessions|AutosaveSession/i.test(r.path)));
  const stat=rows.filter(r=>r.host===ME&&!dyn.includes(r));
  const xorg=rows.filter(r=>r.host!==ME&&!/google|gstatic|youtube|doubleclick|mastodon|facebook|twitter|jwp/i.test(r.host));
  const pr=(t,a)=>{console.log(`\n=== ${t} (${a.length}) ===`);a.sort((x,y)=>x.path.localeCompare(y.path)).forEach(r=>console.log(`  ${r.m.padEnd(5)} ${(r.status||'').toString().padEnd(4)} ${r.type.padEnd(8)} x${r.n} ${r.host===ME?'':r.host}${r.path}${r.m!=='GET'?'  body~'+r.maxBody+'B':''}`));};
  console.log('\ntotal reqs:',reqs.length,'unique routes:',rows.length);
  pr('SAME-ORIGIN DYNAMIC / POST / API (cache-bypass + WAF scope)',dyn);
  pr('CROSS-ORIGIN SERVICES',xorg);
  pr('SAME-ORIGIN STATIC (cacheable)',stat);
  console.log('\nALL POST/non-GET:');rows.filter(r=>r.m!=='GET').forEach(r=>console.log('  ',r.m,(r.host===ME?'':r.host)+r.path,'body~'+r.maxBody+'B x'+r.n));
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
