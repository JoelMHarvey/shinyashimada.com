/* ==========================================================================
   Spanish autocomplete for the writing exercises.

   Shin writes; the box proposes the rest of the word, or the rest of the
   set phrase, as grey text after the caret. Tab takes the whole suggestion,
   space takes one word of it.

   Two sources, in that order of preference:

     1. His own notebooks — the 3,463 DELE C1/C2 entries in Postgres, served
        as a ready-made index by /api/vocab?suggest=1. These are the words he
        is actually trying to learn, so they outrank everything else, and a
        suggestion carries the definition he wrote down for it.

     2. General Spanish — data/es-common.json, bundled with the site. The
        notebook vocabulary is almost all content words: it can define
        `erudición` but has never heard of `sin embargo`, because that was
        never a word he had to look up. This file is the connective tissue,
        and it also means the box still works before the API has answered, or
        without a passcode.

   The module is deliberately free of DOM access above the widget: `buildIndex`
   and `suggest` are pure, so tests/es-autocomplete.test.mjs can run them in
   node with no browser at all.
   ========================================================================== */

/** Accent- and case-blind form, for matching what was typed against a word.
 *
 * Combining marks are stripped after NFD, which maps each accented Spanish
 * letter onto exactly one base letter — á→a, ñ→n. That the length is preserved
 * is not incidental: the ghost text is `word.slice(typedLength)`, so a fold
 * that changed length would misalign every suggestion by a character. */
export const fold = (s) =>
  String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Letters that can sit inside a Spanish word, for finding the partial one. */
const WORD_CHARS = "\\p{L}\\p{M}'’-";
const TRAILING_WORD = new RegExp(`[${WORD_CHARS}]*$`, 'u');
const WORD_SPLIT = new RegExp(`[^${WORD_CHARS}]+`, 'u');

/** Longest phrase, in words, that is worth probing backwards for. */
const MAX_PHRASE_WORDS = 6;

/** Below this many typed letters a completion is guesswork, not help. */
export const MIN_PREFIX = 2;

/** How far his own notebooks outrank general Spanish for the same score. */
const CORPUS_BOOST = 1.6;

/** How many prefix matches to rank; see keysWithPrefix for why not fewer. */
const WORD_SCAN = 600;
const PHRASE_SCAN = 200;

/* ------------------------------------------------------------------ index */

function addWord(index, word, weight, gloss, source) {
  const clean = String(word || '').trim();
  if (!clean || clean.length < 2) return;
  const key = fold(clean);
  const seen = index.words.get(key);
  if (seen) {
    // The same word from both sources: keep the better weight, and keep his
    // own definition over a generic gloss.
    seen.weight = Math.max(seen.weight, weight);
    if (source === 'corpus') { seen.source = 'corpus'; if (gloss) seen.gloss = gloss; }
    else if (!seen.gloss && gloss) seen.gloss = gloss;
    return;
  }
  index.words.set(key, { word: clean, weight, gloss: gloss || '', source });
}

function addPhrase(index, phrase, weight, gloss, source) {
  const clean = String(phrase || '').replace(/\s+/g, ' ').trim();
  if (!clean || clean.indexOf(' ') < 0) return;
  const key = fold(clean);
  const seen = index.phrases.get(key);
  if (seen) {
    seen.weight = Math.max(seen.weight, weight);
    if (source === 'corpus') { seen.source = 'corpus'; if (gloss) seen.gloss = gloss; }
    else if (!seen.gloss && gloss) seen.gloss = gloss;
    return;
  }
  index.phrases.set(key, { phrase: clean, weight, gloss: gloss || '', source });
}

function addNext(index, after, continuation, weight, source) {
  const key = fold(String(after || '').trim());
  const text = String(continuation || '').replace(/\s+/g, ' ').trim();
  if (!key || !text) return;
  const list = index.next.get(key) || [];
  const seen = list.find((c) => fold(c.text) === fold(text));
  if (seen) { seen.weight = Math.max(seen.weight, weight); if (source === 'corpus') seen.source = 'corpus'; }
  else list.push({ text, weight, source });
  index.next.set(key, list);
}

/**
 * Fold both sources into one index.
 *
 * `corpus` is whatever /api/vocab?suggest=1 returned, or null when it has not
 * answered — the general half stands on its own, which is the whole reason it
 * is bundled rather than fetched.
 */
