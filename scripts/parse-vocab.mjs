#!/usr/bin/env node
/* ==========================================================================
   Turn Shin's OneNote vocabulary export into the normalised JSON that
   scripts/import-vocab.mjs loads.

     node scripts/parse-vocab.mjs .onenote-export --out data/spanish-vocab.json
     node scripts/parse-vocab.mjs .onenote-export --sample 40
     node scripts/parse-vocab.mjs .onenote-export --max-definition 60

   The source is DELE C1/C2 material and is **monolingual**: each table row
   is a Spanish term in the first cell and a Spanish definition, synonym set
   or example sentence in the second. There are no English or Japanese
   glosses anywhere in it, so the deck asks "which term means this?" rather
   than translating.

   Rows are grouped under the `Unidad N` / `Las claves del nuevo DELE unidad N`
   headings that precede them in the page, which become the quiz topics.

   Nothing here writes to the database. Read the JSON, fix what is wrong,
   then run import-vocab.mjs.
   ========================================================================== */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/* ------------------------------------------------------------------ args */

const argv = process.argv.slice(2);
const value = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

const root = argv.find((a) => !a.startsWith('--'));
const outFile = value('out', 'data/spanish-vocab.json');
const sampleSize = Number(value('sample', 0)) || 0;
const maxDefinition = Number(value('max-definition', 0)) || 0;
// The export also holds Shin's goal pages and an Italian word list, so
// default to the pages whose titles say they are vocabulary lists.
const pageFilter = value('pages', 'vocabulario').toLowerCase();

if (!root) {
  console.error('usage: node scripts/parse-vocab.mjs <export-dir> [--out f.json] [--sample N] [--max-definition N]');
  process.exit(1);
}

/* ----------------------------------------------------------------- utils */

const slug = (s) =>
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

const tidy = (s) => decode(s).replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Walk the HTML keeping a stack of open cells, so a table nested inside a
 * cell is attributed to its own row rather than flattening into the parent.
 * A regex for <table>…</table> cannot do this — it stops at the first
 * closing tag and silently drops most of the page.
 */
/**
 * Recover the unit boundaries.
 *
 * The `Unidad N` headings all sit together in the page's index block at the
 * top, so the nearest preceding heading is useless — every table would
 * inherit the last index entry. But each index link is an `onenote:` URL
 * carrying an `object-id`, and that GUID is shared by the ids of the elements
 * belonging to that unit's table. The first place a GUID appears is therefore
 * where its unit's content starts.
 */
/**
 * A table-of-contents entry that names a section, rather than bookmarking a
 * single word or sentence. Shin's index mixes both: `Unidad 16` sits beside
 * `Talante` and `Tenemos que ser conscientes de lo que nos rodea`, and
 * treating the latter as a section start splits a real unit in half.
 *
 * `Fin de la lista N` is an end-of-list marker, not a section heading.
 */
const SECTION_LABEL =
  /^(unidad\s+\d+|las claves\b.*\bunidad\s+\d+|dale a dele\b|\p{L} de\s+\p{L}+)/iu;

function unitAnchors(html) {
  // Everything before the first table is the index block. An entry resolving
  // into it is pointing at its own paragraph, not at a section.
  const firstTable = html.indexOf('<table');
  const contentStarts = firstTable < 0 ? 0 : firstTable;

  const anchors = [];
  const linkRe = /<a\s+href="(onenote:[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const low = html.toLowerCase();
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const label = tidy(m[2].replace(/<[^>]+>/g, ''));
    const oid = /object-id=\{([0-9A-Fa-f-]+)\}/.exec(m[1]);
    if (!label || !oid) continue;
    if (!SECTION_LABEL.test(label)) continue;
    // Where does an element carrying this GUID first appear?
    const at = low.indexOf(`:{${oid[1].toLowerCase()}}`);
    // Links to the other two pages resolve to nothing here; skip them.
    if (at < 0) continue;
    // A section that resolves into the index block is the page's opening
    // section: its anchor is the outline itself, because there is no earlier
    // element to point at. Clamp it to where the content starts. Only the
    // first such entry can be the opening one.
    if (at < contentStarts) {
      if (anchors.some((a) => a.clamped)) continue;
      anchors.push({ label, offset: contentStarts, clamped: true });
      continue;
    }
    anchors.push({ label, offset: at, clamped: false });
  }
  anchors.sort((a, b) => a.offset - b.offset);
  // Keep the earliest anchor per label — an index may list a unit twice.
  const byLabel = new Map();
  for (const a of anchors) if (!byLabel.has(a.label)) byLabel.set(a.label, a);
  return [...byLabel.values()].sort((a, b) => a.offset - b.offset);
}

