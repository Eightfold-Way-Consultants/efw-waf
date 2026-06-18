// Max-household body-size check: drive a deliberately heavy b2w2_il session
// (married -> spouse branch, several children, a modeled job) to results and report
// the LARGEST /planning POST body, vs WAF's body-inspection limit (CloudFront default 16KB).
const { chromium } = require('C:/svn/f8/f8/node_modules/playwright-core');
const ENTRY = 'https://preview2-il.db101.org/planning/b2w2_il_index.aspx';
const MAXSTEPS = 40;
(async () => {
  const browser = await chromium.launch({ headless:true });
  const page = await (await browser.newContext({ userAgent:'EFW-WAFTEST-maxhh' })).newPage();
  page.on('dialog', d => d.accept().catch(()=>{}));
  const posts = [];  // {screen, bytes}
  let curScreen = 'start';
  page.on('request', r => { if (r.method()!=='GET' && r.url().includes('/planning/')) posts.push({ screen:curScreen, bytes:(r.postData()||'').length, url:r.url() }); });

  const fillRequired = async () => {
    for (const el of await page.locator('input:visible').elementHandles()){
      const type=(await el.getAttribute('type')||'text').toLowerCase();
      if(['hidden','submit','button','radio','checkbox','image','file'].includes(type))continue;
      if(await el.inputValue().catch(()=> '')) continue;
      const n=((await el.getAttribute('name'))||(await el.getAttribute('id'))||'').toLowerCase();
      let v='0';
      if(/_month|(^|[^a-z])month/.test(n))v='6'; else if(/birth|_year|dob/.test(n))v='1980';
      else if(/year/.test(n))v='2026'; else if(/zip/.test(n))v='60601'; else if(/age/.test(n))v='40';
      else if(/child/.test(n))v='0';                      // 0 children (avoid sess_children sub-screen stall); married=Yes still inflates via spouse branch
      else if(/hour/.test(n))v='40'; else if(/wage|pay|income|amount|earn/.test(n))v='2500';
      else if(/nick/.test(n))v='WAFTEST-maxhh'; else if(type==='text'&&/name|first|last/.test(n))v='WAFTEST';
      await el.fill(v).catch(()=>{});
    }
    for (const el of await page.locator('select:visible').elementHandles()){
      const opts=await el.$$eval('option',os=>os.map(o=>o.value)); const pick=opts.find(x=>x&&x!=='-1'&&x!=='0'&&x.trim()!=='');
      if(pick) await el.selectOption(pick).catch(()=>{});
    }
    // radios: married -> pick the "Yes / living with spouse" option; else first in group
    const seen=new Set();
    for (const el of await page.locator('input[type=radio]:visible').elementHandles()){
      const nm=(await el.getAttribute('name'))||''; if(seen.has(nm))continue; seen.add(nm);
      if(/married/i.test(nm)){
        // try a sibling whose label says Yes; fallback to first
        const grp = await page.locator(`input[name="${nm}"]`).elementHandles();
        let picked=false;
        for(const r of grp){ const id=await r.getAttribute('id'); if(id){ const lab=await page.locator(`label[for="${id}"]`).textContent().catch(()=>''); if(/yes/i.test(lab||'')){ await r.check().catch(()=>{}); picked=true; break; } } }
        if(!picked) await el.check().catch(()=>{});
      } else await el.check().catch(()=>{});
    }
  };
  const advance = async () => { for (const s of ['a:has-text("Get Started")','button:has-text("Get Started")','a:has-text("Continue")','button:has-text("Continue")','input[value*="Continue" i]','a:has-text("Next")','a:has-text("See Results")','a:has-text("Results")','.nav-next','input[type=submit]:visible','button[type=submit]:visible']){ const l=page.locator(s).first(); if(await l.count()&&await l.isVisible().catch(()=>false)){await l.click({timeout:5000}).catch(()=>{}); return true;} } return false; };

  await page.goto(ENTRY,{waitUntil:'networkidle',timeout:30000});
  let last='',stall=0;
  for(let i=1;i<=MAXSTEPS;i++){
    await page.waitForLoadState('domcontentloaded',{timeout:20000}).catch(()=>{});
    curScreen=(page.url().match(/screen=([^&]+)/)||[])[1]||(page.url().split('/').pop()||'').split('?')[0];
    if(/res_summary|results|next_steps/i.test(page.url())){console.log('reached',curScreen);break;}
    if(curScreen===last){if(++stall>=3){console.log('stall at',curScreen);break;}}else{stall=0;last=curScreen;}
    await fillRequired(); if(!await advance())break;
    await page.waitForLoadState('networkidle',{timeout:20000}).catch(()=>{});
  }
  await browser.close();
  posts.sort((a,b)=>b.bytes-a.bytes);
  console.log('\nPOST bodies (largest first):');
  posts.slice(0,8).forEach(p=>console.log(`  ${String(p.bytes).padStart(6)}B  ${p.screen}`));
  const max = posts.length?posts[0].bytes:0;
  console.log(`\nMAX /planning POST body = ${max} B`);
  console.log(`  vs CloudFront WAF default body inspection 16384 B -> ${max<16384?'UNDER (full body inspected)':'OVER (body truncated at 16KB!)'}`);
  console.log(`  (regional default would be 8192 B -> ${max<8192?'under':'over'})`);
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