export function buildIndex({ corpus = null, general = null } = {}) {
  const index = {
    words: new Map(),
    phrases: new Map(),
    next: new Map(),
    keys: [],
    phraseKeys: [],
    entries: 0
  };

  if (general) {
    const words = general.words || [];
    const glosses = general.glosses || {};
    // Position in the list is the frequency signal: the file is written most
    // common first, so an early word must beat a late one on a shared prefix.
    words.forEach((w, i) => {
      addWord(index, w, (words.length - i) / words.length, glosses[w] || '', 'general');
    });
    for (const p of general.phrases || []) {
      addPhrase(index, p.es, 0.9, p.en || '', 'general');
      // A phrase is also a continuation of its own first word, so that a space
      // after `sin` already proposes `embargo`.
      const cut = p.es.indexOf(' ');
      if (cut > 0) addNext(index, p.es.slice(0, cut), p.es.slice(cut + 1), 0.9, 'general');
    }
    for (const [after, list] of Object.entries(general.next || {})) {
      (list || []).forEach((text, i) => addNext(index, after, text, 1 - i * 0.04, 'general'));
    }
  }

  if (corpus) {
    index.entries = corpus.entries || 0;
    for (const row of corpus.words || []) {
      const [term, weight, gloss] = row;
      if (String(term).includes(' ')) addPhrase(index, term, weight, gloss, 'corpus');
      else addWord(index, term, weight, gloss, 'corpus');
    }
    for (const row of corpus.phrases || []) addPhrase(index, row[0], row[1], row[2] || '', 'corpus');
    for (const [after, list] of Object.entries(corpus.next || {})) {
      for (const c of list || []) addNext(index, after, c[0], c[1], 'corpus');
    }
  }

  index.keys = [...index.words.keys()].sort();
  index.phraseKeys = [...index.phrases.keys()].sort();
  for (const [, list] of index.next) list.sort((a, b) => b.weight - a.weight);
  return index;
}

/** First position in a sorted array at or after `prefix`. */
function lowerBound(sorted, prefix) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < prefix) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * Every key starting with `prefix`, up to a ceiling.
 *
 * The ceiling has to be generous, because this scan is alphabetical and the
 * ranking that follows it is by frequency. Cut the shortlist at forty and a
 * two-letter prefix returns forty rare words beginning `coa…` and never
 * reaches `cotidiano` — the ranking is then perfect over the wrong list. A
 * few hundred string comparisons per keystroke cost nothing next to that.
 */
function keysWithPrefix(sorted, prefix, cap) {
  const out = [];
  for (let i = lowerBound(sorted, prefix); i < sorted.length; i++) {
    if (!sorted[i].startsWith(prefix)) break;
    out.push(sorted[i]);
    if (out.length >= cap) break;
  }
  return out;
}

/* -------------------------------------------------------------- suggesting */

/**
 * Split the text behind the caret into the word being typed and what precedes
 * it. `partial` is empty when the caret sits just after a space, which is the
 * moment to propose a whole next word rather than the end of this one.
 */
export function splitTail(before) {
  const partial = (before.match(TRAILING_WORD) || [''])[0];
  const head = before.slice(0, before.length - partial.length);
  const words = head.split(WORD_SPLIT).filter(Boolean);
  return { partial, head, words };
}

/** True when the text is a word the index already knows, exactly as typed. */
export function knownWord(index, word) {
  const key = fold(String(word || '').trim());
  return Boolean(key && index.words.has(key));
}

/**
 * Candidates for the caret, best first.
 *
 * Each carries `from`/`text` so that accepting is a plain splice — the caller
 * never has to work out how much of what was typed the suggestion replaces.
 * That matters because a completion may correct an accent Shin left off, in
 * which case it replaces more than it appends.
 */
