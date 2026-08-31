#!/usr/bin/env node
/* ==========================================================================
   Apply schema-vocab.sql to the database in DATABASE_URL.

   Idempotent: every statement in the file is CREATE ... IF NOT EXISTS, so
   running it twice is a no-op.

     node --env-file=.env scripts/migrate-vocab.mjs
   ========================================================================== */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(here, '..', 'schema-vocab.sql');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Try: node --env-file=.env scripts/migrate-vocab.mjs');
  process.exit(1);
}

const sql = await readFile(schemaPath, 'utf8');

const client = new pg.Client({
  connectionString: url,
  // Neon terminates TLS with a certificate the default trust store does not
  // carry; the connection is still encrypted.
  ssl: url.includes('localhost') ? false : { rejectUnauthorized: false }
});

await client.connect();
try {
  await client.query(sql);
  const { rows } = await client.query(`
    SELECT table_name, (SELECT count(*) FROM information_schema.columns c
                        WHERE c.table_name = t.table_name) AS columns
    FROM information_schema.tables t
    WHERE table_schema = 'public' AND table_name LIKE 'vocab%'
    ORDER BY table_name
  `);
  for (const r of rows) console.log(`ok  ${r.table_name}  (${r.columns} columns)`);
} finally {
  await client.end();
}
