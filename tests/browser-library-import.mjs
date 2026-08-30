/* Importing the shelf inventory, and filling its gaps from the catalogues.
 *
 * /api/books is stubbed with a catalogue that answers for one real title and
 * offers a plausible-but-wrong book for anything else, so the title guard is
 * exercised rather than assumed. */
import { chromium } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
page.on('console', m => { if (m.type()==='error' && !/fonts\.|ERR_CONNECTION_RESET|status of (401|503)/.test(m.text())) errs.push(m.text()); });

await page.route('**/api/store*', r => r.fulfill({ status:200, contentType:'application/json',
  body: JSON.stringify({ ok:true, database:false, authRequired:false }) }));

let lookups = 0;
await page.route('**/api/books*', r => {
  lookups++;
  const q = decodeURIComponent(new URL(r.request().url()).searchParams.get('q') || '');
  // Only "Bagombo Snuff Box" is answered honestly. Everything else gets a
  // real book with a different title — which the client must reject.
  const hit = /bagombo/i.test(q)
    ? { title:'Bagombo Snuff Box', authors:['Kurt Vonnegut'], publisher:'Putnam',
        publishedYear:1999, pages:295, isbn13:'9780399144509',
        description:'Twenty-three short stories.', coverUrl:'https://covers.example/b.jpg' }
    : { title:'A Completely Different Book', authors:['Nobody At All'], publisher:'Wrong Press',
        publishedYear:1234, pages:1, description:'Should never be written to a record.' };
  r.fulfill({ status:200, contentType:'application/json', body: JSON.stringify({ results:[hit] }) });
});
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
await page.route('https://covers.example/**', r => r.fulfill({ status:200, contentType:'image/png', body: PNG }));

await page.goto('http://127.0.0.1:8899/library/', { waitUntil:'networkidle' });
await page.waitForTimeout(600);

const fails = [];
const t = async (name, fn) => { try { const r = await fn(); if (r !== true) fails.push(`${name}: ${r}`); } catch(e){ fails.push(`${name}: threw ${e.message}`);} };
const count = () => page.locator('.book').count();

/* --- import -------------------------------------------------------------- */

await t('empty shelf offers the import', async () =>
  await page.isVisible('#do-import') ? true : 'no import button');

await page.click('#do-import');
await page.waitForTimeout(2500);

await t('the whole inventory lands', async () => {
  const n = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('ss.cache.books') || '[]').filter(b => !b.deleted).length);
  return n === 319 ? true : `${n} books`;
});

await t('shelf summary counts them', async () =>
  (await page.textContent('#stats')).replace(/\s+/g,' ').includes('319') ? true : 'stats wrong');

await t('a known title is on the shelf', async () => {
  await page.fill('#q', 'bagombo');
  await page.waitForTimeout(350);
  const n = await count();
  await page.fill('#q', ''); await page.waitForTimeout(350);
  return n === 1 ? true : `${n} matches`;
});

await t('the row whose title sat in the author column was recovered', async () => {
  await page.fill('#q', 'koran');
  await page.waitForTimeout(350);
  const txt = await page.textContent('#grid').catch(() => '');
  await page.fill('#q', ''); await page.waitForTimeout(350);
  return txt.includes('The Koran') ? true : 'The Koran missing';
});

/* --- confidence ---------------------------------------------------------- */

await t('the needs-checking filter appears with a count', async () => {
  const label = await page.textContent('#f-check');
  return label.includes('57') ? true : `label was "${label.trim()}"`;
});

await page.click('#f-check');
await page.waitForTimeout(500);
await t('filtering to needs-checking narrows the shelf', async () => {
  const n = await count();
  return n === 57 ? true : `${n} shown`;
});
await t('every one of them is marked', async () => {
  const cards = await page.locator('.book').count();
  const chips = await page.locator('.book .chip--danger').count();
  return cards === chips ? true : `${chips} chips for ${cards} cards`;
});
await page.click('#f-check');
await page.waitForTimeout(500);

/* --- the description gap ------------------------------------------------- */

// The seeded inventory has no blurbs at all: none was in the source, and none
// was invented. The whole shelf is the gap, which is the point of the filter.