export function suggest(index, before, opts = {}) {
  const limit = opts.limit || 6;
  const minPrefix = opts.minPrefix ?? MIN_PREFIX;
  const { partial, words } = splitTail(before);
  const typedLen = partial.length;
  const from = before.length - typedLen;
  const out = [];
  const push = (c) => { if (c.text.length > typedLen || c.corrects) out.push(c); };

  const make = (full, score, kind, source, gloss) => {
    // Index entries are stored in their dictionary form, which is lower case.
    // Accepting one at the start of a sentence must not take his capital off
    // the front of it — the completion ends the word, it does not restyle it.
    let text = full;
    if (partial && partial[0] !== partial[0].toLowerCase() && text[0] === text[0].toLowerCase()) {
      text = text[0].toUpperCase() + text.slice(1);
    }
    return {
      kind,
      source,
      gloss: gloss || '',
      label: full,
      from,
      text,
      ghost: text.slice(typedLen),
      corrects: text.slice(0, typedLen) !== partial,
      score: score * (source === 'corpus' ? CORPUS_BOOST : 1)
    };
  };

  // --- set phrases, probing backwards ------------------------------------
  //
  // `sin emb` should offer `sin embargo`, which means matching the partial
  // together with the words in front of it. The longer the matched run, the
  // more certain the suggestion, so the score rises with the number of whole
  // words behind the caret that the phrase already accounts for.
  for (let back = Math.min(words.length, MAX_PHRASE_WORDS - 1); back >= 0; back--) {
    const lead = words.slice(words.length - back);
    const probeWords = back ? lead.concat(partial ? [partial] : []) : (partial ? [partial] : []);
    if (!probeWords.length) continue;
    const probe = fold(probeWords.join(' '));
    if (!back && probe.length < minPrefix) continue;
    // How much of the phrase is already on the page, so the replacement can
    // start at the partial word rather than rewriting what is already right.
    // With nothing half-typed the space after the last whole word has been
    // written too, and the phrase has to be cut past its own space to match.
    const consumed = back ? probe.length - typedLen + (partial ? 0 : 1) : 0;
    for (const key of keysWithPrefix(index.phraseKeys, probe, PHRASE_SCAN)) {
      const rec = index.phrases.get(key);
      if (fold(rec.phrase).length <= probe.length) continue;
      const rest = rec.phrase.slice(consumed);
      const c = make(rest, 1 + back * 0.25 + rec.weight * 0.1, 'phrase', rec.source, rec.gloss);
      c.label = rec.phrase;
      push(c);
    }
  }

  // --- the word being typed ----------------------------------------------
  if (typedLen >= minPrefix) {
    const probe = fold(partial);
    for (const key of keysWithPrefix(index.keys, probe, WORD_SCAN)) {
      const rec = index.words.get(key);
      // A folded match of the same length is the word he already typed: worth
      // offering only when accepting would put an accent back on it.
      if (rec.word.length === typedLen && rec.word === partial) continue;
      push(make(rec.word, 0.55 + rec.weight * 0.45, 'word', rec.source, rec.gloss));
    }
  }

  // --- what usually follows the word just finished ------------------------
  if (!typedLen && words.length) {
    const previous = words[words.length - 1];
    const list = index.next.get(fold(previous)) || [];
    for (const c of list.slice(0, 6)) {
      const cand = make(c.text, 0.8 + c.weight * 0.2, 'next', c.source);
      // `cabo` on its own says nothing; the list shows what it follows.
      cand.label = previous + ' ' + c.text;
      push(cand);
    }
  }

  // Two sources and three kinds can all arrive at the same string; the best
  // score wins and the rest are dropped, so the list never repeats itself.
  const best = new Map();
  for (const c of out) {
    const key = fold(c.text);
    const seen = best.get(key);
    if (!seen || c.score > seen.score) best.set(key, c);
  }
  return [...best.values()].sort((a, b) => b.score - a.score || a.text.length - b.text.length).slice(0, limit);
}

/**
 * How much of a candidate one press of the space bar takes: the first word of
 * it, plus the space itself.
 */
export function acceptOneWord(candidate, typedLen) {
  const rest = candidate.text.slice(typedLen);
  const cut = rest.search(/\s/);
  if (cut < 0) return { text: candidate.text, done: true };
  return { text: candidate.text.slice(0, typedLen + cut), done: false };
}

/**
 * Whether the space bar should complete or just type a space.
 *
 * `always` is the literal reading: space takes the suggestion, whatever it is.
 * It is not the default, because `de` is a word and `descubrir` is a
 * suggestion, and a box that turns one into the other every time he types
 * `de ` is unusable. In `safe` mode a completion never overrides something
 * that is already a Spanish word in its own right — those he has to Tab for.
 */
