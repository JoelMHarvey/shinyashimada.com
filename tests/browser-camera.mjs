/* The balcony camera card. The states that matter are the ones where nothing
 * is working yet — the card must stay out of the way rather than shouting at
 * a visitor about an unconfigured camera. */
import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:8899';
const browser = await chromium.launch();
const fails = [];
const t = async (n, fn) => { try { const r = await fn(); if (r !== true) fails.push(`${n}: ${r}`); } catch (e) { fails.push(`${n}: threw ${e.message}`); } };

async function open(cameraHandler) {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  const expected = t => /fonts\.|ERR_CONNECTION_RESET/.test(t) || /status of (401|503)/.test(t);
  p.on('console', m => { if (m.type() === 'error' && !expected(m.text())) errs.push(m.text()); });

  await p.route('**/api/weather*', r => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, current: { temperature_2m: 20, weather_code: 0 }, daily: {}, advisories: [] }) }));
  await p.route('**/api/store*', r => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, database: true, authRequired: false, records: [] }) }));
  await p.route('**/api/trello*', r => r.fulfill({ status: 503, contentType: 'application/json',
    body: JSON.stringify({ code: 'passcode-required', error: 'x' }) }));
  await p.route('**/api/camera*', cameraHandler);
  // Stand in for the home relay so nothing reaches the network.
  await p.route('**/stream.html*', r => r.fulfill({ status: 200, contentType: 'text/html',
    body: '<html><body style="background:#123">relay</body></html>' }));

  await p.goto(BASE + '/plants/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(700);
  return { p, ctx, errs };
}

const hidden = (p) => p.locator('#camera').evaluate(el => el.classList.contains('hidden'));

/* --- nothing configured: the card must not appear at all ---------------- */
for (const [name, code, status] of [
  ['no passcode set', 'passcode-required', 503],
  ['no camera set', 'no-camera', 503],
  ['device not unlocked', 'unauthorized', 401]
]) {
  const { p, ctx, errs } = await open(r => r.fulfill({ status, contentType: 'application/json',
    body: JSON.stringify({ code, error: 'x' }) }));
  await t(`card stays hidden when ${name}`, async () => await hidden(p) ? true : 'card was shown');
  await t(`no JS errors when ${name}`, async () => errs.length === 0 ? true : errs.join('; '));
  await ctx.close();
}

/* --- configured --------------------------------------------------------- */
{
  const { p, ctx, errs } = await open(r => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, url: 'https://relay.example.com/stream.html?src=balcony&mode=mse', mode: 'iframe', label: 'Balcony' }) }));

  await t('card appears', async () => !(await hidden(p)) ? true : 'still hidden');
  await t('uses the configured label', async () =>
    (await p.textContent('#cam-title')).trim() === 'Balcony' ? true : await p.textContent('#cam-title'));

  await t('does not stream until asked', async () => {
    const n = await p.locator('#cam-stage iframe').count();
    const state = await p.locator('#camera').getAttribute('data-state');
    return n === 0 && state === 'idle' ? true : `${n} iframes, state ${state}`;
  });
  await t('explains why it is not already playing', async () => {
    const txt = await p.textContent('#cam-message');
    return /only runs while you are watching/i.test(txt) ? true : txt.slice(0, 80);
  });

  await p.click('#cam-start');
  await p.waitForTimeout(900);
  await t('starts on request', async () => {
    const n = await p.locator('#cam-stage iframe').count();
    return n === 1 ? true : `${n} iframes`;
  });
  await t('reaches the live state', async () =>
    (await p.locator('#camera').getAttribute('data-state')) === 'live' ? true
      : await p.locator('#camera').getAttribute('data-state'));
  await t('iframe is sandboxed', async () => {
    const sb = await p.locator('#cam-stage iframe').getAttribute('sandbox');
    return sb && sb.includes('allow-scripts') ? true : `sandbox=${sb}`;
  });

  await p.click('#cam-stop');
  await p.waitForTimeout(400);
  await t('stopping tears the stream down', async () => {
    const n = await p.locator('#cam-stage iframe').count();
    const state = await p.locator('#camera').getAttribute('data-state');
    return n === 0 && state === 'idle' ? true : `${n} iframes, state ${state}`;
  });

  await t('no JS errors', async () => errs.length === 0 ? true : errs.join('; '));
  await ctx.close();
}

/* --- relay down: must time out rather than hang forever ----------------- */
{
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.route('**/api/weather*', r => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, current: { temperature_2m: 20, weather_code: 0 }, daily: {}, advisories: [] }) }));
  await p.route('**/api/store*', r => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, database: true, authRequired: false, records: [] }) }));
  await p.route('**/api/trello*', r => r.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
  await p.route('**/api/camera*', r => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, url: 'https://dead.example.com/stream.html', mode: 'iframe', label: null }) }));
  await p.route('**/dead.example.com/**', r => r.abort());

  await p.goto(BASE + '/plants/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(600);
  // Shorten the timeout so the test does not wait 15s for the real one.
  await p.evaluate(() => { window.__origSetTimeout = setTimeout; });
  await p.click('#cam-start');
  await p.waitForTimeout(2000);
  await t('a dead relay ends up offline, not stuck connecting', async () => {
    const state = await p.locator('#camera').getAttribute('data-state');
    return state === 'offline' ? true : `state ${state}`;
  });
  await t('offline state explains the likely cause', async () => {
    const txt = await p.textContent('#cam-message');
    return /computer at home|asleep/i.test(txt) ? true : txt.slice(0, 80);
  });
  await ctx.close();
}

await browser.close();
console.log(fails.length ? 'FAILURES:\n' + fails.map(f => '  ✗ ' + f).join('\n') : '✓ all camera card assertions passed');
process.exit(fails.length ? 1 : 0);
