/* The Spanish autocomplete: ranking, offsets and the space bar.
 *
 * `buildIndex` and `suggest` are pure by design, so what the writing box will
 * do to a given piece of half-written Spanish can be settled here, with the
 * real data/es-common.json behind it and a small stand-in for the notebook
 * rows — no browser, no database, no keystrokes. */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const A = await import(join(HERE, '../assets/js/es-autocomplete.js'));
const S = await import(join(HERE, '../netlify/lib/vocab-suggest.mjs'));

const general = JSON.parse(readFileSync(join(HERE, '../data/es-common.json'), 'utf8'));

let pass = 0; const fails = [];
const check = (n, a, e) => {
  const A_ = JSON.stringify(a), E = JSON.stringify(e);
  if (A_ === E) pass++; else fails.push(`${n}\n     expected ${E}\n     got      ${A_}`);
};

/** What the box would contain after accepting the best suggestion whole. */
const accept = (index, before, pick = 0) => {
  const c = A.suggest(index, before)[pick];
  return c ? before.slice(0, c.from) + c.text : before;
};

/* ------------------------------------------------------------ folding -- */

check('folds accents away', A.fold('erudición'), 'erudicion');
check('folds ñ onto n', A.fold('mañana'), 'manana');
// The ghost text is word.slice(typedLength); a fold that changed length would
// misalign every suggestion by a character, so this is load-bearing.
check('folding preserves length', A.fold('cañón árbol').length, 'cañón árbol'.length);

/* ------------------------------------------------- general Spanish only -- */

const g = A.buildIndex({ general });

check('finishes a set phrase from the middle of it', accept(g, 'sin emb'), 'sin embargo');
check('leaves what is already right alone', A.suggest(g, 'sin emb')[0].ghost, 'argo');
check('completes across a space, without doubling it', accept(g, 'No obstante, por '), 'No obstante, por último');
check('proposes what follows a phrasal verb', accept(g, 'llevar a '), 'llevar a cabo');
check('keeps his capital letter', accept(g, 'Me pare'), 'Me parece que');
check('puts a missing accent back', accept(g, 'corazo'), 'corazón');
// The index is written in dictionary form, which is lower case; a completion
// at the start of a sentence must not take his capital off the front of it.
check('keeps a sentence-initial capital', accept(g, 'Corazo'), 'Corazón');
check('and does not invent one', accept(g, 'un corazo'), 'un corazón');
check('marks a completion that rewrites what was typed', A.suggest(g, 'corazo')[0].corrects, true);
check('does not mark a plain ending as a rewrite', A.suggest(g, 'sin emb')[0].corrects, false);
check('says nothing on a single letter', A.suggest(g, 'e').length, 0);
check('carries the English gloss of a phrase', A.suggest(g, 'no obst')[0].gloss, 'nevertheless');

/* --------------------------------------------------------- the space bar -- */

// `de` is a word and `descubrir` is a suggestion. A box that turns one into
// the other every time he types `de ` would be unusable, so in the default
// setting the space bar never overrides a word that is already spelled right.
check('space leaves a real word alone', A.spaceAccepts(g, 'de', 'safe'), false);
check('space leaves an accented real word alone', A.spaceAccepts(g, 'está', 'safe'), false);
check('space completes a half-typed word', A.spaceAccepts(g, 'corazo', 'safe'), true);
check('the literal setting always accepts', A.spaceAccepts(g, 'de', 'always'), true);
check('space at a word boundary is just a space', A.spaceAccepts(g, '', 'always'), false);

// Space takes one word of a longer suggestion, not the whole thing: Tab is
// for that.
const phrase = A.suggest(g, 'sin emb')[0];
check('a one-word ending is taken whole', A.acceptOneWord(phrase, 3), { text: 'embargo', done: true });
const long = A.suggest(g, 'a pesar ')[0];
check('the phrase carries on past the first word', long.text, 'de que');
check('space takes only its first word', A.acceptOneWord(long, 0), { text: 'de', done: false });

/* ------------------------------------------------- his notebooks winning -- */

const rows = [
  { term: 'menoscabar', definition: 'Disminuir algo, quitarle parte de lo que tiene.', example_es: 'No quiso menoscabar su fama.' },
  { term: 'menester', definition: 'Falta o necesidad de algo; se dice de lo que hace falta.', example_es: 'Es menester actuar ya.' },
  { term: 'mentar', definition: 'Nombrar o mencionar a alguien.', example_es: 'Se dice de quien no se debe mentar.' },
  { term: 'zaherir', definition: 'Se dice de quien humilla a otro con sus palabras.', example_es: 'Se dice de un comentario que zahiere.' }
];
const corpus = S.buildSuggestIndex(rows);
const both = A.buildIndex({ corpus, general });

check('the notebook index counts its rows', corpus.entries, 4);
check('a headword outranks general Spanish on the same prefix', A.suggest(both, 'menos')[0].label, 'menoscabar');
check('and is marked as his own', A.suggest(both, 'menos')[0].source, 'corpus');
check('a headword brings his definition with it', A.suggest(both, 'menes')[0].gloss, 'Falta o necesidad de algo; se dice de lo que hace falta.');
// His notebooks are added to general Spanish, not swapped in for it: the
// connectives it has never heard of must still complete.
check('general Spanish still completes alongside it', accept(both, 'sin emb'), 'sin embargo');
check('and is still labelled as general', A.suggest(both, 'sin emb')[0].source, 'general');

// A run that recurs across the notebook is offered whole.
check('a repeated run becomes a phrase', corpus.phrases.some(p => p[0] === 'se dice de'), true);
check('and completes as one', accept(both, 'se dice '), 'se dice de');

/* --------------------------------------------------- ranking, not scanning -- */

// The prefix scan is alphabetical and the ranking after it is by frequency.
// A shortlist cut short would hand back whatever sorts first and never reach
// the word he meant — with 3,463 notebook entries in front of a two-letter
// prefix, that is the difference between a useful box and a random one.
const crowded = A.buildIndex({
  general,
  corpus: {
    entries: 300,
    // 300 rare words that all sort before `corazon`, and the common one last.
    words: Array.from({ length: 300 }, (_, i) => ['coa' + String(i).padStart(4, '0'), 0.01, ''])
      .concat([['cotidiano', 1, 'everyday']]),
    next: {},
    phrases: []
  }
});
check('the frequent word beats 300 alphabetically earlier ones',
  A.suggest(crowded, 'cot')[0].label, 'cotidiano');
check('and still wins on a two-letter prefix',
  A.suggest(crowded, 'co').some(c => c.label === 'cotidiano'), true);

/* -------------------------------------------------- counting the corpus -- */

check('English glosses are never counted as Spanish', S.tokenise('Se dice de algo'), ['se', 'dice', 'de', 'algo']);
check('cloze blanks are not words', S.tokenise('Es ____ hacerlo'), ['es', 'hacerlo']);
check('a long definition is cut to a clause', S.shortGloss({ definition: 'x'.repeat(300) }).length <= S.LIMITS.glossChars + 1, true);

/* --------------------------------------------------- nothing to work with -- */

const empty = A.buildIndex({});
check('an index with no sources suggests nothing', A.suggest(empty, 'sin emb').length, 0);
check('and still answers instead of throwing', Array.isArray(A.suggest(empty, '')), true);

/* -------------------------------------------------------------------- */

console.log(`\nes-autocomplete: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  fails.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