export function spaceAccepts(index, partial, mode) {
  if (!partial) return false;
  if (mode === 'always') return true;
  return !knownWord(index, partial);
}

/* ------------------------------------------------------------------ widget */

const MIRRORED = [
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'letterSpacing',
  'lineHeight', 'textTransform', 'textIndent', 'wordSpacing', 'textAlign',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'boxSizing'
];

/**
 * Hang the ghost text and the candidate list off a textarea.
 *
 * The ghost is a second copy of the text, laid exactly under the real one with
 * everything typed rendered transparent, so what shows through is only the
 * proposed ending — sitting where the caret is because it is the same text in
 * the same box, not because anything measured the caret.
 *
 * Returns a handle: `setIndex` to swap the vocabulary in once the API answers,
 * `setSpaceMode`, and `destroy`.
 */
export function attach(textarea, options = {}) {
  const doc = textarea.ownerDocument;
  let index = options.index || buildIndex({});
  let spaceMode = options.spaceMode === 'always' ? 'always' : 'safe';
  let candidates = [];
  let picked = 0;
  let dismissed = false;
  let steered = false;

  const wrap = doc.createElement('div');
  wrap.className = 'esac';
  textarea.parentNode.insertBefore(wrap, textarea);

  const mirror = doc.createElement('div');
  mirror.className = 'esac-mirror';
  mirror.setAttribute('aria-hidden', 'true');
  const typedSpan = doc.createElement('span');
  typedSpan.className = 'esac-typed';
  const ghostSpan = doc.createElement('span');
  ghostSpan.className = 'esac-ghost';
  mirror.append(typedSpan, ghostSpan);

  const list = doc.createElement('div');
  list.className = 'esac-list';
  list.setAttribute('role', 'listbox');
  list.hidden = true;

  const live = doc.createElement('div');
  live.className = 'esac-live';
  live.setAttribute('aria-live', 'polite');

  wrap.append(mirror, textarea, list, live);
  textarea.classList.add('esac-input');
  textarea.setAttribute('autocomplete', 'off');
  textarea.setAttribute('autocorrect', 'off');
  textarea.setAttribute('spellcheck', 'false');

  function syncMirror() {
    const cs = getComputedStyle(textarea);
    for (const prop of MIRRORED) mirror.style[prop] = cs[prop];
    // Positioned from the textarea's own offset rather than pinned to the
    // wrapper's corner: the box it is mirroring may carry a margin, and the
    // ghost has to sit on the text, not near it.
    mirror.style.top = textarea.offsetTop + 'px';
    mirror.style.left = textarea.offsetLeft + 'px';
    mirror.style.width = textarea.offsetWidth + 'px';
    mirror.style.height = textarea.offsetHeight + 'px';
    mirror.style.borderRadius = cs.borderRadius;
    mirror.scrollTop = textarea.scrollTop;
  }

  /** The ghost can only be trusted where the caret is: at the end of the text. */
  function atEnd() {
    const caret = textarea.selectionStart;
    return caret === textarea.selectionEnd && !textarea.value.slice(caret).trim();
  }

  function clear() {
    candidates = [];
    picked = 0;
    steered = false;
    typedSpan.textContent = '';
    ghostSpan.textContent = '';
    ghostSpan.classList.remove('corrects');
    list.hidden = true;
    list.textContent = '';
  }

  function draw() {
    if (!candidates.length) { clear(); return; }
    const c = candidates[picked];
    const before = textarea.value.slice(0, textarea.selectionStart);
    typedSpan.textContent = before;
    ghostSpan.textContent = c.ghost;
    ghostSpan.classList.toggle('corrects', c.corrects);
    syncMirror();

    list.textContent = '';
    candidates.forEach((cand, i) => {
      const row = doc.createElement('button');
      row.type = 'button';
      row.className = 'esac-item' + (i === picked ? ' on' : '');
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', i === picked ? 'true' : 'false');

      const word = doc.createElement('span');
      word.className = 'esac-word';
      word.textContent = cand.label;
      row.appendChild(word);

      const tag = doc.createElement('span');
      tag.className = 'esac-src ' + cand.source;
      tag.textContent = cand.source === 'corpus' ? 'tu cuaderno' : 'general';
      row.appendChild(tag);

      if (cand.gloss) {
        const g = doc.createElement('span');
        g.className = 'esac-gloss';
        g.textContent = cand.gloss;
        row.appendChild(g);
      }
      // A tap must not take the focus off the box, or the caret moves and the
      // splice below would land in the wrong place.
      row.addEventListener('mousedown', (e) => e.preventDefault());
      row.onclick = () => { picked = i; accept(candidates[i].text); };
      list.appendChild(row);
    });
    list.hidden = false;
  }

  function refresh() {
    if (dismissed || !atEnd()) { clear(); return; }
    const before = textarea.value.slice(0, textarea.selectionStart);
    candidates = suggest(index, before, { limit: options.limit || 5 });
    picked = 0;
    steered = false;
    draw();
    if (candidates.length) live.textContent = `Sugerencia: ${candidates[0].label}`;
  }

  function accept(fullText) {
    const c = candidates[picked];
    if (!c) return;
    const caret = textarea.selectionStart;
    const text = fullText === undefined ? c.text : fullText;
    const value = textarea.value.slice(0, c.from) + text + textarea.value.slice(caret);
    const at = c.from + text.length;
    textarea.value = value;
    textarea.setSelectionRange(at, at);
    clear();
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    if (options.onAccept) options.onAccept(c);
    textarea.focus();
    refresh();
  }

  function onKeyDown(e) {
    if (!candidates.length) {
      if (e.key === 'Escape') dismissed = false;
      return;
    }
    const c = candidates[picked];
    const typedLen = textarea.selectionStart - c.from;

    if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); accept(); return; }
    if (e.key === 'Escape') { e.preventDefault(); dismissed = true; clear(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); steered = true; picked = (picked + 1) % candidates.length; draw(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); steered = true; picked = (picked - 1 + candidates.length) % candidates.length; draw(); return; }
    // Enter writes a new line, as it must in a writing pad — unless he has
    // deliberately arrowed onto a candidate, which can only have been to take it.
    if (e.key === 'Enter' && steered) { e.preventDefault(); accept(); return; }
    if (e.key === 'ArrowRight' && atEnd()) {
      e.preventDefault();
      accept(acceptOneWord(c, typedLen).text);
      return;
    }
    if (e.key === ' ') {
      const partial = splitTail(textarea.value.slice(0, textarea.selectionStart)).partial;
      if (!spaceAccepts(index, partial, spaceMode)) return;
      e.preventDefault();
      const step = acceptOneWord(c, typedLen);
      accept(step.text + ' ');
    }
  }

  const onInput = () => { dismissed = false; refresh(); };
  const onScroll = () => { mirror.scrollTop = textarea.scrollTop; };
  const onBlur = () => clear();
  const onSelect = () => { if (!atEnd()) clear(); };

  textarea.addEventListener('input', onInput);
  textarea.addEventListener('keydown', onKeyDown);
  textarea.addEventListener('scroll', onScroll);
  textarea.addEventListener('blur', onBlur);
  textarea.addEventListener('click', onSelect);
  const onResize = () => syncMirror();
  (doc.defaultView || window).addEventListener('resize', onResize);
  syncMirror();

  return {
    element: wrap,
    setIndex(next) { index = next; refresh(); },
    setSpaceMode(mode) { spaceMode = mode === 'always' ? 'always' : 'safe'; },
    get spaceMode() { return spaceMode; },
    refresh,
    destroy() {
      textarea.removeEventListener('input', onInput);
      textarea.removeEventListener('keydown', onKeyDown);
      textarea.removeEventListener('scroll', onScroll);
      textarea.removeEventListener('blur', onBlur);
      textarea.removeEventListener('click', onSelect);
      (doc.defaultView || window).removeEventListener('resize', onResize);
      wrap.parentNode.insertBefore(textarea, wrap);
      textarea.classList.remove('esac-input');
      wrap.remove();
    }
  };
}

if (typeof window !== 'undefined') {
  window.EsAutocomplete = { fold, buildIndex, suggest, splitTail, knownWord, acceptOneWord, spaceAccepts, attach, MIN_PREFIX };
}
