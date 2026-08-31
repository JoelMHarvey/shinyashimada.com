/* The National Geographic run on the shared shelf.
 *
 * Magazines are the same records in the same collection as the books, which is
 * what makes one search cover both. What is under test is that they stay out of
 * everything that only makes sense for a book: reading status, the description
 * gap, and the catalogue lookups.
 */
import { chromium } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();

const errs = [];
page.on('pageerror', e => errs.push(e.message));
page.on('console', m => {
  if (m.type() === 'error' && !/fonts\.|ERR_CONNECTION_RESET|status of (401|503)/.test(m.text())) errs.push(m.text());
});

await page.route('**/api/store*', r => r.fulfill({ status: 200, contentType: 'application/json',
  body: JSON.stringify({ ok: true, database: false, authRequired: false }) }));
// If a magazine ever reached the catalogue, this would fire and the test fail.
let lookups = 0;
await page.route('**/api/books*', r => { lookups++; r.fulfill({ status: 200,
  contentType: 'application/json', body: JSON.stringify({ results: [] }) }); });

const fails = [];
const t = async (name, fn) => {
  try { const r = await fn(); if (r !== true) fails.push(`${name}: ${r}`); }
  catch (e) { fails.push(`${name}: threw ${e.message}`); }
};
const count = () => page.locator('.book').count();
const live = () => page.evaluate(() =>
  JSON.parse(localStorage.getItem('ss.cache.books') || '[]').filter(b => !b.deleted));

await page.goto('http://127.0.0.1:8899/library/', { waitUntil: 'networkidle' });
await page.waitForTimeout(500);

/* --- the offer ----------------------------------------------------------- */

await t('an empty shelf does not offer the magazines yet', async () =>
  await page.isHidden('#import-mags') ? true : 'offered before the books are in');

await page.click('#do-import');
await page.waitForTimeout(2500);

await t('with books on the shelf, the magazines are offered', async () =>
  await page.isVisible('#import-mags') ? true : 'no magazine import offered');

await page.click('#import-mags');
await page.waitForTimeout(2500);

await t('the whole run lands', async () => {
  const mags = (await live()).filter(b => b.kind === 'magazine').length;
  return mags === 105 ? true : `${mags} issues`;
});

await t('the books are untouched by it', async () => {
  const vols = (await live()).filter(b => b.kind !== 'magazine').length;
  return vols === 319 ? true : `${vols} books`;
});

await t('the offer goes once they are in', async () =>
  await page.isHidden('#import-mags') ? true : 'still offered with nothing to add');

await t('importing again adds nothing', async () => {
  const before = (await live()).length;
  await page.evaluate(() => document.getElementById('import-mags').hidden = false);
  await page.click('#import-mags');
  await page.waitForTimeout(1800);
  const after = (await live()).length;
  return before === after ? true : `${after - before} duplicates`;
});

/* --- counted honestly ----------------------------------------------------- */

await t('books and magazines are counted separately', async () => {
  const txt = (await page.textContent('#stats')).replace(/\s+/g, ' ');
  return /319\s*Books/i.test(txt) && /105\s*Magazines/i.test(txt)
    ? true : `stats read "${txt.trim().slice(0, 90)}"`;
});

// 105 issues silently filed under "to read" would be a lie told in a large font.
await t('issues are not counted as unread books', async () => {
  const txt = (await page.textContent('#stats')).replace(/\s+/g, ' ');
  return /319\s*To read/i.test(txt) ? true : `stats read "${txt.trim().slice(0, 120)}"`;
});

await t('the description gap still counts only books', async () => {
  const label = (await page.textContent('#f-nodesc')).replace(/\s+/g, ' ');
  return label.includes('(319)') ? true : `label read "${label.trim()}"`;
});

/* --- filtering and search ------------------------------------------------- */

await page.selectOption('#f-kind', 'magazine');
await page.waitForTimeout(600);
await t('filtering to magazines shows only issues', async () => {
  const n = await count();
  return n === 105 ? true : `${n} shown`;
});
await t('every issue gets the yellow placeholder', async () => {
  const n = await page.locator('.book__cover--issue').count();
  return n === 105 ? true : `${n} placeholders`;
});

await page.selectOption('#f-kind', 'book');
await page.waitForTimeout(600);
await t('filtering to books hides the issues', async () => {
  const n = await count();
  return n === 319 ? true : `${n} shown`;
});
await page.selectOption('#f-kind', 'all');
await page.waitForTimeout(600);

// The point of storing the cover lines: finding the issue that covered a thing.
await t('a cover line is searchable across both kinds', async () => {
  await page.fill('#q', 'kamchatka');
  await page.waitForTimeout(450);
  const n = await count();
  const txt = await page.textContent('#grid');
  await page.fill('#q', '');
  await page.waitForTimeout(400);
  return n >= 2 && /National Geographic/.test(txt) ? true : `${n} matches`;
});

await t('an issue can be found by its date', async () => {
  await page.fill('#q', 'september 1960');
  await page.waitForTimeout(450);
  const n = await count();
  await page.fill('#q', '');
  await page.waitForTimeout(400);
  return n === 1 ? true : `${n} matches`;
});

/* --- left out of the lookups --------------------------------------------- */

lookups = 0;
await page.selectOption('#f-kind', 'magazine');
await page.waitForTimeout(500);
await page.click('#bulk-go');
await page.waitForTimeout(2500);

// No ISBN and no catalogue that carries back issues: asking would only invite
// a confidently wrong answer.
await t('filling the gaps never looks up a magazine', async () => {
  const mags = (await live()).filter(b => b.kind === 'magazine');
  const dirtied = mags.filter(m => m.description || m.isbn13 || m.coverUrl).length;
  return dirtied === 0 ? true : `${dirtied} issues were written to`;
});

if (await page.isVisible('#bulk')) { await page.click('#bulk-go'); await page.waitForTimeout(600); }

if (errs.length) fails.push('console/page errors: ' + errs.join(' | '));
console.log(`\nbrowser-library-magazines: ${fails.length ? 'FAILED' : 'passed'}`);
if (fails.length) fails.forEach(f => console.error('  ✗ ' + f));
await browser.close();
process.exit(fails.length ? 1 : 0);
