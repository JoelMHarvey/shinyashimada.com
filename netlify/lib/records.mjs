/* ==========================================================================
   Query helpers for the shared `store_records` table.

   Deliberately free of any driver import: everything takes a `db` handle with
   a `query(sql, params)` method. That keeps the sync logic testable against a
   fake database, and keeps `pg` confined to db.mjs.
   ========================================================================== */

export const MAX_RECORD_BYTES = 64 * 1024;

/* Rows per INSERT. The point is that it is not 1: a row-at-a-time loop costs a
   round trip to Postgres each time, and a few hundred of those runs past a
   serverless function's execution limit long before the data is saved. */
export const WRITE_CHUNK = 200;

let schemaReady = null;

export async function ensureSchema(db) {
  if (schemaReady) return schemaReady;
  schemaReady = db.query(`
    CREATE TABLE IF NOT EXISTS store_records (
      id          TEXT PRIMARY KEY,
      collection  TEXT NOT NULL,
      data        JSONB NOT NULL,
      updated_at  TIMESTAMPTZ NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      deleted     BOOLEAN NOT NULL DEFAULT false
    );
    CREATE INDEX IF NOT EXISTS store_records_collection_idx
      ON store_records (collection, updated_at DESC);
  `).catch((err) => {
    schemaReady = null;          // let a later invocation retry
    throw err;
  });
  return schemaReady;
}

/** Live (non-tombstoned) records of one collection, as plain objects. */
export async function readCollection(db, collection) {
  const { rows } = await db.query(
    `SELECT id, data, updated_at, deleted
       FROM store_records
      WHERE collection = $1 AND NOT deleted
      ORDER BY updated_at DESC
      LIMIT 5000`,
    [collection]
  );
  return rows.map((r) => ({
    ...r.data,
    id: r.id,
    updatedAt: new Date(r.updated_at).toISOString()
  }));
}

/** Upsert one record, last-write-wins on updated_at. */
export async function writeRecord(db, collection, record) {
  const updatedAt = record.updatedAt && !Number.isNaN(Date.parse(record.updatedAt))
    ? new Date(record.updatedAt).toISOString()
    : new Date().toISOString();

  await db.query(
    `INSERT INTO store_records (id, collection, data, updated_at, deleted)
     VALUES ($1, $2, $3::jsonb, $4, $5)
     ON CONFLICT (id) DO UPDATE
       SET data = EXCLUDED.data,
           updated_at = EXCLUDED.updated_at,
           deleted = EXCLUDED.deleted,
           collection = EXCLUDED.collection
     WHERE store_records.updated_at <= EXCLUDED.updated_at`,
    [record.id, collection, JSON.stringify(record), updatedAt, !!record.deleted]
  );
}

/** Constant-time-ish comparison so a secret cannot be probed byte by byte. */
export function secretsMatch(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

export function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders
    }
  });
}

/* ------------------------------------------------------------- writing -- */

/**
 * Check and shape records for writing, without touching a database.
 * Returns { rows } on success, or { error, code, status } to send back.
 *
 * Unusable entries are skipped rather than failing the batch; an oversized
 * one fails it, because silently dropping a book someone just saved is worse
 * than telling them the save did not happen.
 */
export function prepareRecords(collection, records) {
  const byId = new Map();

  for (const raw of records) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id) continue;

    const serialised = JSON.stringify(raw);
    if (serialised.length > MAX_RECORD_BYTES) {
      return { error: 'A record exceeds the 64KB limit.', code: 'record-too-large', status: 413 };
    }

    const updatedAt = raw.updatedAt && !Number.isNaN(Date.parse(raw.updatedAt))
      ? new Date(raw.updatedAt).toISOString()
      : new Date().toISOString();

    /* Last one wins on a repeated id: Postgres refuses an ON CONFLICT DO
       UPDATE that would touch the same row twice in one statement, which a
       row-at-a-time loop never had to care about. */
    byId.set(raw.id, [raw.id, collection, serialised, updatedAt, !!raw.deleted]);
  }

  return { rows: [...byId.values()] };
}

/**
 * Upsert prepared rows in as few statements as possible, last-write-wins on
 * updated_at. Takes a `db` with query(sql, params) — no driver import — so the
 * number of round trips it makes is testable.
 */
export async function writeRecords(db, rows) {
  for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
    const chunk = rows.slice(i, i + WRITE_CHUNK);
    const values = chunk
      .map((_, n) => {
        const b = n * 5;
        return `($${b + 1}, $${b + 2}, $${b + 3}::jsonb, $${b + 4}, $${b + 5})`;
      })
      .join(', ');

    await db.query(
      `INSERT INTO store_records (id, collection, data, updated_at, deleted)
       VALUES ${values}
       ON CONFLICT (id) DO UPDATE
         SET data       = EXCLUDED.data,
             updated_at = EXCLUDED.updated_at,
             deleted    = EXCLUDED.deleted,
             collection = EXCLUDED.collection
       WHERE store_records.updated_at <= EXCLUDED.updated_at`,
      chunk.flat()
    );
  }
  return rows.length;
}
