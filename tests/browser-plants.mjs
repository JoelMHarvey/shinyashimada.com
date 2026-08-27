import { chromium } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
page.on('console', m => { if (m.type()==='error' && !/fonts\.|ERR_CONNECTION_RESET/.test(m.text())) errs.push(m.text()); });

// No backend configured -> app should open directly in local mode.
await page.route('**/api/store*', r => r.fulfill({ status:200, contentType:'application/json',
  body: JSON.stringify({ ok:true, database:false, authRequired:false }) }));
await page.route('**/api/weather*', r => r.fulfill({ status:200, contentType:'application/json',
  body: JSON.stringify({ ok:true, current:{temperature_2m:33,weather_code:0}, daily:{}, advisories:[{key:'heat',severity:'high',value:35}] }) }));

await page.goto('http://127.0.0.1:8899/plants/', { waitUntil:'networkidle' });
await page.waitForTimeout(700);

const fails = [];
const t = async (name, fn) => { try { const r = await fn(); if (r !== true) fails.push(`${name}: ${r}`); } catch(e){ fails.push(`${name}: threw ${e.message}`);} };

await t('app opens unlocked when no passcode is configured', async () =>
  await page.isVisible('#app') && !(await page.isVisible('#lock')) ? true : 'lock screen shown');

await t('empty state shown initially', async () =>
  (await page.textContent('#grid-empty')).includes('No plants yet') ? true : 'no empty state');

// Add a monstera
await page.click('#add-plant');
await page.waitForTimeout(250);
await page.selectOption('#f-species', 'monstera');
await page.fill('#f-name', 'Big one by the door');
await page.fill('#f-location', 'south rail');
await page.click('#editor-form button[type=submit]');
await page.waitForTimeout(500);

await t('plant card appears', async () => {
  const n = await page.locator('.plant-card').count();
  return n === 1 ? true : `${n} cards`;
});
await t('card shows the nickname', async () =>
  (await page.textContent('.plant-card')).includes('Big one by the door') ? true : 'nickname missing');
await t('never-watered plant is flagged as due', async () =>
  (await page.locator('.task-row').count()) >= 1 ? true : 'no attention row');
await t('stat tiles computed', async () =>
  (await page.textContent('#stats')).replace(/\s+/g,' ').includes('1') ? true : 'stats blank');

// Mark it watered from the attention list
await page.locator('.task-row button').first().click();
await page.waitForTimeout(500);
await t('watering clears that task', async () => {
  const rows = await page.locator('.task-row').allTextContents();
  return rows.every(r => !/Water\b/.test(r)) ? true : `still listed: ${rows.join(' | ')}`;
});

// Detail view
await page.click('.plant-card');
await page.waitForTimeout(400);
await t('detail shows care lines', async () =>
  (await page.locator('#detail .care-line').count()) >= 2 ? true : 'no care lines');
await t('detail shows species tip', async () =>
  (await page.locator('#detail .tip-box').count()) === 1 ? true : 'no tip');
await t('history logged the watering', async () =>
  (await page.textContent('#detail-body')).includes('Watered') ? true : 'no history entry');

// Japanese
await page.click('#detail [data-close]');
await page.waitForTimeout(200);
await page.evaluate(() => I18N.set('ja'));
await page.waitForTimeout(400);
await t('switches to Japanese', async () =>
  (await page.textContent('#app h1')).includes('ベランダ') ? true : 'heading not translated');
await t('species name localised on card', async () =>
  (await page.textContent('.plant-card')).includes('モンステラ') ? true : 'species not localised');

// Persistence across reload
await page.reload({ waitUntil:'networkidle' });
await page.waitForTimeout(700);
await t('plant survives a reload', async () =>
  (await page.locator('.plant-card').count()) === 1 ? true : 'lost after reload');

// Weather nudge: heat advisory should shorten the monstera summer interval
await t('heat advisory shortens watering interval', async () => {
  const gap = await page.evaluate(() => {
    const c = Care.create({ speciesById: { m: { water:{spring:7,rainy:7,summer:5,autumn:9,winter:14} } },
                            now: () => new Date('2026-08-15'), weatherFactor: () => 0.7 });
    return c.waterIntervalDays({ speciesId:'m', care:{} });
  });
  return gap === 4 ? true : `interval ${gap}`;
});

console.log(errs.length ? 'JS ERRORS:\n' + errs.map(e=>'  ! '+e).join('\n') : 'no JS errors');
console.log(fails.length ? 'FAILURES:\n' + fails.map(f=>'  ✗ '+f).join('\n') : '✓ all plant UI assertions passed');
await browser.close();
process.exit(fails.length || errs.length ? 1 : 0);
