/* ==========================================================================
   The Postgres connection itself. Everything that only needs to run a query
   lives in records.mjs, which imports no driver and is therefore testable
   without a database.
   ========================================================================== */

import pg from 'pg';

import { connectionFor } from './db-ssl.mjs';

const { Pool } = pg;

let pool = null;

export function getPool() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  if (!pool) {
    pool = new Pool({
      // No TLS on this machine or its Docker network; anywhere else TLS with
      // the certificate checked. See netlify/lib/db-ssl.mjs.
      ...connectionFor(url),
      max: 3,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 8_000
    });
    pool.on('error', (err) => console.error('[db] idle client error', err));
  }
  return pool;
}

export { ensureSchema, readCollection, writeRecord, secretsMatch, json } from './records.mjs';
