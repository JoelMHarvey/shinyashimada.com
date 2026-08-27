/* The integration status row. Its whole purpose is to answer "why can't I see
 * the thing I just configured", so each state must name what is missing. */
import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:8899';
const browser = await chromium.launch();
const fails = [];
const t = async (n, fn) => { try { const r = await fn(); if (r !== true) fails.push(`${n}: ${r}`); } catch (e) { fails.push(`${n}: threw ${e.message}`); } };

async function open({ storeBody, trello, camera, passcode }) {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  if (passcode) await p.addInitScript(c => { try { localStorage.setItem('ss.passcode', JSON.stringify(c)); } catch (e) {} }, passcode);
  await p.route('**/api/weather*', r => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, current: { temperature_2m: 20, weather_code: 0 }, daily: {}, advisories: [] }) }));
  await p.route('**/api/store*', r => {
    const u = new URL(r.request().url());
    if (u.searchParams.has('health')) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(storeBody) });
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ records: [] }) });
  });
  await p.route('**/api/trello*', r => r.fulfill({ status: trello.status, contentType: 'application/json', body: JSON.stringify(trello.body) }));
  await p.route('**/api/camera*', r => r.fulfill({ status: camera.status, contentType: 'application/json', body: JSON.stringify(camera.body) }));
  await p.goto(BASE + '/plants/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(800);
  return { p, ctx };
}

const OK_STORE = { ok: true, database: true, authRequired: true };

/* --- the state the site is actually in right now ------------------------ */
{
  const { p, ctx } = await open({
    storeBody: OK_STORE, passcode: 'secret',
    trello: { status: 503, body: { code: 'no-trello', error: 'x' } },
    camera: { status: 503, body: { code: 'no-camera', error: 'x' } }
  });
  const txt = await p.textContent('#integrations');
  await t('shows the two integrations without their own indicator', async () =>
    (await p.locator('#integrations .chip, #integrations button.chip').count()) === 2 ? true : txt);
  await t('says Trello is not set up', async () => /Trello · not set up/.test(txt) ? true : txt);
  await t('says the camera is not set up', async () => /Camera · not set up/.test(txt) ? true : txt);
  await t('does not duplicate the sync pill', async () => !/Sync · /.test(txt) ? true : txt);
  await t('names the missing Trello env vars', async () => {
    const title = await p.locator('#integrations .chip', { hasText: 'Trello' }).getAttribute('title');
    return /TRELLO_KEY/.test(title) ? true : title;
  });
  await t('names the missing camera env var', async () => {
    const title = await p.locator('#integrations .chip', { hasText: 'Camera' }).getAttribute('title');
    return /CAMERA_STREAM_URL/.test(title) ? true : title;
  });
  await ctx.close();
}

/* --- everything configured ---------------------------------------------- */
{
  const { p, ctx } = await open({
    storeBody: OK_STORE, passcode: 'secret',
    trello: { status: 200, body: { ok: true, settings: { enabled: true, listId: 'l1', lang: 'en' } } },
    camera: { status: 200, body: { ok: true, url: 'https://relay.example.com/s', mode: 'iframe', label: 'Balcony' } }
  });
  const txt = await p.textContent('#integrations');
  await t('Trello reads as on', async () => /Trello · on/.test(txt) ? true : txt);
  await t('camera reads as on', async () => /Camera · on/.test(txt) ? true : txt);
  await t('the Trello chip opens the panel', async () => {
    await p.click('#st-trello');
    await p.waitForTimeout(600);
    return await p.isVisible('#trello') ? true : 'panel did not open';
  });
  await ctx.close();
}

/* --- configured but the morning sync is off ------------------------------ */
{
  const { p, ctx } = await open({
    storeBody: OK_STORE, passcode: 'secret',
    trello: { status: 200, body: { ok: true, settings: { enabled: false, listId: null, lang: 'en' } } },
    camera: { status: 503, body: { code: 'no-camera' } }
  });
  await t('distinguishes ready from on', async () => {
    const txt = await p.textContent('#integrations');
    return /Trello · ready/.test(txt) ? true : txt;
  });
  await ctx.close();
}

/* --- a visitor without the passcode sees no configuration at all --------- */
{
  const { p, ctx } = await open({
    storeBody: OK_STORE, passcode: null,
    trello: { status: 401, body: { code: 'unauthorized' } },
    camera: { status: 401, body: { code: 'unauthorized' } }
  });
  await t('no status row for a locked-out visitor', async () => {
    const txt = (await p.textContent('#integrations')).trim();
    return txt === '' ? true : `showed: ${txt}`;
  });
  await ctx.close();
}

await browser.close();
console.log(fails.length ? 'FAILURES:\n' + fails.map(f => '  ✗ ' + f).join('\n') : '✓ all status row assertions passed');
process.exit(fails.length ? 1 : 0);
