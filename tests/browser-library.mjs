/* The library page end to end: add by lookup, filter, rate, enrich, delete.
 *
 * /api/books is stubbed, so this exercises our handling of a catalogue
 * answer rather than the catalogues themselves. */
import { chromium } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
page.on('console', m => { if (m.type()==='error' && !/fonts\.|ERR_CONNECTION_RESET|status of (401|503)/.test(m.text())) errs.push(m.text()); });

// No backend configured -> the page opens straight into local mode.
await page.route('**/api/store*', r => r.fulfill({ status:200, contentType:'application/json',
  body: JSON.stringify({ ok:true, database:false, authRequired:false }) }));

let lastBooksQuery = null;
await page.route('**/api/books*', r => {
  lastBooksQuery = new URL(r.request().url()).search;
  r.fulfill({ status:200, contentType:'application/json', body: JSON.stringify({ results: [
    {
      title: 'Norwegian Wood',
      subtitle: 'A Novel',
      authors: ['Haruki Murakami'],
      publisher: 'Vintage',
      publishedYear: 2000,
      pages: 296,
      language: 'en',
      isbn13: '9780375704024',
      subjects: ['Fiction', 'Japan'],
      description: 'Toru recalls his student days in Tokyo.',
      coverUrl: 'https://covers.example/nw.jpg',
      sources: ['openlibrary', 'google']
    },
    { title: 'Norwegian Wood (a different edition)', authors: ['Haruki Murakami'], publishedYear: 2003 }
  ] }) });
});
// Cover images point at hosts this sandbox cannot reach; serve a real pixel so
// layout is exercised rather than the browser's broken-image path.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
await page.route('https://covers.example/**', r => r.fulfill({ status:200, contentType:'image/png', body: PNG }));

await page.goto('http://127.0.0.1:8899/library/', { waitUntil:'networkidle' });
await page.waitForTimeout(600);

const fails = [];
const t = async (name, fn) => { try { const r = await fn(); if (r !== true) fails.push(`${name}: ${r}`); } catch(e){ fails.push(`${name}: threw ${e.message}`);} };

await t('opens unlocked when no passcode is configured', async () =>
  await page.isVisible('#app') && !(await page.isVisible('#lock')) ? true : 'lock screen shown');

await t('empty state invites a first book', async () =>
  (await page.textContent('#empty')).includes('No books yet') ? true : 'no empty state');

await t('no raw i18n keys on the page', async () => {
  const txt = await page.textContent('#app');
  const raw = txt.match(/\b(lib|common|nav)\.[a-zA-Z.]+/g);
  return raw ? `untranslated: ${[...new Set(raw)].join(', ')}` : true;
});

/* --- add a book through the lookup ------------------------------------- */

await page.click('#add-book');
await page.waitForTimeout(250);
await page.fill('#lookup-input', 'norwegian wood murakami');
await page.click('#lookup-go');
await page.waitForTimeout(400);

await t('lookup lists both candidates', async () => {
  const n = await page.locator('#lookup-results .hit').count();
  return n === 2 ? true : `${n} hits`;
});
await t('lookup went out as a title search', async () =>
  /[?&]q=/.test(lastBooksQuery || '') ? true : `query was ${lastBooksQuery}`);

await page.locator('#lookup-results [data-use]').first().click();
await page.waitForTimeout(250);

await t('picking a hit fills the title', async () =>
  (await page.inputValue('#f-title')) === 'Norwegian Wood' ? true : await page.inputValue('#f-title'));
await t('…and the authors', async () =>
  (await page.inputValue('#f-authors')) === 'Haruki Murakami' ? true : 'authors not filled');
await t('…and the ISBN', async () =>
  (await page.inputValue('#f-isbn')) === '9780375704024' ? true : 'isbn not filled');
await t('…and the year', async () =>
  (await page.inputValue('#f-year')) === '2000' ? true : 'year not filled');
await t('…and the cover url', async () =>
  (await page.inputValue('#f-coverurl')).includes('nw.jpg') ? true : 'cover not filled');
await t('cover preview appears', async () => await page.isVisible('#f-cover-preview') ? true : 'preview hidden');

