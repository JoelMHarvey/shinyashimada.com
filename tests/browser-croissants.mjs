import { chromium } from 'playwright';
const b = await chromium.launch(); const ctx = await b.newContext(); const page = await ctx.newPage();
const errs=[]; page.on('pageerror',e=>errs.push(e.message));
page.on('console',m=>{if(m.type()==='error'&&!/fonts\.|ERR_CONNECTION_RESET/.test(m.text()))errs.push(m.text())});
await page.route('**/api/store*', r=>r.fulfill({status:200,contentType:'application/json',body:'{"ok":true,"database":false,"authRequired":false,"records":[]}'}));
await page.goto('http://127.0.0.1:8899/croissants/',{waitUntil:'networkidle'});
await page.waitForTimeout(700);
const fails=[]; const t=async(n,f)=>{try{const r=await f(); if(r!==true) fails.push(`${n}: ${r}`);}catch(e){fails.push(`${n}: threw ${e.message}`)}};

await t('shortlist renders', async()=>{const n=await page.locator('.bakery-card').count(); return n===15?true:`${n} cards`;});
await t('nothing pre-rated', async()=>{const n=await page.locator('.score-badge').count(); return n===0?true:`${n} scores shown before any tasting`;});
await t('leaderboard empty state', async()=> (await page.textContent('#leaderboard')).includes('Nothing tasted yet')?true:'no empty state');

async function record(bakery, vals, price){
  await page.click('#add-tasting'); await page.waitForTimeout(250);
  await page.selectOption('#t-bakery', bakery);
  await page.fill('#t-price', String(price));
  const ids = await page.evaluate(()=>[...document.querySelectorAll('#t-scores input[type=range]')].map(i=>i.id));
  for (let i=0;i<ids.length;i++){ await page.locator('#'+ids[i]).fill(String(vals[i])); }
  await page.click('#taster-form button[type=submit]'); await page.waitForTimeout(450);
}
await record('viron', [9,8,9,8,8,6], 420);
await t('leaderboard chart appears', async()=> (await page.locator('#leaderboard svg').count())===1?true:'no chart');
await t('score badge on card', async()=> (await page.locator('.score-badge').count())===1?true:'no badge');
await t('rank medal for first place', async()=> (await page.locator('.rank-medal').count())===1?true:'no medal');
// weighted: (9*1.2 + 8*1.2 + 9*1.1 + 8 + 8 + 6*0.8) / 6.3 = 51.1/6.3 = 8.11 -> 8.1
await t('weighted score is correct', async()=>{const v=await page.textContent('.score-badge b'); return v==='8.1'?true:`got ${v}`;});
await t('table twin exists', async()=> (await page.locator('#leaderboard .viz-table table').count())===1?true:'no table view');

await record('comme-n', [10,9,9,9,9,5], 520);
await t('two bakeries ranked', async()=> (await page.locator('#leaderboard .viz-bar').count())===2?true:'wrong bar count');

// Compare via the visible per-card button
await page.locator('.bakery-card button', {hasText:'Compare'}).nth(0).click(); await page.waitForTimeout(250);
await page.locator('.bakery-card button', {hasText:'Compare'}).nth(0).click(); await page.waitForTimeout(400);
await t('compare chart appears with 2 series', async()=>{
  const hidden = await page.locator('#compare-card').getAttribute('class');
  if (hidden.includes('hidden')) return 'compare card hidden';
  const legend = await page.locator('#compare-chart .viz-legend span').count();
  return legend===2?true:`${legend} legend entries`;
});
await t('compare legend labels both bakeries', async()=>{
  const txt = await page.textContent('#compare-chart .viz-legend');
  return /VIRON/.test(txt) && /Comme/.test(txt) ? true : `legend: ${txt}`;
});
await t('filter to "to try" hides tasted', async()=>{
  await page.locator('#filter-status button').nth(2).click(); await page.waitForTimeout(300);
  const n = await page.locator('.bakery-card').count(); return n===13?true:`${n} cards`;
});
await page.locator('#filter-status button').nth(0).click(); await page.waitForTimeout(250);

// Spanish
await page.evaluate(()=>I18N.set('es')); await page.waitForTimeout(400);
await t('spanish criteria labels', async()=>{
  const txt = await page.textContent('#compare-chart .viz-table');
  return /Laminado/.test(txt) ? true : 'criteria not translated';
});
await page.reload({waitUntil:'networkidle'}); await page.waitForTimeout(700);
await t('tastings persist', async()=> (await page.locator('.score-badge').count())===2?true:'lost on reload');

console.log(errs.length?'JS ERRORS:\n'+errs.map(e=>'  ! '+e).join('\n'):'no JS errors');
console.log(fails.length?'FAILURES:\n'+fails.map(f=>'  ✗ '+f).join('\n'):'✓ all croissant assertions passed');
await b.close(); process.exit(fails.length||errs.length?1:0);
