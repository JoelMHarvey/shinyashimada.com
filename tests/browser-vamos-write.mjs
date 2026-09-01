/* The Spanish writing pad, in a real browser.
 *
 * The unit test settles what `suggest` returns; this settles that the box on
 * the page does something with it — that the ghost text lands under the
 * caret, that Tab takes the whole suggestion, and that the space bar does not
 * quietly rewrite an ordinary word into a longer one.
 *
 * The API is stubbed. What matters here is the typing, not Postgres. */
import { chromium } from 'playwright';

const b = await chromium.launch();
const ctx = await b.newContext();
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
page.on('console', m => { if (m.type() === 'error' && !/fonts\.|ERR_CONNECTION_RESET/.test(m.text())) errs.push(m.text()); });

const TOPICS = { topics: [{ id: 'unidad-1', label_en: 'Unit 1', label_es: 'Unidad 1', level: 'c1', count: 3 }] };
const DECK = {
  questions: [
    { id: 1, cat: 'unidad-1', q: 'Disminuir algo, quitarle parte.', a: 'menoscabar', wrong: ['a', 'b', 'c'], cloze: false },
    { id: 2, cat: 'unidad-1', q: 'Falta o necesidad de algo.', a: 'menester', wrong: ['a', 'b', 'c'], cloze: false },
    { id: 3, cat: 'unidad-1', q: 'Nombrar o mencionar a alguien.', a: 'mentar', wrong: ['a', 'b', 'c'], cloze: false }
  ]
};
/* Deliberately tiny, and deliberately overlapping general Spanish on `menos`:
   a notebook word has to win that prefix. */
const SUGGEST = {
  entries: 3,
  words: [['menoscabar', 1, 'Disminuir algo'], ['menester', 1, 'Falta o necesidad']],
  next: { se: [['dice', 1]] },
  phrases: [['se dice de', 1, '']]
};

const reviewed = [];
await page.route('**/api/vocab*', (route) => {
  const url = route.request().url();
  const body = url.includes('counts=1') ? TOPICS : url.includes('suggest=1') ? SUGGEST : DECK;
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
});
await page.route('**/api/vocab-review*', (route) => {
  reviewed.push(JSON.parse(route.request().postData() || '{}'));
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ correct: true, usedWell: true, corrected: '', notes: [], better: '' })
  });
});

await page.goto('http://127.0.0.1:8899/vamos/', { waitUntil: 'networkidle' });
await page.waitForTimeout(500);

const fails = [];
const t = async (n, f) => {
  try { const r = await f(); if (r !== true) fails.push(`${n}: ${r}`); }
  catch (e) { fails.push(`${n}: threw ${e.message}`); }
};

/* Open the pad: pick the unit, then Escribir → Taller. */
await page.click('#pickAll');
await page.click('#tabWrite');
await page.waitForTimeout(300);
await page.click('#wmode-taller');
await page.waitForTimeout(700);

await t('the pad is on the page', async () => (await page.locator('#wPad').count()) === 1 ? true : 'no #wPad');
await t('three words are set', async () => {
  const n = await page.locator('.wchip').count();
  return n === 3 ? true : `${n} target words`;
});
await t('none of them is ticked yet', async () => (await page.locator('.wchip.used').count()) === 0 ? true : 'ticked before writing');

const ghost = () => page.locator('.esac-ghost').first().textContent();
const value = () => page.inputValue('#wPad');

/* ---- the ghost ---- */

await page.click('#wPad');
await page.type('#wPad', 'sin emb', { delay: 20 });
await page.waitForTimeout(250);
await t('a half-typed phrase is finished in grey', async () => {
  const g = await ghost();
  return g === 'argo' ? true : `ghost was ${JSON.stringify(g)}`;
});
await t('the suggestion list opens', async () => (await page.locator('.esac-item').count()) > 0 ? true : 'no list');
await t('and names the whole phrase', async () => {
  const txt = await page.textContent('.esac-item.on .esac-word');
  return txt === 'sin embargo' ? true : `listed ${txt}`;
});

await t('Tab takes the whole suggestion', async () => {
  await page.keyboard.press('Tab');
  await page.waitForTimeout(200);
  const v = await value();
  return v === 'sin embargo' ? true : `box holds ${JSON.stringify(v)}`;
});

/* ---- the space bar ---- */

