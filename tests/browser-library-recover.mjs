/* Books added while the store had no passcode are stranded on the device.
 * Entering the passcode later must send them, not just read past them —
 * the exact state a shelf full of books on one site and empty on the other
 * turned out to be. */
import { chromium } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
page.on('console', m => { if (m.type()==='error' && !/fonts\.|ERR_CONNECTION_RESET|status of (401|503)/.test(m.text())) errs.push(m.text()); });

const GOOD = 'right-code';
let server = [];            // what Postgres holds
let writes = 0;

await page.route('**/api/store*', route => {
  const req = route.request();
  const url = new URL(req.url());
  const given = req.headers()['x-store-passcode'];
  const json = (status, body) => route.fulfill({ status, contentType:'application/json', body: JSON.stringify(body) });

  if (url.searchParams.has('health')) return json(200, { ok:true, database:true, authRequired:true });
  if (given !== GOOD) return json(401, { error:'Passcode required.', code:'unauthorized' });

  if (req.method() === 'POST') {
    const body = JSON.parse(req.postData() || '{}');
    writes++;
    (body.records || []).forEach(r => {
      const i = server.findIndex(s => s.id === r.id);
      if (i === -1) server.push(r); else server[i] = r;
    });
    return json(200, { ok:true, written:(body.records || []).length });
  }
  return json(200, { records: server });
});
await page.route('**/api/books*', r => r.fulfill({ status:200, contentType:'application/json', body:'{"results":[]}' }));

const fails = [];
const t = async (name, fn) => { try { const r = await fn(); if (r !== true) fails.push(`${name}: ${r}`); } catch(e){ fails.push(`${name}: threw ${e.message}`);} };

await page.goto('http://127.0.0.1:8899/library/', { waitUntil:'networkidle' });
await page.waitForTimeout(600);

/* --- the trap: choose device-only, then add books ------------------------ */

await t('a passcode is asked for', async () => await page.isVisible('#lock') ? true : 'no lock screen');

await page.click('#lock-offline');            // "Use this device only"
await page.waitForTimeout(400);
await t('device-only opens the library', async () => await page.isVisible('#app') ? true : 'app not shown');

await page.click('#do-import');
await page.waitForTimeout(2500);

await t('the import lands locally', async () => {
  const n = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('ss.cache.books') || '[]').filter(b => !b.deleted).length);
  return n === 319 ? true : `${n} books`;
});
await t('but nothing reached the server', async () => server.length === 0 ? true : `${server.length} rows`);
await t('the pill says they are not saved', async () => {
  const txt = await page.textContent('#sync-pill');
  return /not saved to the shared library/.test(txt) ? true : `pill read "${txt.trim()}"`;
});
await t('and it names how many', async () =>
  (await page.textContent('#sync-pill')).includes('319') ? true : await page.textContent('#sync-pill'));

/* --- the recovery: supply the passcode ----------------------------------- */

await page.reload({ waitUntil:'networkidle' });
await page.waitForTimeout(700);
await t('a reload asks for the passcode again', async () => await page.isVisible('#lock') ? true : 'no lock screen');

await page.fill('#lock-input', GOOD);
await page.click('#lock-form button[type=submit]');
await page.waitForTimeout(2500);

await t('unlocking sends the backlog', async () => server.length === 319 ? true : `${server.length} rows on the server`);
await t('it went in one write, not 319', async () => writes === 1 ? true : `${writes} writes`);
await t('the books are still on screen', async () => {
  const n = await page.locator('.book').count();
  return n > 0 ? true : 'grid empty';
});
await t('the pill no longer reports a backlog', async () => {
  const txt = await page.textContent('#sync-pill');
  return !/not saved/.test(txt) ? true : `pill read "${txt.trim()}"`;
});

/* --- a wrong passcode must not claim success ------------------------------ */

await page.evaluate(() => { localStorage.removeItem('ss.passcode'); });
await page.reload({ waitUntil:'networkidle' });
await page.waitForTimeout(700);
await page.fill('#lock-input', 'wrong');
await page.click('#lock-form button[type=submit]');
await page.waitForTimeout(1200);
await t('a wrong passcode is refused', async () => await page.isVisible('#lock') ? true : 'let in regardless');

if (errs.length) fails.push('console/page errors: ' + errs.join(' | '));
console.log(`\nbrowser-library-recover: ${fails.length ? 'FAILED' : 'passed'}`);
if (fails.length) fails.forEach(f => console.error('  ✗ ' + f));
await browser.close();
process.exit(fails.length ? 1 : 0);
