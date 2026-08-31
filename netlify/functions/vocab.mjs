/* ==========================================================================
   /api/vocab — Shin's Spanish vocabulary, straight out of Postgres.

   GET /api/vocab?health=1                  -> { database, entries, topics }
   GET /api/vocab                           -> { topics: [...], entries: [...] }
   GET /api/vocab?topic=comida              -> only that topic
   GET /api/vocab?level=a2                  -> only that level
   GET /api/vocab?counts=1                  -> units with a card count each
   GET /api/vocab?deck=1&topic=unidad-6     -> ready-to-play quiz questions

   The plain form hands back the raw rows and lets the page do what it likes.
   `deck=1` does the distractor picking here instead, because choosing three
   plausible wrong answers means looking at the whole topic — cheap in SQL,
   awkward once the rows are split across a paginated client.

   Read-only. Imports go in through scripts/import-vocab.mjs, which talks to
   the database directly rather than through this endpoint.

   Environment:
     DATABASE_URL   Postgres connection string (required)
     SITE_PASSCODE  when set, required for anything but ?health=1
   ========================================================================== */

import pg from 'pg';

import { corsHeaders, preflight } from '../lib/cors.mjs';
import { secretsMatch } from '../lib/records.mjs';
import { cleanDefinition, looksLikeTerm, maskTerm, slug } from '../lib/vocab-text.mjs';

const { Pool } = pg;

/** Guard rails so a crafted query cannot ask for the whole table at once. */
const MAX_DECK_SIZE = 4000;
const DEFAULT_DECK_SIZE = 300;
const CHOICES_PER_QUESTION = 4;
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const LANG_RE = /^[a-z]{2}$/;

let pool = null;

function getPool() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: url,
      max: 3,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 8_000,
      // Neon terminates TLS with a certificate the Lambda trust store does
      // not carry; the connection is still encrypted.
      ssl: url.includes('localhost') || url.includes('127.0.0.1')
        ? false
        : { rejectUnauthorized: false }
    });
    pool.on('error', (err) => console.error('[vocab] idle client error', err));
  }
  return pool;
}

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // The deck changes only when Shin re-imports his notebook, but a stale
      // deck mid-game would be confusing, so keep it short and revalidated.
      'Cache-Control': status === 200 ? 'public, max-age=60' : 'no-store',
      ...corsHeaders(req)
    }
  });
}

function isAuthed(req) {
  const expected = process.env.SITE_PASSCODE;
  if (!expected) return true;
  return secretsMatch(req.headers.get('x-store-passcode'), expected);
}

