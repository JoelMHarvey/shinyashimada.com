/* Importing the plant inventory.
 *
 * The point of the balcony page is the care schedule, and a plant only gets one
 * by being matched to a species. So what is under test is the matching: that
 * the plants the inventory was sure about get a real schedule, and that the
 * ones it was not sure about get no feeding or pruning dates rather than a
 * confident schedule for the wrong plant.
 */
import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();

const errs = [];
page.on('pageerror', e => errs.push(e.message));
page.on('console', m => {
  if (m.type() === 'error' && !/fonts\.|ERR_|status of (401|404|503)/.test(m.text())) errs.push(m.text());
});
for (const route of ['**/api/store*', '**/api/weather*', '**/api/camera*', '**/api/trello*']) {
  await page.route(route, r => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, database: false, authRequired: false }) }));
}

const fails = [];
const t = async (name, fn) => {
  try { const r = await fn(); if (r !== true) fails.push(`${name}: ${r}`); }
  catch (e) { fails.push(`${name}: threw ${e.message}`); }
};
const live = () => page.evaluate(() =>
  JSON.parse(localStorage.getItem('ss.cache.plants') || '[]').filter(p => !p.deleted));

await page.goto('http://127.0.0.1:8899/plants/', { waitUntil: 'networkidle' });
await page.waitForTimeout(700);

await t('an empty balcony offers the inventory', async () =>
  await page.isVisible('#seed-go') ? true : 'no import offered');

await page.click('#seed-go');
await page.waitForTimeout(2500);

await t('the whole inventory lands', async () => {
  const n = (await live()).length;
  return n === 25 ? true : `${n} plants`;
});

await t('the settled identifications get a species', async () => {
  const n = (await live()).filter(p => p.speciesId).length;
  return n === 19 ? true : `${n} matched`;
});

// The six the sheet was unsure about. Guessing a species for these would put a
// confident watering and pruning date against the wrong plant.
await t('the unsure ones are left unmatched, and are the right six', async () => {
  const ids = (await live()).filter(p => !p.speciesId).map(p => p.inventoryId).sort();
  const want = ['P005', 'P008', 'P019', 'P020', 'P024', 'P025'];
  return ids.join(',') === want.join(',') ? true : `unmatched: ${ids.join(',')}`;
});

await t('an unmatched plant keeps the name the sheet gave it', async () => {
  const p = (await live()).find(x => x.inventoryId === 'P019');
  return p && p.customSpecies === 'Conifer, species uncertain'
    ? true : `customSpecies is ${JSON.stringify(p && p.customSpecies)}`;
});

await t('nothing from the spreadsheet was dropped', async () => {
  const p = (await live()).find(x => x.inventoryId === 'P016');
  const n = p && p.notes || '';
  return /Condition:/.test(n) && /Pot:/.test(n) && /Medium:/.test(n)
    ? true : `notes read "${n.slice(0, 80)}"`;
});

await t('a low-confidence identification says so on the record', async () => {
  const p = (await live()).find(x => x.inventoryId === 'P008');
  return /confidence: low/i.test(p.notes || '') ? true : `notes read "${(p.notes || '').slice(0, 80)}"`;
});

// Fertiliser in the pot kills a carnivorous plant, so the absence of the
// reminder is the feature.
await t('the pitcher plant is never prompted to feed', async () => {
  const sp = await page.evaluate(async () =>
    (await (await fetch('/data/species.json')).json()).species.find(s => s.id === 'nepenthes'));
  return sp && sp.fertiliseDays === 0 && sp.fertiliseSeasons.length === 0
    ? true : `fertiliseDays=${sp && sp.fertiliseDays}`;
});

await t('every species a plant points at actually exists', async () => {
  const ids = new Set((await page.evaluate(async () =>
    (await (await fetch('/data/species.json')).json()).species.map(s => s.id))));
  const missing = (await live()).filter(p => p.speciesId && !ids.has(p.speciesId))
    .map(p => p.speciesId);
  return missing.length === 0 ? true : `dangling: ${JSON.stringify(missing)}`;
});

await t('the balcony shows a card per plant', async () =>
  (await page.locator('.plant-card, .plant').count()) === 25
    ? true : `${await page.locator('.plant-card, .plant').count()} cards`);

// Importing over an existing balcony must not overwrite what is there.
await t('importing again adds nothing', async () => {
  const before = (await live()).length;
  await page.click('#menu-btn');
  await page.waitForTimeout(400);
  await page.click('#do-seed');
  await page.waitForTimeout(2000);
  const after = (await live()).length;
  return before === after ? true : `${after - before} duplicates`;
});

if (errs.length) fails.push('console/page errors: ' + errs.join(' | '));
console.log(`\nbrowser-plants-seed: ${fails.length ? 'FAILED' : 'passed'}`);
if (fails.length) fails.forEach(f => console.error('  ✗ ' + f));
await browser.close();
process.exit(fails.length ? 1 : 0);