// Ours to say, not the catalogue's.
await page.selectOption('#f-owner-edit', 'shin');
await page.selectOption('#f-status-edit', 'reading');
await page.fill('#f-shelf-edit', 'Bedroom, top shelf');
await page.click('#editor-form button[type=submit]');
await page.waitForTimeout(500);

await t('a card appears', async () => {
  const n = await page.locator('.book').count();
  return n === 1 ? true : `${n} cards`;
});
await t('card shows the title', async () =>
  (await page.textContent('.book')).includes('Norwegian Wood') ? true : 'title missing');
await t('card shows the reading status', async () =>
  (await page.textContent('.book')).includes('Reading') ? true : 'status chip missing');
await t("card shows whose it is", async () =>
  (await page.textContent('.book')).includes("Shin's") ? true : 'owner chip missing');
await t('shelf summary counts it', async () =>
  (await page.textContent('#stats')).replace(/\s+/g,' ').includes('1') ? true : 'stats blank');

/* --- filters ------------------------------------------------------------ */

await page.selectOption('#f-owner', 'joel');
await page.waitForTimeout(250);
await t("filtering to Joel's hides Shin's book", async () =>
  (await page.locator('.book').count()) === 0 ? true : 'still shown');
await t('and offers a way out', async () =>
  await page.isVisible('#clear-filters') ? true : 'no clear-filters button');
await page.click('#clear-filters');
await page.waitForTimeout(250);
await t('clearing filters brings it back', async () =>
  (await page.locator('.book').count()) === 1 ? true : 'still hidden');

await page.fill('#q', 'murakami');
await page.waitForTimeout(320);
await t('search matches on author', async () =>
  (await page.locator('.book').count()) === 1 ? true : 'search missed the author');
await page.fill('#q', 'proust');
await page.waitForTimeout(320);
await t('search excludes non-matches', async () =>
  (await page.locator('.book').count()) === 0 ? true : 'unrelated match');
await page.fill('#q', '');
await page.waitForTimeout(320);

/* --- detail and enrichment --------------------------------------------- */

await page.click('.book');
await page.waitForTimeout(350);
await t('detail opens', async () => await page.isVisible('#detail') ? true : 'not open');
await t('detail shows the publisher', async () =>
  (await page.textContent('#detail-body')).includes('Vintage') ? true : 'publisher missing');
await t('detail shows the shelf', async () =>
  (await page.textContent('#detail-body')).includes('Bedroom, top shelf') ? true : 'shelf missing');
await t('detail shows the description', async () =>
  (await page.textContent('#detail-body')).includes('Toru recalls') ? true : 'description missing');

// Enrichment on a complete record should add nothing and say so.
await page.click('#detail-enrich');
await page.waitForTimeout(500);
await t('enriching a complete record looks it up by ISBN', async () =>
  /[?&]isbn=9780375704024/.test(lastBooksQuery || '') ? true : `query was ${lastBooksQuery}`);
await t('and reports there was nothing to add', async () =>
  (await page.textContent('.toast-host')).includes('already complete') ? true : await page.textContent('.toast-host'));

await page.click('#detail [data-close]');
await page.waitForTimeout(250);

/* --- enrichment fills a gap without overwriting ------------------------- */

// A sparse book, entered by hand with a note of our own.
await page.click('#add-book');
await page.waitForTimeout(250);
await page.fill('#f-title', 'Norwegian Wood');
await page.fill('#f-isbn', '9780375704024');
await page.fill('#f-publisher', 'My own note of the publisher');
await page.fill('#f-notes', 'Shin bought this in Jimbocho.');
await page.click('#editor-form button[type=submit]');
await page.waitForTimeout(500);

/* --- the description gap ------------------------------------------------ */
// Two books on the shelf now: the first has a blurb, this one does not.

await t('the no-description filter appears with a count', async () => {
  if (await page.isHidden('#f-nodesc')) return 'filter hidden while a book has no description';
  const label = (await page.textContent('#f-nodesc')).replace(/\s+/g, ' ').trim();
  return label.includes('(1)') ? true : `label read "${label}"`;
});

