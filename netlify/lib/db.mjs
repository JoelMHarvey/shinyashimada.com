/* ==========================================================================
   The Postgres connection itself. Everything that only needs to run a query
   lives in records.mjs, which imports no driver and is therefore testable
   without a database.
   ========================================================================== */

import pg from 'pg';

const { Pool } = pg;

let pool = null;

export function getPool() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: url,
      max: 3,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 8_000,
      // Neon and Supabase terminate TLS with certificates the Lambda trust
      // store does not carry; the connection is still encrypted.
      ssl: url.includes('localhost') || url.includes('127.0.0.1')
        ? false
        : { rejectUnauthorized: false }
    });
    pool.on('error', (err) => console.error('[db] idle client error', err));
  }
  return pool;
}

export { ensureSchema, readCollection, writeRecord, secretsMatch, json } from './records.mjs';
