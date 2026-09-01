#!/usr/bin/env node
/* ==========================================================================
   Load normalised vocabulary JSON into Postgres.

     node --env-file=.env scripts/import-vocab.mjs data/spanish-vocab.json
     node --env-file=.env scripts/import-vocab.mjs --dry-run <file>

   The input is the shape scripts/parse-vocab.mjs produces from Shin's
   OneNote exports. Keeping the parse and the load apart means a bad parse
   can be inspected as a diff on a JSON file before anything touches the
   database.

     {
       "topics": [
         { "id": "comida", "label_en": "Food", "label_ja": "食べ物",
           "label_es": "Comida", "level": "a1", "sort_order": 1 }
       ],
       "entries": [
         { "topic_id": "comida", "term": "la manzana", "gloss_en": "apple",
           "gloss_ja": "りんご", "part_of_speech": "noun", "gender": "f",
           "level": "a1", "example_es": "...", "example_en": "...",
           "note": null, "source": "español / Lección 12 (comida)" }
       ]
     }

   Writes are upserts keyed on (language, topic_id, lower(term)), so
   re-importing a corrected export updates rows instead of duplicating them.
   Nothing is ever deleted: use --prune to also remove entries that the
   import no longer mentions, which is the only destructive flag here.
   ========================================================================== */

import { readFile } from 'node:fs/promises';

import pg from 'pg';

const LANGUAGE = 'es';
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const prune = args.includes('--prune');
const file = args.find((a) => !a.startsWith('--'));

if (!file) {
  console.error('usage: node --env-file=.env scripts/import-vocab.mjs [--dry-run] [--prune] <file.json>');
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url && !dryRun) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const payload = JSON.parse(await readFile(file, 'utf8'));

/* ---------------------------------------------------------------- validate */

const problems = [];
const topics = Array.isArray(payload.topics) ? payload.topics : [];
const entries = Array.isArray(payload.entries) ? payload.entries : [];

const topicIds = new Set();
for (const [i, t] of topics.entries()) {
  if (!SLUG_RE.test(String(t.id || ''))) problems.push(`topics[${i}]: bad id ${JSON.stringify(t.id)}`);
  else if (topicIds.has(t.id)) problems.push(`topics[${i}]: duplicate id ${t.id}`);
  else topicIds.add(t.id);
  if (!t.label_en) problems.push(`topics[${i}] (${t.id}): missing label_en`);
}

const seen = new Set();
for (const [i, e] of entries.entries()) {
  if (!e.term || !String(e.term).trim()) problems.push(`entries[${i}]: empty term`);
  if (!topicIds.has(e.topic_id)) problems.push(`entries[${i}] (${e.term}): unknown topic_id ${JSON.stringify(e.topic_id)}`);
  // A card needs something to show as its prompt: a Spanish definition
  // (the DELE decks) or a translation (a bilingual deck).
  if (!e.definition && !e.gloss_en && !e.gloss_ja)
    problems.push(`entries[${i}] (${e.term}): no definition and no gloss`);
  const key = `${e.topic_id}\u0000${String(e.term || '').toLowerCase().trim()}`;
  if (seen.has(key)) problems.push(`entries[${i}]: duplicate ${e.term} in ${e.topic_id}`);
  seen.add(key);
}

if (problems.length) {
  console.error(`${problems.length} problem(s) found:`);
  for (const p of problems.slice(0, 40)) console.error('  ' + p);
  if (problems.length > 40) console.error(`  … and ${problems.length - 40} more`);
  process.exit(1);
}

console.log(`${topics.length} topics, ${entries.length} entries — validated.`);

const byTopic = new Map();
for (const e of entries) byTopic.set(e.topic_id, (byTopic.get(e.topic_id) || 0) + 1);
for (const t of topics) console.log(`  ${t.id.padEnd(24)} ${String(byTopic.get(t.id) || 0).padStart(5)}  ${t.label_en}`);

if (dryRun) {
  console.log('\n--dry-run: nothing written.');
  process.exit(0);
}

/* -------------------------------------------------------------------- load */

const client = new pg.Client({
  connectionString: url,
  ssl: url.includes('localhost') ? false : { rejectUnauthorized: false }
});

await client.connect();