await page.click('#f-nodesc');
await page.waitForTimeout(400);
await t('filtering to it narrows the shelf', async () =>
  (await page.locator('.book').count()) === 1 ? true : `${await page.locator('.book').count()} shown`);
await t('the one shown is the book without a blurb', async () =>
  (await page.textContent('.book')).includes('Norwegian Wood') ? true : await page.textContent('.book'));
await page.click('#f-nodesc');
await page.waitForTimeout(400);

await t('a card carries a snippet of the blurb it does have', async () => {
  const n = await page.locator('.book .book__desc').count();
  if (n !== 1) return `${n} snippets for 1 described book`;
  return (await page.textContent('.book .book__desc')).includes('Toru recalls')
    ? true : await page.textContent('.book .book__desc');
});

await page.locator('.book').first().click();
await page.waitForTimeout(300);
// Sorted by recently added, so the sparse one is first.
await t('the sparse book opened', async () =>
  (await page.textContent('#detail-body')).includes('My own note of the publisher') ? true : 'wrong book opened');

await page.click('#detail-enrich');
await page.waitForTimeout(600);

await t('enrichment filled the missing description', async () =>
  (await page.textContent('#detail-body')).includes('Toru recalls') ? true : 'description not added');
await t('enrichment did not overwrite our publisher', async () =>
  (await page.textContent('#detail-body')).includes('My own note of the publisher') ? true : 'publisher was overwritten');
await t('enrichment left our notes alone', async () =>
  (await page.textContent('#detail-body')).includes('Jimbocho') ? true : 'notes lost');
await t('enrichment named what it added', async () =>
  /Added .*from the catalogues/.test(await page.textContent('.toast-host')) ? true : 'no report');

// Nothing left without a blurb, so the filter has nothing to offer and goes.
// Read the property rather than visibility: the detail panel is still open
// over the toolbar, and what is under test is the state, not the occlusion.
await t('the no-description filter goes away once the gap is closed', async () =>
  await page.locator('#f-nodesc').evaluate((el) => el.hidden)
    ? true : 'filter still offered with nothing to filter');

/* --- setting the status without the editor ------------------------------- */
// The detail panel is open on the enriched sparse book.

await t('the detail offers all four states', async () =>
  (await page.locator('[data-set-status]').count()) === 4
    ? true : `${await page.locator('[data-set-status]').count()} buttons`);

await t('the current state is the pressed one', async () =>
  (await page.getAttribute('[data-set-status="unread"]', 'aria-pressed')) === 'true'
    ? true : 'unread not marked as current');

await page.click('[data-set-status="reading"]');
await page.waitForTimeout(500);

const mine = () => page.evaluate(() =>
  JSON.parse(localStorage.getItem('ss.cache.books'))
    .find(b => (b.publisher || '').includes('My own note of the publisher')));

await t('one click moves it to reading', async () => {
  const st = (await mine()).status;
  return st === 'reading' ? true : `status is ${st}`;
});
await t('and the shelf summary follows immediately', async () => {
  const txt = (await page.textContent('#stats')).replace(/\s+/g, ' ');
  const n = Number((txt.match(/(\d+)\s*Reading/i) || [])[1]);
  return n >= 1 ? true : `summary reads "${txt.trim().slice(0, 90)}"`;
});

await page.click('[data-set-status="lent"]');
await page.waitForTimeout(500);

await t('lending asks who has it', async () =>
  await page.isVisible('#lent-who') ? true : 'no borrower field');
await t('and dates the loan without being asked', async () =>
  (await mine()).lentAt ? true : 'no lentAt recorded');

await page.fill('#lent-who', 'Shin');
await page.click('#lent-save');
await page.waitForTimeout(500);

await t('the borrower is recorded', async () => {
  const v = (await mine()).lentTo;
  return v === 'Shin' ? true : `lentTo is ${JSON.stringify(v)}`;
});
await t('and shown with the date it went out', async () => {
  const txt = (await page.textContent('#detail-body')).replace(/\s+/g, ' ');
  return /Lent to\s*Shin/.test(txt) && /Lent since/.test(txt) ? true : txt.slice(0, 120);
});

