// Windows-fires / no-new-FP — IN-SESSION variant via Playwright.
// Establishes a real estimator session (post-redirect), injects payloads into a
// text field (nickname) and POSTs in-session -> exercises the _BODY rules + the
// real __VIEWSTATE body. Tests whether WAF body-inspection (first ~8KB) actually
// sees field values that sit after a large ViewState. Per-payload distinct UA for
// telemetry attribution. Count mode: nothing blocks.
const { chromium } = require('C:/svn/f8/f8/node_modules/playwright-core');
const ENTRY = 'https://preview2-il.db101.org/planning/b2w2_il_index.aspx';
const PAYLOADS = [
  ['inj_amp_whoami', '& whoami'],          // operator+command -> AWS-Windows fired NAKED; does it fire in-session body?
  ['inj_pipe_dir',   '| dir'],             // pipe injection
  ['inj_sqli_taut',  "1' OR '1'='1"],      // -> AWS-SQLi (body)
  ['fp_obrien',      "O'Brien"],           // legit apostrophe -> must NOT match
  ['fp_lt_amp',      'earnings < $2000 & rent > $800'],   // legit <,>,& -> must NOT match
  ['fp_sqlwords',    'select a plan or drop coverage union'], // legit SQL-ish words -> must NOT match
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  for (const [label, value] of PAYLOADS) {
    const ctx = await browser.newContext({ userAgent: `EFW-WAFTEST-insess-${label}` });
    const page = await ctx.newPage();
    page.on('dialog', d => d.accept().catch(()=>{}));
    let postBytes = 0, postCount = 0;
    page.on('request', r => { if (r.method()==='POST' && r.url().includes('/planning/')) { const b=r.postData()||''; postBytes=Math.max(postBytes,b.length); postCount++; } });
    try {
      await page.goto(ENTRY, { waitUntil:'networkidle', timeout:30000 });
      const click = async t => { const l=page.locator(`a:has-text("${t}"),button:has-text("${t}"),input[value*="${t}" i]`).first(); if(await l.count()){await l.click().catch(()=>{}); await page.waitForLoadState('networkidle',{timeout:20000}).catch(()=>{});} };
      await click('Get Started');
      await page.fill('input[name*="_month"]','6').catch(()=>{});
      await page.fill('input[name*="_year"]','1980').catch(()=>{});
      for (const g of ['Citizenship_statusb','Disability_determinationb']){ const r=page.locator(`input[name*="${g}"]`).first(); if(await r.count()) await r.check().catch(()=>{}); }
      await click('Continue');           // -> sess_pre_benefits
      await click('Continue');           // -> sess_house2
      const nick = page.locator('input[name*="Nickname" i]').first();
      if (await nick.count()) await nick.fill(value).catch(()=>{});
      const child = page.locator('input[name*="Childrenh" i]').first();
      if (await child.count()) await child.fill('0').catch(()=>{});
      await click('Continue');           // <-- in-session POST carrying the payload in the body
      const screen = (page.url().match(/screen=([^&]+)/)||[])[1]||'?';
      console.log(`${label.padEnd(16)} posted "${value}"  ->screen=${screen}  postBodyMax=${postBytes}B posts=${postCount}`);
    } catch(e){ console.log(`${label}: ERR ${e.message}`); }
    await ctx.close();
  }
  await browser.close();
  console.log('DONE in-session injection');
})().catch(e=>{console.error('FATAL',e.message);process.exit(1);});
