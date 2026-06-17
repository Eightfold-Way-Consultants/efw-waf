// A12a — single-session estimator walk via Playwright (real headless Chromium).
// Walks preview2-il b2w2 estimator entry -> session -> through the wizard to results,
// auto-filling required fields. Measures requests-per-walk + every /planning hit
// (each = Challenge-Estimator COUNT in Count mode). Low load: ONE session.
const { chromium } = require('C:/svn/f8/f8/node_modules/playwright-core');
const ENTRY = 'https://preview2-il.db101.org/planning/b2w2_il_index.aspx';
const MAXSTEPS = 22;

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ userAgent: 'EFW-WAFTEST-20260617 (playwright A12a)' });
  const page = await ctx.newPage();
  // Soft "asserts" (e.g. "no nickname, continue anyway?", "no income, did you mean to?")
  // surface as native confirm() dialogs — accept them to proceed. Playwright's default is dismiss(=cancel).
  page.on('dialog', async d => { console.log('  dialog['+d.type()+']:', JSON.stringify(d.message().replace(/\s+/g,' ').slice(0,80))); await d.accept().catch(()=>{}); });
  const planning = [];
  page.on('request', r => { const u = r.url(); if (u.includes('/planning/')) planning.push(u); });

  const t0 = new Date().toISOString();
  await page.goto(ENTRY, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(()=>{});
  const sess = (page.url().match(/\(S\(([^)]+)\)\)/)||[])[1] || '(none)';
  console.log('START', t0, 'session', sess);

  const fillRequired = async () => {
    // text/number inputs: fill empties with a sane value
    const inputs = await page.locator('input:visible').elementHandles();
    for (const el of inputs) {
      const type = (await el.getAttribute('type')||'text').toLowerCase();
      if (['hidden','submit','button','radio','checkbox','image','file'].includes(type)) continue;
      const val = await el.inputValue().catch(()=> '');
      if (val) continue;
      const name = ((await el.getAttribute('name'))||(await el.getAttribute('id'))||'').toLowerCase();
      let v = '0';   // safe default for count fields (e.g. Childrenh) — 100 fails validation
      if (/_month|(^|[^a-z])month/.test(name)) v = '6';
      else if (/birth|_year|dob/.test(name)) v = '1980';   // birth year -> adult
      else if (/year/.test(name)) v = '2026';
      else if (/zip/.test(name)) v = '60601';
      else if (/age/.test(name)) v = '40';
      else if (/hour/.test(name)) v = '40';
      else if (/wage|pay|income|amount|earn|month.*amount/.test(name)) v = '1500';
      else if (/nick/.test(name)) v = 'WAFTEST-A12a-20260617';   // tagged: clearly-synthetic session
      else if (type==='text' && /name|first|last/.test(name)) v = 'WAFTEST';
      await el.fill(v).catch(()=>{});
    }
    // selects: choose first non-empty option
    const sels = await page.locator('select:visible').elementHandles();
    for (const el of sels) {
      const opts = await el.$$eval('option', os => os.map(o=>({v:o.value,t:o.textContent})));
      const pick = opts.find(o=>o.v && o.v!=='-1' && o.v!=='0' && o.v.trim()!=='');
      if (pick) await el.selectOption(pick.v).catch(()=>{});
    }
    // first radio in each name-group
    const radios = await page.locator('input[type=radio]:visible').elementHandles();
    const seen = new Set();
    for (const el of radios) {
      const n = (await el.getAttribute('name'))||'';
      if (seen.has(n)) continue; seen.add(n);
      await el.check().catch(()=>{});
    }
  };

  const advance = async () => {
    const sels = [
      'a:has-text("Get Started")','button:has-text("Get Started")',
      'a:has-text("Continue")','button:has-text("Continue")','input[value*="Continue" i]',
      'a:has-text("Next")','button:has-text("Next")','input[value*="Next" i]',
      'a:has-text("See Results")','a:has-text("Results")','button:has-text("Results")',
      'a:has-text("Finish")','.nav-next','a.next',
      'input[type=submit]:visible','button[type=submit]:visible'
    ];
    for (const s of sels) {
      const loc = page.locator(s).first();
      if (await loc.count() && await loc.isVisible().catch(()=>false)) { await loc.click({timeout:5000}).catch(()=>{}); return s; }
    }
    return null;
  };

  let lastScreen='', stall=0;
  for (let i=1;i<=MAXSTEPS;i++){
    await page.waitForLoadState('domcontentloaded',{timeout:20000}).catch(()=>{});
    const url = page.url();
    const screen = (url.match(/[?&]screen=([^&]+)/)||[])[1] || (url.split('/').pop()||'').split('?')[0];
    const heading = ((await page.locator('h1,h2,legend').first().textContent().catch(()=>''))||'').trim().slice(0,60);
    console.log(`step ${i}: screen=${screen}  "${heading}"`);
    if (/res_summary|results|next_steps/i.test(url)) { console.log('REACHED RESULTS'); break; }
    if (screen===lastScreen){ stall++; } else { stall=0; lastScreen=screen; }
    if (stall>=2){
      const errs = await page.locator('.error,.validation,.field-validation-error,[class*=error]').allTextContents().catch(()=>[]);
      console.log('  STALLED on',screen,'- validation:',errs.filter(x=>x.trim()).slice(0,5));
      break;
    }
    await fillRequired();
    const clicked = await advance();
    if (!clicked) { console.log('no advance control found; stopping'); break; }
    await page.waitForTimeout(400);
    // in-page confirmation modal variant of the soft-asserts ("continue anyway" / "yes")
    for (const s of ['.modal:visible a:has-text("Continue anyway")','.modal:visible button:has-text("Continue anyway")','.modal:visible button:has-text("Yes")','.modal:visible a:has-text("Yes")','.modal:visible button:has-text("Continue")']) {
      const m = page.locator(s).first();
      if (await m.count() && await m.isVisible().catch(()=>false)) { console.log('  modal-confirm:', s); await m.click().catch(()=>{}); break; }
    }
    await page.waitForLoadState('networkidle',{timeout:20000}).catch(()=>{});
  }

  const t1 = new Date().toISOString();
  console.log('END', t1);
  console.log('TOTAL /planning requests this walk:', planning.length);
  console.log('vs limits: PlanningRate 300 / Rate 500 — one walk should be far under');
  await browser.close();
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
