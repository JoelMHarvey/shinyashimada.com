/* ==========================================================================
   Turn Shin's vocabulary rows into an autocomplete index.

   The writing box cannot hold 3,463 rows of definitions on a phone just to
   find out what usually follows `poner`, so the counting happens here, once,
   and what crosses the wire is the answer: which words exist, what tends to
   come after each, and which multi-word runs recur often enough to be worth
   proposing whole.

   Kept out of the function file so it can be tested against fixture rows in
   node, with no database and no network.
   ========================================================================== */

/** Ceilings, so a growing notebook cannot grow the payload without bound. */
export const LIMITS = {
  words: 6000,
  nextKeys: 1600,
  perKey: 4,
  phrases: 400,
  glossChars: 96
};

/**
 * Words too common to be worth completing on their own.
 *
 * They still matter as bigram keys — half the useful suggestions are what
 * follows `se` or `por` — but offering `para` as the completion of `par` is
 * noise, and data/es-common.json already carries every one of them with a
 * proper frequency behind it.
 */
const TOO_COMMON = new Set([
  'para', 'como', 'pero', 'porque', 'cuando', 'donde', 'desde', 'hasta', 'sobre', 'entre',
  'todo', 'toda', 'todos', 'todas', 'este', 'esta', 'estos', 'estas', 'ese', 'esa', 'esos',
  'esas', 'aquel', 'aquella', 'otro', 'otra', 'otros', 'otras', 'mismo', 'misma', 'cada',
  'algo', 'alguien', 'alguno', 'alguna', 'nada', 'nadie', 'ningun', 'ninguna', 'muy', 'mas',
  'menos', 'tanto', 'tanta', 'poco', 'poca', 'mucho', 'mucha', 'bien', 'solo', 'tambien',
  'segun', 'ante', 'tras', 'sino', 'aunque', 'mientras', 'siempre', 'nunca', 'quien', 'cual',
  'cuyo', 'cuya', 'los', 'las', 'una', 'unos', 'unas', 'del', 'con', 'sin', 'por', 'que',
  'los', 'sus', 'les', 'nos', 'ser', 'estar', 'haber'
]);

const SENTENCE_SPLIT = /[.;:!?¡¿\n]+/;

/** Lower-cased word tokens, with the cloze blanks and any markup taken out. */
export function tokenise(text) {
  return String(text || '')
    .replace(/_{2,}/g, ' ')
    .toLowerCase()
    .normalize('NFC')
    .split(/[^\p{L}\p{M}'’-]+/u)
    .map((w) => w.replace(/^['’-]+|['’-]+$/g, ''))
    .filter((w) => w.length > 1);
}

const bump = (map, key, by = 1) => map.set(key, (map.get(key) || 0) + by);

/** Definitions run long; the list shows the first clause, not a paragraph. */
export function shortGloss(row) {
  const raw = String(row.gloss_en || row.definition || '').replace(/_{2,}/g, '…').replace(/\s+/g, ' ').trim();
  if (raw.length <= LIMITS.glossChars) return raw;
  const cut = raw.lastIndexOf(' ', LIMITS.glossChars);
  return raw.slice(0, cut > 40 ? cut : LIMITS.glossChars).trim() + '…';
}

/**
 * @param {Array<{term, definition, example_es, gloss_en, part_of_speech}>} rows
 * @returns {{entries:number, words:Array, next:Object, phrases:Array}}
 */
export function buildSuggestIndex(rows) {
  const wordCount = new Map();
  const bigram = new Map();     // 'a\tb' -> count
  const ngram = new Map();      // 'a b c' -> count

  for (const row of rows) {
    // Only the Spanish carries usage. `gloss_en` is a translation, and
    // counting English words here would put them in a Spanish writing aid.
    for (const field of [row.definition, row.example_es]) {
      for (const sentence of String(field || '').split(SENTENCE_SPLIT)) {
        const words = tokenise(sentence);
        for (const w of words) bump(wordCount, w);
        for (let i = 0; i + 1 < words.length; i++) bump(bigram, words[i] + '\t' + words[i + 1]);
        for (const n of [3, 4]) {
          for (let i = 0; i + n <= words.length; i++) bump(ngram, words.slice(i, i + n).join(' '));
        }
      }
    }
  }

  const topCount = Math.max(1, ...wordCount.values());

  // --- headwords ----------------------------------------------------------
  //
  // These outrank anything counted out of the prose: they are the words the
  // notebook exists to teach, and each arrives with the definition he wrote.
  const words = [];
  const claimed = new Set();
  for (const row of rows) {
    const term = String(row.term || '').replace(/\s+/g, ' ').trim();
    if (!term) continue;
    const key = term.toLowerCase();
    if (claimed.has(key)) continue;
    claimed.add(key);
    words.push([term, 1, shortGloss(row)]);
  }

  // --- everything else the prose uses often enough to be worth finishing ---
  const fromProse = [...wordCount.entries()]
    .filter(([w, n]) => n >= 2 && w.length >= 4 && !TOO_COMMON.has(w) && !claimed.has(w))
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(0, LIMITS.words - words.length));
  for (const [w, n] of fromProse) words.push([w, Number((n / topCount).toFixed(3)), '']);

  // --- what follows what --------------------------------------------------
  const byFirst = new Map();
  for (const [pair, n] of bigram) {
    if (n < 2) continue;
    const [a, b] = pair.split('\t');
    if (!byFirst.has(a)) byFirst.set(a, []);
    byFirst.get(a).push([b, n]);
  }
  const next = {};
  const ranked = [...byFirst.entries()]
    .map(([a, list]) => [a, list.sort((x, y) => y[1] - x[1]), list.reduce((s, c) => s + c[1], 0)])
    .sort((a, b) => b[2] - a[2])
    .slice(0, LIMITS.nextKeys);
  for (const [a, list] of ranked) {
    const top = list[0][1];
    next[a] = list.slice(0, LIMITS.perKey).map(([b, n]) => [b, Number((n / top).toFixed(3))]);
  }

  // --- runs worth proposing whole -----------------------------------------
  //
  // A four-word run that recurs is almost always a fixed expression rather
  // than a coincidence, so it is scored above a three-word one at equal count.
  const phrases = [...ngram.entries()]
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, LIMITS.phrases);
  const topPhrase = phrases.length ? phrases[0][1] : 1;

  return {
    entries: rows.length,
    words,
    next,
    phrases: phrases.map(([text, n]) => [text, Number((n / topPhrase).toFixed(3)), ''])
  };
}
