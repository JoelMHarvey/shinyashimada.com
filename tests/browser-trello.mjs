/* The Trello panel on the balcony page, including the states you meet before
 * anything is configured — an unexplained disabled control is worse than none,
 * so each refusal must say what to do about it. */
import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:8899';
const browser = await chromium.launch();
const fails = [];
const t = async (n, fn) => { try { const r = await fn(); if (r !== true) fails.push(`${n}: ${r}`); } catch (e) { fails.push(`${n}: threw ${e.message}`); } };

async function open({ trelloHandler }) {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  // The panel's whole job is to handle refusals gracefully, so the browser's
  // own "failed to load resource" line for a deliberate 401/503 is expected;
  // what must not happen is an unhandled exception.
  const expected = t => /fonts\.|ERR_CONNECTION_RESET/.test(t) ||
                        /status of (401|503)/.test(t);
  p.on('console', m => { if (m.type() === 'error' && !expected(m.text())) errs.push(m.text()); });

  await p.route('**/api/weather*', r => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, current: { temperature_2m: 20, weather_code: 0 }, daily: {}, advisories: [] }) }));
  await p.route('**/api/store*', r => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, database: true, authRequired: false, records: [] }) }));
  // Netlify-only endpoints. Unrouted, the dev server leaves them pending and
  // `networkidle` never settles.
  await p.route('**/api/camera*', r => r.fulfill({ status: 503, contentType: 'application/json', body: '{"code":"no-camera"}' }));
  await p.route('**/api/trello*', trelloHandler);

  await p.goto(BASE + '/plants/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(500);
  await p.click('#menu-btn');
  await p.waitForTimeout(200);
  await p.click('#open-trello');
  await p.waitForTimeout(500);
  return { p, ctx, errs };
}

/* --- before SITE_PASSCODE is set (the state the site is in today) ------- */
{
  const { p, ctx, errs } = await open({
    trelloHandler: r => r.fulfill({ status: 503, contentType: 'application/json',
      body: JSON.stringify({ error: 'x', code: 'passcode-required' }) })
  });
  await t('panel opens', async () => await p.isVisible('#trello') ? true : 'not visible');
  await t('form hidden when it cannot run', async () => await p.locator('#tr-form').isHidden() ? true : 'form shown');
  await t('explains that SITE_PASSCODE is needed', async () => {
    const txt = await p.textContent('#tr-status');
    return /SITE_PASSCODE/.test(txt) ? true : txt.slice(0, 100);
  });
  await t('no JS errors', async () => errs.length === 0 ? true : errs.join('; '));
  await ctx.close();
}

/* --- Trello keys missing ------------------------------------------------ */
{
  const { p, ctx } = await open({
    trelloHandler: r => r.fulfill({ status: 503, contentType: 'application/json',
      body: JSON.stringify({ error: 'x', code: 'no-trello' }) })
  });
  await t('explains the missing Trello keys', async () => {
    const txt = await p.textContent('#tr-status');
    return /TRELLO_KEY/.test(txt) ? true : txt.slice(0, 100);
  });
  await ctx.close();
}

/* --- fully configured --------------------------------------------------- */
{
  const posted = [];
  const { p, ctx, errs } = await open({
    trelloHandler: route => {
      const req = route.request();
      const u = new URL(req.url());
      if (req.method() === 'POST') {
        const body = JSON.parse(req.postData() || '{}');
        posted.push(body);
        if (body.action === 'settings') {
          return route.fulfill({ status: 200, contentType: 'application/json',
            body: JSON.stringify({ ok: true, settings: body.settings }) });
        }
        return route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify({ ok: true, result: {
            ok: true, due: 3, plants: 5,
            created: [{ marker: '[balcony:p1:water]', name: '💧 Water — Big monstera · 3 days late' }],
            completed: [{ plantId: 'p2', taskType: 'prune' }], skipped: 1, errors: [] } }) });
      }
      const action = u.searchParams.get('action');
      if (action === 'boards') return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, boards: [{ id: 'b1', name: 'Balcony' }, { id: 'b2', name: 'House' }] }) });
      if (action === 'lists') return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, lists: [{ id: 'l1', name: 'To do' }, { id: 'l2', name: 'Done' }] }) });
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, settings: { enabled: false, boardId: null, listId: null, lang: 'en' } }) });
    }
  });

  await t('form shown when configured', async () => await p.locator('#tr-form').isVisible() ? true : 'hidden');
  await t('every label is translated, not a raw key', async () => {
    const raw = await p.evaluate(() => {
      const out = [];
      document.querySelectorAll('#trello [data-i18n]').forEach(el => {
        const txt = (el.textContent || '').trim();
        if (/^[a-z]+\.[a-zA-Z0-9.]+$/.test(txt)) out.push(txt);
      });
      return out;
    });
    return raw.length === 0 ? true : `untranslated: ${raw.join(', ')}`;
  });
  await t('both boards offered', async () => {
    const n = await p.locator('#tr-board option').count();
    return n === 3 ? true : `${n} options (incl. placeholder)`;   // several boards exist
  });

  await p.selectOption('#tr-board', 'b1');
  await p.waitForTimeout(400);
  await t('lists load for the chosen board', async () => {
    const n = await p.locator('#tr-list option').count();
    return n === 3 ? true : `${n} options`;
  });

  await p.selectOption('#tr-list', 'l1');
  await p.selectOption('#tr-lang', 'ja');
  await p.check('#tr-enabled');
  await p.click('#tr-sync');
  await p.waitForTimeout(700);

  await t('settings saved before syncing', async () => {
    const s = posted.find(b => b.action === 'settings');
    return s && s.settings.listId === 'l1' && s.settings.lang === 'ja' && s.settings.enabled === true
      ? true : JSON.stringify(s);
  });
  await t('sync was requested', async () => posted.some(b => b.action === 'sync') ? true : 'no sync posted');
  await t('result is reported', async () => {
    const txt = await p.textContent('#tr-result');
    return /1 cards created/.test(txt) && /1 completed/.test(txt) ? true : txt.slice(0, 120);
  });
  await t('created card is listed', async () => {
    const txt = await p.textContent('#tr-result');
    return /Big monstera/.test(txt) ? true : txt.slice(0, 120);
  });

  // Preview must be clearly labelled as writing nothing.
  await p.click('#tr-preview');
  await p.waitForTimeout(700);
  await t('preview says nothing was written', async () => {
    const txt = await p.textContent('#tr-result');
    return /nothing was written/i.test(txt) ? true : txt.slice(0, 120);
  });

  await t('no JS errors', async () => errs.length === 0 ? true : errs.join('; '));
  await ctx.close();
}

await browser.close();
console.log(fails.length ? 'FAILURES:\n' + fails.map(f => '  ✗ ' + f).join('\n') : '✓ all Trello panel assertions passed');
process.exit(fails.length ? 1 : 0);