function readPage(html) {
  const anchors = unitAnchors(html);
  const headingAt = (offset) => {
    let found = null;
    for (const a of anchors) {
      if (a.offset <= offset) found = a.label;
      else break;
    }
    return found;
  };

  const rows = [];
  const cellStack = [];
  const rowStack = [];
  const imgStack = [];
  let pBuf = null;
  const rowStart = [];

  const TAG = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
  let cursor = 0;
  let m;

  const text = (chunk) => {
    if (!chunk) return;
    if (cellStack.length) cellStack[cellStack.length - 1].push(chunk);
    if (pBuf) pBuf.push(chunk);
  };

  while ((m = TAG.exec(html)) !== null) {
    text(html.slice(cursor, m.index));
    cursor = TAG.lastIndex;

    const tag = m[1].toLowerCase();
    const closing = m[0][1] === '/';

    if (!closing) {
      if (tag === 'tr') {
        rowStack.push([]);
        rowStart.push(m.index);
      } else if (tag === 'td' || tag === 'th') {
        cellStack.push([]);
        imgStack.push(0);
      } else if (tag === 'img') {
        if (imgStack.length) imgStack[imgStack.length - 1] += 1;
      } else if (tag === 'p') pBuf = [];
      else if (tag === 'br' || tag === 'li') text(' ');
    } else {
      if (tag === 'tr') {
        const row = rowStack.pop();
        const at = rowStart.pop() ?? m.index;
        if (row && row.length) rows.push({ cells: row, heading: headingAt(at) });
      } else if (tag === 'td' || tag === 'th') {
        const body = tidy(cellStack.pop().join(''));
        const imgs = imgStack.pop();
        if (rowStack.length) rowStack[rowStack.length - 1].push({ text: body, imgs });
      } else if (tag === 'p') {
        pBuf = null;
      }
    }
  }

  return rows;
}

/* --------------------------------------------------------------- cleaning */

/** Dictionary paste artefacts: "14. tr. Introducir…", "8Conseguir…", "loc. v. …". */
function cleanDefinition(s) {
  let out = s;
  out = out.replace(/^\s*\d+\s*[.)]?\s*/, '');
  out = out.replace(/^(loc\.\s*(v|adj|adv|s)?\.?|tr\.|intr\.|prnl\.|adj\.|adv\.|m\.|f\.|s\.\s*m\.|s\.\s*f\.)\s*/i, '');
  out = out.replace(/^\s*\d+\s*/, '');
  // Stray angle brackets survive from the source text itself, not from markup.
  out = out.replace(/\s*[<>]+\s*/g, ' ');
  return out.replace(/\s+/g, ' ').trim();
}

/** Accent- and case-insensitive form, for comparing a term to a definition. */
const fold = (s) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Blank the answer out of its own definition.
 *
 * The second column is often an example sentence using the very word being
 * asked about — 42% of rows leak the answer that way. Rather than throw
 * those away, mask the term so the card becomes a fill-in-the-blank, which
 * is a better question than the bare definition was.
 */
function maskTerm(term, definition) {
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
function looksLikeTerm(s) {
  if (!s) return false;
  const words = s.split(/\s+/);
  if (words.length > 5) return false;
  if (s.length > 48) return false;
  if (/[.!?;]$/.test(s)) return false;
  if (/^(index|unidad|sin\.|ant\.|ejemplo)/i.test(s)) return false;
  return /\p{L}/u.test(s);
}

function topicFor(heading, pageTitle) {
  // Rows sitting above the first unit anchor belong to the page's own opening
  // list, which the index never named. Attribute them to the page rather than
  // to a bucket called "no unit".
  if (!heading) {
    const n = /vocabulario\s*(\d+)?/i.exec(pageTitle || '');
    const num = n && n[1] ? ` ${n[1]}` : ' 1';
    return { id: `lista${slug(num)}`, label: `Lista${num}` };
  }
  const c1 = /Las claves del Nuevo DELE C1\s+unidad\s+(\d+)/i.exec(heading);
  if (c1) return { id: `claves-c1-${c1[1]}`, label: `Las claves C1 — unidad ${c1[1]}` };
  const claves = /Las claves del nuevo DELE\s+unidad\s+(\d+)/i.exec(heading);
  if (claves) return { id: `claves-${claves[1]}`, label: `Las claves — unidad ${claves[1]}` };
  const unidad = /^Unidad\s+(\d+)/i.exec(heading);
  if (unidad) return { id: `unidad-${unidad[1]}`, label: `Unidad ${unidad[1]}` };
  return { id: slug(heading), label: heading };
}

/* ------------------------------------------------------------------ walk */

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.name.endsWith('.html')) out.push(full);
  }
  return out;
}

