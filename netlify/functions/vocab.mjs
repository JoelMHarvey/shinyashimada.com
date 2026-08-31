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

export default async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  if (req.method !== 'GET') {
    return json({ error: 'method_not_allowed' }, 405, req);
  }

  const url = new URL(req.url);
  const db = getPool();

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
  const filter = where.join(' AND ');

  try {
    const [entries, topics] = await Promise.all([
      db.query(
        `SELECT id, topic_id, term, definition, cloze, gloss_en, gloss_ja,
                part_of_speech, gender, level, example_es, example_en, note
           FROM vocab_entries
          WHERE ${filter}
          ORDER BY topic_id, lower(term)`,
        params
      ),
      db.query(
        `SELECT id, label_en, label_ja, label_es, level, sort_order
           FROM vocab_topics
          WHERE language = 'es'
          ORDER BY sort_order, id`
      )
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

    return json({ topics: topics.rows, entries: entries.rows }, 200, req);
  } catch (err) {
    console.error('[vocab] query failed', err);
    return json({ error: 'query_failed' }, 500, req);
  }
};
