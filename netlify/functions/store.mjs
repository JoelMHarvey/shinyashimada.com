/* ==========================================================================
   /api/store — synced collections backed by Postgres (Neon or Supabase).

   GET  /api/store?health=1              -> { database, authRequired }
   GET  /api/store?collection=plants     -> { records: [...] }
   POST /api/store  { collection, records: [...] }

   Collections in use: `plants`, `tastings`, `books`.

   joelmharvey.com shows the same book library from its own origin, so the
   responses carry CORS headers for an allowlist of sites (see lib/cors.mjs).

   Records are stored whole in a JSONB column; `id`, `updated_at` and
   `deleted` are mirrored into real columns so merges and filters stay cheap.
   Writes are last-write-wins on updated_at.

   Environment:
     DATABASE_URL   Postgres connection string (required for cloud sync)
     SITE_PASSCODE  shared secret required for writes, and for reading any
                    collection not listed in PUBLIC_READ
   ========================================================================== */

import pg from 'pg';

import { corsHeaders, preflight } from '../lib/cors.mjs';

const { Pool } = pg;

/** Collections a visitor may read without the passcode. */
const PUBLIC_READ = new Set(['tastings']);

/** Guard rails so a bad client cannot exhaust the database. */
const MAX_RECORDS_PER_WRITE = 500;
const MAX_RECORD_BYTES = 64 * 1024;
const COLLECTION_RE = /^[a-z][a-z0-9_-]{0,40}$/;

let pool = null;
let schemaReady = null;

function getPool() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: url,
      max: 3,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 8_000,
      // Neon and Supabase both terminate TLS with certificates the Lambda
      // trust store does not carry; the connection is still encrypted.
      ssl: url.includes('localhost') || url.includes('127.0.0.1')
        ? false
        : { rejectUnauthorized: false }
    });
    pool.on('error', (err) => console.error('[store] idle client error', err));
  }
  return pool;
}

async function ensureSchema(db) {
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
    schemaReady = null;           // let a later invocation retry
    throw err;
  });
  return schemaReady;
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders
    }
  });
}

/** Constant-time-ish comparison so the passcode cannot be probed byte by byte. */
function secretsMatch(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

function isAuthed(req) {
  const expected = process.env.SITE_PASSCODE;
  if (!expected) return true;                     // no passcode configured = open
  const given = req.headers.get('x-store-passcode');
  return secretsMatch(given, expected);
}

function rowToRecord(row) {
  return {
    ...row.data,
    id: row.id,
    updatedAt: new Date(row.updated_at).toISOString(),
    deleted: row.deleted
  };
}

export default async function handler(req) {
  /* Answered before anything else: a preflight carries no passcode and must
     not be measured against one. */
  const pre = preflight(req);
  if (pre) return pre;

  /* Every reply below needs the same cross-origin headers, so bind them once
     rather than threading `req` through each call. */
  const cors = corsHeaders(req);
  const reply = (body, status = 200, extra = {}) => json(body, status, { ...cors, ...extra });

  const url = new URL(req.url);
  const authRequired = !!process.env.SITE_PASSCODE;
  const db = getPool();

  if (url.searchParams.has('health')) {
    let database = false;
    if (db) {
      try {
        await db.query('SELECT 1');
        database = true;
      } catch (err) {
        console.error('[store] health check failed', err);
      }
    }
    return reply({ ok: true, database, authRequired });
  }

  if (!db) {
    return reply(
      {
        error: 'Cloud sync is not configured. Set DATABASE_URL in the Netlify site environment.',
        code: 'no-database'
      },
      503
    );
  }

  try {
    await ensureSchema(db);
  } catch (err) {
    console.error('[store] schema init failed', err);
    return reply({ error: 'Database is unavailable.', code: 'schema-failed' }, 503);
  }

  /* ------------------------------------------------------------- read -- */

  if (req.method === 'GET') {
    const collection = url.searchParams.get('collection');
    if (!collection || !COLLECTION_RE.test(collection)) {
      return reply({ error: 'A valid `collection` is required.', code: 'bad-collection' }, 400);
    }
    if (!PUBLIC_READ.has(collection) && !isAuthed(req)) {
      return reply({ error: 'Passcode required.', code: 'unauthorized' }, 401);
    }

    const since = url.searchParams.get('since');
    const params = [collection];
    let sql = 'SELECT id, data, updated_at, deleted FROM store_records WHERE collection = $1';
    if (since) {
      params.push(since);
      sql += ' AND updated_at > $2';
    }
    sql += ' ORDER BY updated_at DESC LIMIT 5000';

    const { rows } = await db.query(sql, params);
    return reply({ records: rows.map(rowToRecord), serverTime: new Date().toISOString() });
  }

  /* ------------------------------------------------------------ write -- */

  if (req.method === 'POST') {
    if (!isAuthed(req)) {
      return reply({ error: 'Passcode required.', code: 'unauthorized' }, 401);
    }

    let body;
    try {
      body = await req.json();
    } catch {
      return reply({ error: 'Body must be JSON.', code: 'bad-json' }, 400);
    }

    const collection = body?.collection;
    const records = body?.records;
    if (!collection || !COLLECTION_RE.test(collection)) {
      return reply({ error: 'A valid `collection` is required.', code: 'bad-collection' }, 400);
    }
    if (!Array.isArray(records) || records.length === 0) {
      return reply({ error: '`records` must be a non-empty array.', code: 'bad-records' }, 400);
    }
    if (records.length > MAX_RECORDS_PER_WRITE) {
      return reply({ error: `At most ${MAX_RECORDS_PER_WRITE} records per request.`, code: 'too-many' }, 413);
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      let written = 0;

      for (const raw of records) {
        if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id) continue;

        const serialised = JSON.stringify(raw);
        if (serialised.length > MAX_RECORD_BYTES) {
          await client.query('ROLLBACK');
          return reply({ error: 'A record exceeds the 64KB limit.', code: 'record-too-large' }, 413);
        }

        const updatedAt = raw.updatedAt && !Number.isNaN(Date.parse(raw.updatedAt))
          ? new Date(raw.updatedAt).toISOString()
          : new Date().toISOString();

        await client.query(
          `INSERT INTO store_records (id, collection, data, updated_at, deleted)
           VALUES ($1, $2, $3::jsonb, $4, $5)
           ON CONFLICT (id) DO UPDATE
             SET data       = EXCLUDED.data,
                 updated_at = EXCLUDED.updated_at,
                 deleted    = EXCLUDED.deleted,
                 collection = EXCLUDED.collection
           WHERE store_records.updated_at <= EXCLUDED.updated_at`,
          [raw.id, collection, serialised, updatedAt, !!raw.deleted]
        );
        written++;
      }

      await client.query('COMMIT');
      return reply({ ok: true, written });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[store] write failed', err);
      return reply({ error: 'Could not save.', code: 'write-failed' }, 500);
    } finally {
      client.release();
    }
  }

  return reply({ error: 'Method not allowed.' }, 405, { Allow: 'GET, POST, OPTIONS' });
}