const files = await walk(root);
if (!files.length) {
  console.error(`No .html files under ${root}. Run scripts/onenote-sync.mjs first.`);
  process.exit(1);
}

const topics = new Map();
const entries = [];
const seen = new Set();
const rejected = { noDefinition: 0, notATerm: 0, duplicate: 0, tooLong: 0, wrongPage: 0, overMasked: 0 };
let rowsSeen = 0;
let order = 0;

let pagesUsed = 0;

for (const file of files) {
  const html = await readFile(file, 'utf8');
  const pageTitle = tidy((html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || path.basename(file, '.html'));

  if (pageFilter && !pageTitle.toLowerCase().includes(pageFilter)) {
    rejected.wrongPage++;
    continue;
  }
  pagesUsed++;

  for (const row of readPage(html)) {
    rowsSeen++;
    const filled = row.cells.map((c) => c.text).filter(Boolean);
    if (filled.length < 2) {
      rejected.noDefinition++;
      continue;
    }

    const term = filled[0];
    const raw = cleanDefinition(filled[1]);
    const { text: definition, masked } = maskTerm(term, raw);

    if (!looksLikeTerm(term)) {
      rejected.notATerm++;
      continue;
    }
    if (!definition || definition.replace(/_+/g, '').trim().length < 8) {
      rejected.noDefinition++;
      continue;
    }
    // Masking can eat a whole word-family list ("carnada, carnadura, carnal"),
    // leaving a card nobody could answer. Half-blanked still works as a
    // collocation card ("Amor ____, instinto ____"); past half does not.
    const words = definition.split(/\s+/);
    if (words.filter((w) => w.includes('____')).length / words.length > 0.5) {
      rejected.overMasked++;
      continue;
    }
    if (maxDefinition && definition.length > maxDefinition) {
      rejected.tooLong++;
      continue;
    }

    const { id: topicId, label } = topicFor(row.heading, pageTitle);
    const key = `${topicId}::${term.toLowerCase()}`;
    if (seen.has(key)) {
      rejected.duplicate++;
      continue;
    }
    seen.add(key);

    if (!topics.has(topicId)) {
      topics.set(topicId, {
        id: topicId,
        label_en: label,
        label_ja: null,
        label_es: label,
        level: 'c1',
        sort_order: order++
      });
    }

    entries.push({
      topic_id: topicId,
      term,
      definition,
      cloze: masked,
      gloss_en: null,
      gloss_ja: null,
      part_of_speech: null,
      gender: null,
      level: 'c1',
      example_es: null,
      example_en: null,
      note: null,
      source: pageTitle
    });
  }
}

const payload = { topics: [...topics.values()], entries };

if (sampleSize) {
  // Spread the sample across topics rather than taking the first N, which
  // would all come from one unit and hide the variation.
  const byTopic = new Map();
  for (const e of entries) {
    if (!byTopic.has(e.topic_id)) byTopic.set(e.topic_id, []);
    byTopic.get(e.topic_id).push(e);
  }
  const perTopic = Math.max(1, Math.ceil(sampleSize / byTopic.size));
  const picked = [];
  for (const list of byTopic.values()) picked.push(...list.slice(0, perTopic));
  payload.entries = picked.slice(0, sampleSize);
  payload.topics = payload.topics.filter((t) => payload.entries.some((e) => e.topic_id === t.id));
}

await writeFile(outFile, JSON.stringify(payload, null, 2) + '\n', 'utf8');

console.log(`${pagesUsed} of ${files.length} pages matched --pages ${JSON.stringify(pageFilter)}; ${rowsSeen} table rows read.`);
console.log(`${entries.length} entries across ${topics.size} topics.`);
if (sampleSize) console.log(`Wrote a ${payload.entries.length}-entry sample to ${outFile}`);
else console.log(`Wrote ${outFile}`);
console.log('\nrows rejected:');
console.log(`  no definition in the second cell : ${rejected.noDefinition}`);
console.log(`  first cell is not a headword     : ${rejected.notATerm}`);
console.log(`  duplicate term within its unit   : ${rejected.duplicate}`);
console.log(`  on a page outside the filter     : ${rejected.wrongPage} page(s)`);
console.log(`  mostly blanks after masking      : ${rejected.overMasked}`);
if (maxDefinition) console.log(`  definition over ${maxDefinition} chars${' '.repeat(Math.max(0, 12 - String(maxDefinition).length))}: ${rejected.tooLong}`);

const perTopicCount = new Map();
for (const e of entries) perTopicCount.set(e.topic_id, (perTopicCount.get(e.topic_id) || 0) + 1);
console.log('\nper topic:');
for (const t of topics.values()) {
  console.log(`  ${t.id.padEnd(16)} ${String(perTopicCount.get(t.id) || 0).padStart(5)}  ${t.label_es}`);
}
