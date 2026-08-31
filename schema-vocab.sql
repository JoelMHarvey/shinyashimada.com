-- shinyashimada.com — Spanish vocabulary, imported from Shin's OneNote notebooks.
--
-- This is deliberately a set of real columns rather than another JSONB
-- collection in `store_records`: the vocab is queried by topic, level and
-- part of speech to build quiz decks, and those filters want indexes.
--
-- Apply with:  node --env-file=.env scripts/migrate-vocab.mjs
-- Works as-is on Neon.

-- Topics map one-to-one onto OneNote sections / lesson pages. Labels are
-- carried in the three languages Shin reads, matching data/italian.json.
CREATE TABLE IF NOT EXISTS vocab_topics (
  id          TEXT PRIMARY KEY,               -- slug, e.g. 'comida'
  language    TEXT NOT NULL DEFAULT 'es',     -- room for future decks
  label_en    TEXT NOT NULL,
  label_ja    TEXT,
  label_es    TEXT,
  level       TEXT,                           -- 'a1' | 'a2' | 'b1' | 'b2' | NULL
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vocab_entries (
  id             BIGSERIAL PRIMARY KEY,
  language       TEXT NOT NULL DEFAULT 'es',
  topic_id       TEXT NOT NULL REFERENCES vocab_topics(id) ON DELETE CASCADE,

  term           TEXT NOT NULL,               -- the Spanish headword

  -- The DELE C1/C2 source is monolingual: a term is explained in Spanish,
  -- not translated. `definition` is what the quiz shows; when `cloze` is
  -- true the term has been masked out of it with ____ , because the source
  -- sentence used the very word being asked about.
  definition     TEXT,
  cloze          BOOLEAN NOT NULL DEFAULT false,

  -- Kept for decks that do carry translations (the Italian deck's shape).
  gloss_en       TEXT,
  gloss_ja       TEXT,

  part_of_speech TEXT,                        -- 'noun' | 'verb' | 'adj' | ...
  gender         TEXT,                        -- 'm' | 'f' | 'mf' | NULL
  level          TEXT,

  example_es     TEXT,
  example_en     TEXT,
  note           TEXT,                        -- irregularity, usage warning

  source         TEXT,                        -- OneNote notebook/section/page
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Re-importing the same notebook must update rather than duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS vocab_entries_unique_term
  ON vocab_entries (language, topic_id, lower(term));

-- Deck building filters on topic, then optionally level.
CREATE INDEX IF NOT EXISTS vocab_entries_topic_idx
  ON vocab_entries (language, topic_id);

CREATE INDEX IF NOT EXISTS vocab_entries_level_idx
  ON vocab_entries (language, level);

-- Distractor picking wants same-topic, same-part-of-speech neighbours.
CREATE INDEX IF NOT EXISTS vocab_entries_pos_idx
  ON vocab_entries (language, topic_id, part_of_speech);

-- Migrations ----------------------------------------------------------------
--
-- Re-runnable, so this file stays the single description of the schema even
-- for a database created before these columns existed.

ALTER TABLE vocab_entries ADD COLUMN IF NOT EXISTS definition TEXT;
ALTER TABLE vocab_entries ADD COLUMN IF NOT EXISTS cloze BOOLEAN NOT NULL DEFAULT false;

-- Handy queries -------------------------------------------------------------

-- Deck for one topic:
--   SELECT term, gloss_en, gloss_ja FROM vocab_entries
--   WHERE language = 'es' AND topic_id = 'comida';

-- How much vocabulary came out of each notebook section:
--   SELECT topic_id, count(*) FROM vocab_entries GROUP BY 1 ORDER BY 2 DESC;