/** Fisher-Yates, seeded from Math.random — deck order need not be reproducible. */
function shuffle(items) {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Turn rows into quiz questions: show the gloss, pick the Spanish term.
 *
 * Distractors come from the same topic and, where there are enough of them,
 * the same part of speech — a question whose three wrong answers are all
 * obviously the wrong kind of word answers itself.
 */
function buildDeck(rows, lang, size) {
  // The Spanish deck is monolingual: the prompt is the definition. A deck
  // that does carry translations falls back to the gloss for `lang`.
  const promptOf = (r) =>
    r.definition || (lang === 'ja' ? r.gloss_ja || r.gloss_en : r.gloss_en || r.gloss_ja);

  const byTopic = new Map();
  for (const r of rows) {
    if (!byTopic.has(r.topic_id)) byTopic.set(r.topic_id, []);
    byTopic.get(r.topic_id).push(r);
  }

  const questions = [];
  for (const row of rows) {
    const prompt = promptOf(row);
    if (!prompt || !row.term) continue;

    const siblings = byTopic.get(row.topic_id) || [];
    const samePos = siblings.filter(
      (s) => s.id !== row.id && s.term !== row.term && s.part_of_speech && s.part_of_speech === row.part_of_speech
    );
    const anyOther = siblings.filter((s) => s.id !== row.id && s.term !== row.term);
    const source = samePos.length >= CHOICES_PER_QUESTION - 1 ? samePos : anyOther;

    const wrong = [];
    for (const cand of shuffle(source)) {
      if (wrong.length >= CHOICES_PER_QUESTION - 1) break;
      if (!wrong.includes(cand.term)) wrong.push(cand.term);
    }
    // A word with no neighbours cannot be made into a multiple choice.
    if (wrong.length < CHOICES_PER_QUESTION - 1) continue;

    questions.push({
      id: row.id,
      cat: row.topic_id,
      q: prompt,
      a: row.term,
      wrong,
      cloze: Boolean(row.cloze),
      note: row.note || null,
      example: row.example_es || null,
      exampleEn: row.example_en || null,
      pos: row.part_of_speech || null
    });
  }

  return shuffle(questions).slice(0, size);
}

/**
 * Writing is stricter than reading: a passcode must be configured *and*
 * match. Reads fall open when SITE_PASSCODE is unset, which is a reasonable
 * default for a personal site; letting anyone add rows would not be.
 */
function canWrite(req) {
  const expected = process.env.SITE_PASSCODE;
  if (!expected) return false;
  return secretsMatch(req.headers.get('x-store-passcode'), expected);
}

const MAX_WRITE_ENTRIES = 500;
const MAX_TERM = 120;
const MAX_DEFINITION = 2000;

/** Normalise one submitted entry, or explain why it cannot be stored. */
function prepare(raw) {
  const term = String(raw.term ?? '').trim().replace(/\s+/g, ' ');
  if (!term) return { error: 'a term is required' };
  if (term.length > MAX_TERM) return { error: `term is longer than ${MAX_TERM} characters` };
  if (!looksLikeTerm(term)) return { error: `"${term}" reads as a sentence, not a headword` };

  const topicId = String(raw.topic_id ?? '').trim();
  if (!SLUG_RE.test(topicId)) return { error: `bad topic id ${JSON.stringify(topicId)}` };

  const rawDefinition = String(raw.definition ?? '').trim();
  if (!rawDefinition) return { error: `"${term}" has no definition` };
  if (rawDefinition.length > MAX_DEFINITION) {
    return { error: `definition for "${term}" is longer than ${MAX_DEFINITION} characters` };
  }

  // Exactly what the OneNote import does, from the same module, so a card
  // typed by hand behaves like one that came out of the notebook.
  const { text: definition, masked } = maskTerm(term, cleanDefinition(rawDefinition));
  if (!definition || definition.replace(/_+/g, '').trim().length < 8) {
    return { error: `the definition for "${term}" is almost entirely the word itself` };
  }

  const imageKey = raw.image_key ? String(raw.image_key).trim() : null;
  if (imageKey && !/^[0-9a-f]{32}\.(jpg|png|webp|gif)$/.test(imageKey)) {
    return { error: `bad image key on "${term}"` };
  }

  return {
    entry: {
      topic_id: topicId,
      term,
      definition,
      cloze: masked,
      image_key: imageKey,
      image_alt: raw.image_alt ? String(raw.image_alt).trim().slice(0, 2000) : null,
      level: raw.level ? String(raw.level).trim().slice(0, 12) : null,
      note: raw.note ? String(raw.note).trim().slice(0, 500) : null,
      source: raw.source ? String(raw.source).trim().slice(0, 200) : 'added by hand'
    }
  };
}

export default async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  const url = new URL(req.url);
  const db = getPool();

  /* ---------------------------------------------------------------- write */

  if (req.method === 'POST' || req.method === 'DELETE') {
    if (!canWrite(req)) return json({ error: 'unauthorized' }, 401, req);
    if (!db) return json({ error: 'no_database' }, 503, req);

    if (req.method === 'DELETE') {
      const id = Number(url.searchParams.get('id'));
      if (!Number.isInteger(id) || id <= 0) return json({ error: 'bad_id' }, 400, req);
      try {
        const { rowCount } = await db.query(
          `DELETE FROM vocab_entries WHERE id = $1 AND language = 'es'`, [id]
        );
        return json({ deleted: rowCount }, rowCount ? 200 : 404, req);
      } catch (err) {
        console.error('[vocab] delete failed', err);
        return json({ error: 'query_failed' }, 500, req);
      }
    }

    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'bad_json' }, 400, req);
    }

    const submitted = Array.isArray(body?.entries) ? body.entries : [body];
    if (!submitted.length) return json({ error: 'nothing_submitted' }, 400, req);
    if (submitted.length > MAX_WRITE_ENTRIES) {
      return json({ error: 'too_many', max: MAX_WRITE_ENTRIES }, 413, req);
    }

    // Validate everything before writing anything, so a bad row twenty
    // lines into a paste does not leave the first nineteen committed.
    const ready = [];
    const rejected = [];
    for (const [i, raw] of submitted.entries()) {
      const { entry, error } = prepare(raw);
      if (error) rejected.push({ row: i + 1, error });
      else ready.push(entry);
    }
    if (rejected.length) return json({ error: 'invalid', rejected }, 400, req);

    const newTopic = body?.topic_label
      ? { id: slug(body.topic_label), label: String(body.topic_label).trim().slice(0, 120) }
      : null;

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      if (newTopic) {
        await client.query(
          `INSERT INTO vocab_topics (id, language, label_en, label_es, sort_order)
           VALUES ($1, 'es', $2, $2,
                   COALESCE((SELECT max(sort_order) + 1 FROM vocab_topics WHERE language = 'es'), 0))
           ON CONFLICT (id) DO NOTHING`,
          [newTopic.id, newTopic.label]
        );
      }

      // Every entry must land in a unit that exists, or the foreign key
      // would reject it with an error Shin cannot act on.
      const topicIds = [...new Set(ready.map((e) => e.topic_id))];
      const { rows: known } = await client.query(
        `SELECT id FROM vocab_topics WHERE id = ANY($1::text[])`, [topicIds]
      );
      const missing = topicIds.filter((id) => !known.some((k) => k.id === id));
      if (missing.length) {
        await client.query('ROLLBACK');
        return json({ error: 'unknown_topic', topics: missing }, 400, req);
      }

      let inserted = 0;
      let updated = 0;
      for (const e of ready) {
        const { rows } = await client.query(
          `INSERT INTO vocab_entries
             (language, topic_id, term, definition, cloze, image_key, image_alt,
              level, note, source)
           VALUES ('es',$1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (language, topic_id, lower(term)) DO UPDATE SET
             definition = EXCLUDED.definition,
             cloze      = EXCLUDED.cloze,
             image_key  = COALESCE(EXCLUDED.image_key, vocab_entries.image_key),
             image_alt  = COALESCE(EXCLUDED.image_alt, vocab_entries.image_alt),
             level      = EXCLUDED.level,
             note       = EXCLUDED.note,
             updated_at = now()
           RETURNING (xmax = 0) AS is_insert`,
          [e.topic_id, e.term, e.definition, e.cloze, e.image_key, e.image_alt,
           e.level, e.note, e.source]
        );
        rows[0].is_insert ? inserted++ : updated++;
      }

      await client.query('COMMIT');
      return json({ inserted, updated, topic: newTopic?.id ?? null }, 200, req);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[vocab] write failed', err);
      return json({ error: 'write_failed' }, 500, req);
    } finally {
      client.release();
    }
  }

  if (req.method !== 'GET') {
    return json({ error: 'method_not_allowed' }, 405, req);
  }

  if (url.searchParams.get('health')) {
    if (!db) return json({ database: false, entries: 0, topics: 0 }, 200, req);
    try {
      const { rows } = await db.query(`
        SELECT (SELECT count(*) FROM vocab_entries) AS entries,
               (SELECT count(*) FROM vocab_topics)  AS topics
      `);
      return json(
        {
          database: true,
          entries: Number(rows[0].entries),
          topics: Number(rows[0].topics),
          authRequired: Boolean(process.env.SITE_PASSCODE)
        },
        200,
        req
      );
    } catch (err) {
      console.error('[vocab] health failed', err);
      return json({ database: false, error: 'query_failed' }, 200, req);
    }
  }

  if (!isAuthed(req)) return json({ error: 'unauthorized' }, 401, req);
  if (!db) return json({ error: 'no_database' }, 503, req);

  const lang = LANG_RE.test(url.searchParams.get('lang') || '') ? url.searchParams.get('lang') : 'en';
  // Comma separated, because a round is built from whichever units are
  // ticked: `?topic=unidad-6,unidad-11`.
  const topics_ = (url.searchParams.get('topic') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const level = url.searchParams.get('level');

  if (topics_.some((t) => !SLUG_RE.test(t))) return json({ error: 'bad_topic' }, 400, req);
  if (level && !SLUG_RE.test(level)) return json({ error: 'bad_level' }, 400, req);

  // The unit list with a count each: a few hundred bytes, so the menu can be
  // drawn without shipping 3,000 questions to a phone that wants ten.
  if (url.searchParams.get('counts')) {
    try {
      const { rows } = await db.query(
        `SELECT t.id, t.label_en, t.label_ja, t.label_es, t.level, t.sort_order,
                count(e.id)::int AS count
           FROM vocab_topics t
           LEFT JOIN vocab_entries e ON e.topic_id = t.id AND e.language = 'es'
          WHERE t.language = 'es'
          GROUP BY t.id
          ORDER BY t.sort_order, t.id`
      );
      return json({ topics: rows }, 200, req);
    } catch (err) {
      console.error('[vocab] counts failed', err);
      return json({ error: 'query_failed' }, 500, req);
    }
  }

  const where = ["language = 'es'"];
  const params = [];
  if (topics_.length) {
    params.push(topics_);
    where.push(`topic_id = ANY($${params.length}::text[])`);
  }
  if (level) {
    params.push(level);
    where.push(`level = $${params.length}`);
  }

  // Browsing 3,463 cards wants a page at a time and a search box, not the
  // whole table.
  const q = (url.searchParams.get('q') || '').trim().slice(0, 80);
  if (q) {
    params.push(`%${q}%`);
    where.push(`(term ILIKE $${params.length} OR definition ILIKE $${params.length})`);
  }
  const askedLimit = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(askedLimit) && askedLimit > 0 ? Math.min(askedLimit, 500) : null;
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
  const filter2 = where.join(' AND ');

  try {
    const [entries, topics, total] = await Promise.all([
      db.query(
        `SELECT id, topic_id, term, definition, cloze, image_key, image_alt,
                gloss_en, gloss_ja, part_of_speech, gender, level,
                example_es, example_en, note
           FROM vocab_entries
          WHERE ${filter2}
          ORDER BY topic_id, lower(term)
          ${limit ? `LIMIT ${limit} OFFSET ${offset}` : ''}`,
        params
      ),
      db.query(
        `SELECT id, label_en, label_ja, label_es, level, sort_order
           FROM vocab_topics
          WHERE language = 'es'
          ORDER BY sort_order, id`
      ),
      db.query(`SELECT count(*)::int AS n FROM vocab_entries WHERE ${filter2}`, params)
    ]);

    if (url.searchParams.get('deck')) {
      const asked = Number(url.searchParams.get('size'));
      const size = Number.isFinite(asked) && asked > 0 ? Math.min(asked, MAX_DECK_SIZE) : DEFAULT_DECK_SIZE;
      return json(
        {
          lang,
          topics: topics.rows,
          questions: buildDeck(entries.rows, lang, size),
          total: entries.rowCount
        },
        200,
        req
      );
    }

    return json({
      topics: topics.rows,
      entries: entries.rows,
      total: total.rows[0].n,
      offset,
      limit
    }, 200, req);
  } catch (err) {
    console.error('[vocab] query failed', err);
    return json({ error: 'query_failed' }, 500, req);
  }
};
