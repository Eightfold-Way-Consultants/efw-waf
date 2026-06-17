// Drive the real homepage feedback form on preview2-il, submit (creates ONE test
// Teamwork ticket), capturing the /tw POST + reCAPTCHA behavior. Comment is benign
// but FP-flavored (legit scary free text) to double as a no-FP _BODY check.
const { chromium } = require('C:/svn/f8/f8/node_modules/playwright-core');
const HOME = 'https://preview2-il.db101.org/';
const COMMENT = "WAFTEST automated check please disregard. O'Brien household: earnings < $2000 & rent > $800; want to select a plan or drop coverage union.";
const EMAIL = 'waftest@eightfoldway.com';

(async () => {
  const b = await chromium.launch({ headless:true });
  const ctx = await b.newContext({ userAgent:'EFW-WAFTEST-feedback' });
  const page = await ctx.newPage();
  const tw = [];
  page.on('requestfinished', async req => { if(/\/tw\//.test(req.url())){ let s=null; try{const r=await req.response(); if(r)s=r.status();}catch{} tw.push({m:req.method(),url:req.url(),status:s,bodyLen:(req.postData()||'').length}); } });
  await page.goto(HOME,{waitUntil:'networkidle',timeout:40000});

  // 1) find feedback trigger
  console.log('-- candidate triggers --');
  const cands = await page.locator('a,button').evaluateAll(els => els.filter(e=>/feedback|comment|report|contact|problem|tell us/i.test((e.textContent||'')+(e.getAttribute('href')||'')+(e.getAttribute('aria-label')||''))).map(e=>((e.textContent||'').trim()||e.getAttribute('href')||e.getAttribute('aria-label')||'').slice(0,40)).slice(0,12));
  console.log(cands);
  let opened=false;
  for (const sel of ['a.social-button.feedback','a.feedback.dlgPop','a.social-button.feedback.dlgPop','.feedback.dlgPop']) {
    const l = page.locator(sel).first();
    if (await l.count()) { console.log('clicking trigger:', sel); await l.click().catch(()=>{}); opened=true; break; }
  }
  if(!opened) console.log('feedback trigger not found');
  await page.waitForTimeout(3500);  // modal opens + form injects

  // 2) locate the form — page or iframe
  const findCtx = async () => {
    if (await page.locator('[name=tbComment], textarea, .comment-form-3, .grecaptcha').count()) return page;
    for (const f of page.frames()) { try { if (await f.locator('[name=tbComment], textarea, .grecaptcha').count()) return f; } catch{} }
    return null;
  };
  const fctx = await findCtx();
  if(!fctx){ console.log('FORM NOT FOUND (page or frames). frames:', page.frames().map(f=>f.url().slice(0,50))); await b.close(); return; }
  console.log('form context:', fctx===page?'main page':'iframe '+fctx.url().slice(0,60));

  // 3) dump fields + recaptcha
  const fields = await fctx.locator('input,textarea,select').evaluateAll(els=>els.filter(e=>e.offsetParent!==null||e.getClientRects().length).map(e=>`${(e.type||e.tagName).toLowerCase()} name=${e.name||e.id||'?'}`).slice(0,20)).catch(()=>[]);
  console.log('-- fields --', fields);
  const hasCaptcha = await fctx.locator('.grecaptcha, iframe[src*="recaptcha"]').count();
  console.log('recaptcha present:', !!hasCaptcha);

  // 4) fill
  for (const [sel,val] of [['[name=tbEmail]',EMAIL],['input[type=email]',EMAIL],['[name=tbComment]',COMMENT],['textarea',COMMENT]]) {
    const l=fctx.locator(sel).first(); if(await l.count()){ await l.fill(val).catch(()=>{}); }
  }

  // 5) reCAPTCHA — try the v2 checkbox in the anchor frame
  let token='';
  try {
    const af = page.frames().find(f=>/recaptcha\/api2\/anchor/.test(f.url()));
    if (af) { const cb=af.locator('#recaptcha-anchor'); if(await cb.count()){ await cb.click().catch(()=>{}); await page.waitForTimeout(3000); } }
    token = await fctx.evaluate(()=>{ try{return (window.grecaptcha&&window.grecaptcha.getResponse&&window.grecaptcha.getResponse())||'';}catch{return '';} }).catch(()=>'');
  } catch{}
  const bframe = page.frames().find(f=>/recaptcha\/api2\/bframe/.test(f.url()));
  const challengeShown = bframe ? await bframe.locator('.rc-imageselect, #rc-imageselect').count().catch(()=>0) : 0;
  console.log('recaptcha token len:', token.length, ' image-challenge shown:', !!challengeShown);

  // 6) submit (only meaningful if we have a token; try anyway to observe)
  const sub = fctx.locator('[name=rsubmit], [type=submit], button:has-text("Submit"), a:has-text("Submit")').first();
  if (await sub.count()) { console.log('clicking submit'); await sub.click().catch(()=>{}); await page.waitForTimeout(4000); }
  else console.log('no submit control found');

  console.log('-- /tw requests captured --');
  tw.forEach(r=>console.log(`  ${r.m} ${r.status} body~${r.bodyLen}B ${r.url.replace(/https:\/\/[^/]+/,'')}`));
  if(!tw.length) console.log('  (no /tw POST fired — blocked client-side, likely captcha)');
  await b.close();
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
