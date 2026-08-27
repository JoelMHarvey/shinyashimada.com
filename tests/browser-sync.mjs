/* Regression test for the store's auth handling.
 *
 * Whether a passcode is required is the server's decision. An earlier version
 * of push() refused to send anything unless a passcode was stored locally,
 * which meant that with SITE_PASSCODE unset — a perfectly valid setup, and the
 * one the site launched with — writes never left the device even though the
 * database was connected and accepting them.
 */
import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:8899';
const browser = await chromium.launch();
const fails = [];
const t = async (n, fn) => { try { const r = await fn(); if (r !== true) fails.push(`${n}: ${r}`); } catch (e) { fails.push(`${n}: threw ${e.message}`); } };

/** Stand up a page against a fake store with the given auth behaviour. */
async function page({ authRequired, rejectWrites }) {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  const posts = [];
  await p.route('**/api/weather*', r => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, current: { temperature_2m: 20, weather_code: 0 }, daily: {}, advisories: [] }) }));
  await p.route('**/api/store*', route => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === 'POST') {
      posts.push({ passcode: req.headers()['x-store-passcode'] || null, body: JSON.parse(req.postData() || '{}') });
      if (rejectWrites) return route.fulfill({ status: 401, contentType: 'application/json',
        body: JSON.stringify({ error: 'Passcode required.', code: 'unauthorized' }) });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, written: 1 }) });
    }
    if (url.searchParams.has('health')) return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, database: true, authRequired }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ records: [] }) });
  });
  await p.goto(BASE + '/plants/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(500);
  return { p, posts, ctx };
}

const addPlant = async (p, name) => p.evaluate(n =>
  window.Store.open('plants').put({ speciesId: 'monstera', name: n, care: {}, log: [] }), name);

/* --- the reported configuration: DB connected, no passcode ------------- */
{
  const { p, posts, ctx } = await page({ authRequired: false, rejectWrites: false });
  await addPlant(p, 'Big monstera');
  await p.waitForTimeout(600);

  await t('open server: the write is actually sent', async () =>
    posts.length === 1 ? true : `${posts.length} POSTs`);
  await t('open server: no passcode header invented', async () =>
    posts[0] && posts[0].passcode === null ? true : `header was ${posts[0] && posts[0].passcode}`);
  await t('open server: the plant is in the payload', async () =>
    posts[0]?.body?.records?.[0]?.name === 'Big monstera' ? true : JSON.stringify(posts[0]?.body));
  await t('open server: collection reports cloud mode', async () =>
    (await p.evaluate(() => window.Store.open('plants').status().mode)) === 'cloud'
      ? true : await p.evaluate(() => window.Store.open('plants').status().mode));
  await ctx.close();
}

/* --- a locked server, with no passcode on this device ------------------ */
{
  const { p, posts, ctx } = await page({ authRequired: true, rejectWrites: true });
  await addPlant(p, 'One');
  await p.waitForTimeout(500);
  await t('locked server: tries once', async () => posts.length === 1 ? true : `${posts.length} POSTs`);

  // Further edits must not hammer a server we already know rejects us.
  await addPlant(p, 'Two');
  await addPlant(p, 'Three');
  await p.waitForTimeout(600);
  await t('locked server: backs off after the 401', async () =>
    posts.length === 1 ? true : `${posts.length} POSTs after 3 edits`);
  await t('locked server: falls back to local mode', async () =>
    (await p.evaluate(() => window.Store.open('plants').status().mode)) === 'local' ? true : 'not local');
  await t('locked server: nothing is lost — edits stay pending', async () =>
    (await p.evaluate(() => window.Store.open('plants').status().pending)) >= 3 ? true : 'pending count wrong');

  // Entering a passcode must make it try again rather than stay stuck.
  await p.evaluate(() => window.Store.auth.set('hunter2'));
  await addPlant(p, 'Four');
  await p.waitForTimeout(600);
  await t('locked server: retries once a passcode is entered', async () =>
    posts.length === 2 ? true : `${posts.length} POSTs`);
  await t('locked server: sends the passcode it was given', async () =>
    posts[1] && posts[1].passcode === 'hunter2' ? true : `header was ${posts[1] && posts[1].passcode}`);
  await ctx.close();
}

await browser.close();
console.log(fails.length ? 'FAILURES:\n' + fails.map(f => '  ✗ ' + f).join('\n') : '✓ all store sync assertions passed');
process.exit(fails.length ? 1 : 0);