await page.fill('#wPad', '');
await page.type('#wPad', ' menosc', { delay: 20 });
await page.waitForTimeout(250);
await t('his own notebook wins the prefix', async () => {
  const txt = await page.textContent('.esac-item.on .esac-word');
  return txt === 'menoscabar' ? true : `listed ${txt}`;
});
await t('and is marked as his', async () => {
  const txt = await page.textContent('.esac-item.on .esac-src');
  return txt === 'tu cuaderno' ? true : `badge said ${txt}`;
});
await t('space completes a half-typed word', async () => {
  await page.keyboard.press('Space');
  await page.waitForTimeout(200);
  const v = await value();
  return v === ' menoscabar ' ? true : `box holds ${JSON.stringify(v)}`;
});

// The whole reason the default is not the literal reading of "space accepts":
// `de` is a word, `dejar de` is a suggestion, and a box that swaps one for the
// other on every space is unusable.
// `su` is a word and `sus` is a suggestion. The word he actually typed has to
// survive the space bar, or every possessive in the text quietly gains an s.
await page.fill('#wPad', '');
await page.type('#wPad', 'Es su', { delay: 20 });
await page.waitForTimeout(250);
await t('space leaves a real word alone', async () => {
  await page.keyboard.press('Space');
  await page.waitForTimeout(200);
  const v = await value();
  return v === 'Es su ' ? true : `box holds ${JSON.stringify(v)}`;
});

await t('a capital survives being completed', async () => {
  await page.fill('#wPad', '');
  await page.type('#wPad', 'Menosc', { delay: 20 });
  await page.waitForTimeout(250);
  await page.keyboard.press('Tab');
  await page.waitForTimeout(200);
  const v = await value();
  return v === 'Menoscabar' ? true : `box holds ${JSON.stringify(v)}`;
});

await t('Escape puts the ghost away', async () => {
  await page.type('#wPad', 'menosc', { delay: 20 });
  await page.waitForTimeout(250);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  const g = await ghost().catch(() => '');
  return !g ? true : `ghost survived: ${JSON.stringify(g)}`;
});

/* ---- the exercise around it ---- */

await page.fill('#wPad', '');
await page.type('#wPad', 'No quiso menoscabar su fama. Era menester actuar.', { delay: 5 });
await page.waitForTimeout(300);
await t('used words are ticked off', async () => {
  const n = await page.locator('.wchip.used').count();
  return n === 2 ? true : `${n} ticked`;
});
await t('the word count is shown', async () => {
  const txt = await page.textContent('.wmeta');
  return /8 palabras/.test(txt) ? true : `meta said ${txt}`;
});

await t('Corregir marks the sentence the word is in', async () => {
  await page.locator('.wrow button', { hasText: 'Corregir' }).click();
  await page.waitForTimeout(500);
  const sent = reviewed[reviewed.length - 1];
  if (!sent) return 'nothing was sent for marking';
  if (sent.sentence !== 'No quiso menoscabar su fama.') return `sent ${JSON.stringify(sent.sentence)}`;
  return sent.term === 'menoscabar' ? true : `marked against ${sent.term}`;
});
await t('and the verdict is rendered', async () => {
  const txt = await page.textContent('#wVerdict');
  return /Bien escrito/.test(txt) ? true : `verdict said ${txt}`;
});

await t('the draft survives leaving the tab', async () => {
  await page.click('#tabPlay');
  await page.waitForTimeout(200);
  await page.click('#tabWrite');
  await page.waitForTimeout(600);
  const v = await value();
  return /menoscabar su fama/.test(v) ? true : `came back as ${JSON.stringify(v)}`;
});

/* ---- the drills must not answer themselves ---- */

await page.click('#wmode-define');
await page.waitForTimeout(600);
await t('no autocomplete on the word-answer drill', async () => {
  const n = await page.locator('.esac').count();
  return n === 0 ? true : 'the drill would complete its own answer';
});

console.log(errs.length ? 'JS ERRORS:\n' + errs.map(e => '  ! ' + e).join('\n') : 'no JS errors');
console.log(fails.length ? 'FAILURES:\n' + fails.map(f => '  ✗ ' + f).join('\n') : '✓ all writing-pad assertions passed');
await b.close();
process.exit(fails.length || errs.length ? 1 : 0);
