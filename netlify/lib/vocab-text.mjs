/* ==========================================================================
   Shared text handling for the vocabulary.

   Both scripts/parse-vocab.mjs (the OneNote import) and the write path in
   netlify/functions/vocab.mjs need to clean a definition and mask the answer
   out of it the same way. Two copies would drift, and a card Shin adds by
   hand would behave differently from the 3,463 that came out of his
   notebook — so the rules live here and are imported by both.
   ========================================================================== */

export const slug = (s) =>
  String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64) || 'untitled';

const ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  laquo: '«', raquo: '»', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘'
};

const decode = (s) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => (n.toLowerCase() in ENTITIES ? ENTITIES[n.toLowerCase()] : m));

export const tidy = (s) => decode(s).replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

/** Dictionary paste artefacts: "14. tr. Introducir…", "8Conseguir…", "loc. v. …". */
export function cleanDefinition(s) {
  let out = s;
  out = out.replace(/^\s*\d+\s*[.)]?\s*/, '');
  out = out.replace(/^(loc\.\s*(v|adj|adv|s)?\.?|tr\.|intr\.|prnl\.|adj\.|adv\.|m\.|f\.|s\.\s*m\.|s\.\s*f\.)\s*/i, '');
  out = out.replace(/^\s*\d+\s*/, '');
  // Stray angle brackets survive from the source text itself, not from markup.
  out = out.replace(/\s*[<>]+\s*/g, ' ');
  return out.replace(/\s+/g, ' ').trim();
}

/** Accent- and case-insensitive form, for comparing a term to a definition. */
export const fold = (s) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Blank the answer out of its own definition.
 *
 * The second column is often an example sentence using the very word being
 * asked about — 42% of rows leak the answer that way. Rather than throw
 * those away, mask the term so the card becomes a fill-in-the-blank, which
 * is a better question than the bare definition was.
 */
export function maskTerm(term, definition) {
  const foldedDef = fold(definition);
  const foldedTerm = fold(term).trim();
  if (!foldedTerm) return { text: definition, masked: false };

  let masked = false;
  let out = '';
  let i = 0;

  // Whole-term occurrences first. The match has to swallow the whole word:
  // "desplegar" sits inside "desplegaron", and blanking only the stem leaves
  // "____on" on the card, which hands the reader the ending.
  const isLetter = (ch) => ch !== undefined && /\p{L}/u.test(ch);
  while (i < definition.length) {
    const at = foldedDef.indexOf(foldedTerm, i);
    if (at < 0) break;
    let start = at;
    let end = at + foldedTerm.length;
    while (isLetter(definition[end])) end++;
    while (start > 0 && isLetter(definition[start - 1])) start--;
    out += definition.slice(i, start) + '____';
    i = end;
    masked = true;
  }
  out += definition.slice(i);

  // Then inflected forms of a single-word term: 'deleitarse' vs 'se deleita'.
  const first = foldedTerm.split(/\s+/)[0];
  if (first.length >= 6) {
    // Long enough to stay specific, short enough to catch inflections:
    // 'deleitarse' -> 'deleit', which matches both 'deleite' and 'deleita',
    // while 'estepa' stays whole so it cannot swallow 'este'.
    const stem = first.slice(0, Math.max(6, first.length - 4));
    out = out.replace(/\p{L}+/gu, (w) => {
      if (fold(w).startsWith(stem) && fold(w) !== stem.slice(0, 3)) {
        masked = true;
        return '____';
      }
      return w;
    });
  }

  return { text: out.replace(/(?:____[\s,]*){2,}/g, '____ ').replace(/\s+/g, ' ').trim(), masked };
}

/** A headword, not a sentence someone pasted into the wrong column. */
export function looksLikeTerm(s) {
  if (!s) return false;
  const words = s.split(/\s+/);
  if (words.length > 5) return false;
  if (s.length > 48) return false;
  if (/[.!?;]$/.test(s)) return false;
  if (/^(index|unidad|sin\.|ant\.|ejemplo)/i.test(s)) return false;
  return /\p{L}/u.test(s);
}

