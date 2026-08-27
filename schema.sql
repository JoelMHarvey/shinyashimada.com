-- shinyashimada.com — Postgres schema for the synced collections.
--
-- The `store` function creates this automatically on first use, so running
-- this file by hand is optional. It is kept here so the shape of the data is
-- reviewable without reading the function, and so the table can be created
-- ahead of time on a locked-down database role.
--
-- Works as-is on Neon and on Supabase's Postgres.

CREATE TABLE IF NOT EXISTS store_records (
  id          TEXT PRIMARY KEY,          -- client-generated UUID
  collection  TEXT NOT NULL,             -- 'plants' | 'tastings'
  data        JSONB NOT NULL,            -- the whole record, verbatim
  updated_at  TIMESTAMPTZ NOT NULL,      -- last-write-wins key
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted     BOOLEAN NOT NULL DEFAULT false   -- tombstone, so deletes sync
);

CREATE INDEX IF NOT EXISTS store_records_collection_idx
  ON store_records (collection, updated_at DESC);

-- Handy queries -------------------------------------------------------------

-- Everything currently on the balcony:
--   SELECT data->>'name', data->'care'->>'watered'
--   FROM store_records WHERE collection = 'plants' AND NOT deleted;

-- Purge tombstones older than a year (optional housekeeping):
--   DELETE FROM store_records
--   WHERE deleted AND updated_at < now() - interval '1 year';