try {
  await client.query('BEGIN');

  for (const t of topics) {
    await client.query(
      `INSERT INTO vocab_topics (id, language, label_en, label_ja, label_es, level, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         label_en   = EXCLUDED.label_en,
         label_ja   = EXCLUDED.label_ja,
         label_es   = EXCLUDED.label_es,
         level      = EXCLUDED.level,
         sort_order = EXCLUDED.sort_order`,
      [t.id, LANGUAGE, t.label_en, t.label_ja ?? null, t.label_es ?? null, t.level ?? null, t.sort_order ?? 0]
    );
  }

  // One statement per row means one Singapore round trip per row: 3,463 of
  // them took six minutes. Batch instead, and count inserts against updates
  // by asking Postgres which rows were new.
  const CHUNK = 250;
  let inserted = 0;
  let updated = 0;

  for (let start = 0; start < entries.length; start += CHUNK) {
    const chunk = entries.slice(start, start + CHUNK);
    const cols = 14;
    const values = chunk
      .map((_, r) => `(${Array.from({ length: cols }, (_, c) => `$${r * cols + c + 1}`).join(',')})`)
      .join(',');
    const params = chunk.flatMap((e) => [
      LANGUAGE,
      e.topic_id,
      String(e.term).trim(),
      e.definition ?? null,
      Boolean(e.cloze),
      e.gloss_en ?? null,
      e.gloss_ja ?? null,
      e.part_of_speech ?? null,
      e.gender ?? null,
      e.level ?? null,
      e.example_es ?? null,
      e.example_en ?? null,
      e.note ?? null,
      e.source ?? null
    ]);

    const { rows } = await client.query(
      `INSERT INTO vocab_entries
         (language, topic_id, term, definition, cloze, gloss_en, gloss_ja,
          part_of_speech, gender, level, example_es, example_en, note, source)
       VALUES ${values}
       ON CONFLICT (language, topic_id, lower(term)) DO UPDATE SET
         definition     = EXCLUDED.definition,
         cloze          = EXCLUDED.cloze,
         gloss_en       = EXCLUDED.gloss_en,
         gloss_ja       = EXCLUDED.gloss_ja,
         part_of_speech = EXCLUDED.part_of_speech,
         gender         = EXCLUDED.gender,
         level          = EXCLUDED.level,
         example_es     = EXCLUDED.example_es,
         example_en     = EXCLUDED.example_en,
         note           = EXCLUDED.note,
         source         = EXCLUDED.source,
         updated_at     = now()
       RETURNING (xmax = 0) AS is_insert`,
      params
    );
    for (const r of rows) r.is_insert ? inserted++ : updated++;
    process.stdout.write(`\r  ${Math.min(start + CHUNK, entries.length)}/${entries.length}`);
  }
  process.stdout.write('\n');

  let pruned = 0;
  // An empty keep-list would make the NOT EXISTS below match every row, so a
  // no-entry import must never reach the delete.
  if (prune && entries.length) {
    // Compared as two parallel arrays rather than one concatenated key:
    // Postgres rejects NUL inside text, so the obvious separator is illegal,
    // and any printable one could in principle occur inside a term.
    const topics_ = entries.map((e) => e.topic_id);
    const terms_ = entries.map((e) => String(e.term).toLowerCase().trim());
    // Scoped to the topics this import covers, so importing one lesson file
    // cannot wipe every other lesson already in the table.
    const { rowCount } = await client.query(
      `DELETE FROM vocab_entries e
        WHERE e.language = $1
          AND e.topic_id = ANY($2::text[])
          AND NOT EXISTS (
                SELECT 1
                  FROM unnest($3::text[], $4::text[]) AS keep(topic, term)
                 WHERE keep.topic = e.topic_id
                   AND keep.term = lower(e.term)
              )`,
      [LANGUAGE, [...topicIds], topics_, terms_]
    );
    pruned = rowCount;
  } else if (prune) {
    console.warn('--prune ignored: the import contains no entries.');
  }

  await client.query('COMMIT');
  console.log(`\ninserted ${inserted}, updated ${updated}${prune ? `, pruned ${pruned}` : ''}.`);
} catch (err) {
  await client.query('ROLLBACK');
  console.error('import failed, rolled back:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