// Coming off loan takes the borrower with it: a stale name is worse than none.
await page.click('[data-set-status="read"]');
await page.waitForTimeout(500);
await t('returning it clears the borrower and the date', async () => {
  const b = await mine();
  return !b.lentTo && !b.lentAt ? true : `lentTo=${JSON.stringify(b.lentTo)} lentAt=${JSON.stringify(b.lentAt)}`;
});
await t('the borrower field goes with it', async () =>
  !(await page.isVisible('#lent-who')) ? true : 'borrower field still shown');
await t('the detail stayed open throughout', async () =>
  await page.isVisible('#detail') ? true : 'the panel closed on a status change');

/* --- rating ------------------------------------------------------------- */

await page.click('#detail-edit');
await page.waitForTimeout(300);
await page.locator('#rating-stars [data-star="4"]').click();
await t('rating field records four', async () =>
  (await page.inputValue('#f-rating')) === '4' ? true : await page.inputValue('#f-rating'));
await page.locator('#rating-stars [data-star="4"]').click();
await t('clicking the same star clears it', async () =>
  (await page.inputValue('#f-rating')) === '0' ? true : await page.inputValue('#f-rating'));
await page.locator('#rating-stars [data-star="5"]').click();
await page.click('#editor-form button[type=submit]');
await page.waitForTimeout(400);

await t('rating shows on the card', async () =>
  (await page.locator('.book .stars .star[data-on="true"]').count()) === 5 ? true : 'stars not lit');

/* --- lent-to appears only when lent ------------------------------------- */

await page.locator('.book').first().click();
await page.waitForTimeout(300);
await page.click('#detail-edit');
await page.waitForTimeout(300);
await t('lent-to hidden while not lent', async () =>
  !(await page.isVisible('#lentto-field')) ? true : 'shown too early');
await page.selectOption('#f-status-edit', 'lent');
await page.waitForTimeout(150);
await t('lent-to appears when lent', async () =>
  await page.isVisible('#lentto-field') ? true : 'still hidden');
await page.fill('#f-lentto', 'Kenji');
await page.click('#editor-form button[type=submit]');
await page.waitForTimeout(400);

await page.locator('.book').first().click();
await page.waitForTimeout(300);
await t('detail names the borrower', async () =>
  (await page.textContent('#detail-body')).includes('Kenji') ? true : 'borrower missing');
await page.click('#detail [data-close]');
await page.waitForTimeout(200);

/* --- languages ---------------------------------------------------------- */

for (const [code, needle] of [['ja', '書庫'], ['es', 'La Biblioteca']]) {
  await page.click(`[data-lang="${code}"]`);
  await page.waitForTimeout(350);
  await t(`switches to ${code}`, async () =>
    (await page.textContent('#app')).includes(needle) ? true : `"${needle}" missing`);
  await t(`no raw keys in ${code}`, async () => {
    const raw = (await page.textContent('#app')).match(/\blib\.[a-zA-Z.]+/g);
    return raw ? `untranslated: ${[...new Set(raw)].join(', ')}` : true;
  });
}
await page.click('[data-lang="en"]');
await page.waitForTimeout(300);

/* --- record size budget -------------------------------------------------- */

await t('records stay inside the store\'s 64 KB limit', async () => {
  const worst = await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem('ss.cache.books') || '[]');
    return raw.reduce((m, r) => Math.max(m, JSON.stringify(r).length), 0);
  });
  return worst < 64 * 1024 ? true : `${worst} bytes`;
});

/* --- delete -------------------------------------------------------------- */

page.on('dialog', d => d.accept());
await page.locator('.book').first().click();
await page.waitForTimeout(300);
await page.click('#detail-edit');
await page.waitForTimeout(300);
await page.click('#editor-delete');
await page.waitForTimeout(450);
await t('deleting removes the card', async () => {
  const n = await page.locator('.book').count();
  return n === 1 ? true : `${n} cards left`;
});

/* ------------------------------------------------------------------------ */

if (errs.length) fails.push('console/page errors: ' + errs.join(' | '));
console.log(`\nbrowser-library: ${fails.length ? 'FAILED' : 'passed'}`);
if (fails.length) { fails.forEach(f => console.error('  ✗ ' + f)); }
await browser.close();
process.exit(fails.length ? 1 : 0);
