import { chromium } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
// Optional endpoints answer 503 when unconfigured and the page handles it;
// the browser still logs a console error for the response itself.
page.on('console', m => { if (m.type()==='error' && !/fonts\.|ERR_CONNECTION_RESET|status of (401|503)/.test(m.text())) errs.push(m.text()); });

// No backend configured -> app should open directly in local mode.
await page.route('**/api/store*', r => r.fulfill({ status:200, contentType:'application/json',
  body: JSON.stringify({ ok:true, database:false, authRequired:false }) }));
  // Netlify-only endpoints. Unrouted, the dev server leaves them pending and
  // `networkidle` never settles.
  await page.route('**/api/camera*', r => r.fulfill({ status: 503, contentType: 'application/json', body: '{"code":"no-camera"}' }));
  await page.route('**/api/trello*', r => r.fulfill({ status: 503, contentType: 'application/json', body: '{"code":"no-trello"}' }));
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

// Photo upload: attach a generated image; expect editor preview, card
// thumbnail, detail photo, and a synced record that fits the 64 KB row.
await page.click('.plant-card');
await page.waitForTimeout(300);
await page.click('#detail-edit');
await page.waitForTimeout(300);
const pngB64 = await page.evaluate(() => {
  const c = document.createElement('canvas'); c.width = 800; c.height = 600;
  const g = c.getContext('2d');
  g.fillStyle = '#2f855a'; g.fillRect(0, 0, 800, 600);
  g.fillStyle = '#e8b04b'; g.beginPath(); g.arc(400, 300, 180, 0, 7); g.fill();
  return c.toDataURL('image/png').split(',')[1];
});
await page.setInputFiles('#f-photo', {
  name: 'plant.png', mimeType: 'image/png', buffer: Buffer.from(pngB64, 'base64')
});
await page.waitForTimeout(700);
await t('photo preview appears in editor', async () => {
  const src = await page.evaluate(() => document.getElementById('f-photo-preview').src || '');
  return src.startsWith('data:image/jpeg') ? true : 'no jpeg preview: ' + src.slice(0, 30);
});
await page.click('#editor-form button[type="submit"]');
await page.waitForTimeout(500);
await t('card shows the photo thumbnail', async () =>
  (await page.locator('.plant-card__photo').count()) === 1 ? true : 'no card photo');
await t('stored photo fits the record budget', async () => {
  const len = await page.evaluate(() => {
    const rows = JSON.parse(localStorage.getItem('ss.cache.plants') || '[]');
    const withPhoto = rows.find(r => r.photo);
    return withPhoto ? withPhoto.photo.length : -1;
  });
  return len > 0 && len <= 50000 ? true : 'photo length ' + len;
});
await page.click('.plant-card');
await page.waitForTimeout(400);
await t('detail shows the photo', async () =>
  (await page.locator('.detail__photo').count()) === 1 ? true : 'no detail photo');
await t('photo can be removed again', async () => {
  await page.click('#detail-edit');
  await page.waitForTimeout(300);
  await page.click('#f-photo-remove');
  await page.waitForTimeout(200);
  await page.click('#editor-form button[type="submit"]');
  await page.waitForTimeout(500);
  return (await page.locator('.plant-card__photo').count()) === 0 ? true : 'photo still on card';
});

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