await t('the no-description filter counts the whole shelf', async () => {
  const label = (await page.textContent('#f-nodesc')).replace(/\s+/g, ' ').trim();
  return label.includes('(319)') ? true : `label read "${label}"`;
});

await page.click('#f-nodesc');
await page.waitForTimeout(500);
await t('filtering to it shows all of them', async () => {
  const n = await count();
  return n === 319 ? true : `${n} shown`;
});
await t('and none of the cards carries a snippet yet', async () =>
  (await page.locator('.book .book__desc').count()) === 0 ? true : 'a blurb appeared from nowhere');
await page.click('#f-nodesc');
await page.waitForTimeout(500);

/* --- shelves ------------------------------------------------------------- */

await t('the shelf filter is populated from the data', async () => {
  const n = await page.locator('#f-shelf option').count();
  return n === 22 ? true : `${n} options (21 shelves + All)`;   // 21 distinct locations
});
await page.selectOption('#f-shelf', 'Bookcase 2 – Shelf 1');
await page.waitForTimeout(450);
await t('filtering by shelf works', async () => {
  const n = await count();
  return n === 29 ? true : `${n} on that shelf`;
});
await page.selectOption('#f-shelf', 'all');
await page.waitForTimeout(450);

/* --- re-import is a no-op ------------------------------------------------ */

await page.fill('#q', 'zzzz-nothing-matches-this');
await page.waitForTimeout(400);
await t('a filtered empty state does not offer the import', async () =>
  !(await page.isVisible('#do-import')) ? true : 'import offered while filtered');
await page.fill('#q', '');
await page.waitForTimeout(400);

/* --- bulk gap filling ---------------------------------------------------- */

lookups = 0;
await page.click('#bulk-go');
await page.waitForTimeout(900);
await t('a progress bar appears while running', async () =>
  await page.isVisible('#bulk') ? true : 'no progress bar');
await t('the button becomes a stop', async () =>
  (await page.textContent('#bulk-go')).trim() === 'Stop' ? true : await page.textContent('#bulk-go'));

// Let a handful of lookups happen, then stop it.
await page.waitForTimeout(2200);
await page.click('#bulk-go');
await page.waitForTimeout(900);

await t('stopping ends the run', async () =>
  !(await page.isVisible('#bulk')) ? true : 'still running');
await t('it did make lookups', async () => lookups > 3 ? true : `${lookups} lookups`);
await t('it reported stopping', async () =>
  /Stopped after/.test(await page.textContent('.toast-host')) ? true : await page.textContent('.toast-host'));

await t('the honest match was written', async () => {
  const b = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('ss.cache.books') || '[]')
      .find(x => x.title === 'Bagombo Snuff Box'));
  return b && b.publisher === 'Putnam' && b.publishedYear === 1999
    ? true : `got ${JSON.stringify(b && { p: b.publisher, y: b.publishedYear })}`;
});

await t('the filled blurb comes off the no-description count', async () => {
  const label = (await page.textContent('#f-nodesc')).replace(/\s+/g, ' ').trim();
  const m = label.match(/\((\d+)\)/);
  if (!m) return `no count in "${label}"`;
  return Number(m[1]) < 319 ? true : 'count did not move after a blurb was written';
});

await t('the mismatched titles were refused', async () => {
  const bad = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('ss.cache.books') || '[]')
      .filter(x => x.publisher === 'Wrong Press').length);
  return bad === 0 ? true : `${bad} records took the wrong book`;
});

await t('nothing was invented for books the catalogue could not match', async () => {
  const invented = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('ss.cache.books') || '[]')
      .filter(x => x.publishedYear === 1234).length);
  return invented === 0 ? true : `${invented} records`;
});

/* ------------------------------------------------------------------------- */

if (errs.length) fails.push('console/page errors: ' + errs.join(' | '));
console.log(`\nbrowser-library-import: ${fails.length ? 'FAILED' : 'passed'}`);
if (fails.length) fails.forEach(f => console.error('  ✗ ' + f));
await browser.close();
process.exit(fails.length ? 1 : 0);
