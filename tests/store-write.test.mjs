/* The store's write path, counted in round trips.
 *
 * A row-at-a-time loop passes every functional test and still fails in
 * production: a few hundred sequential queries against a hosted Postgres runs
 * past a serverless function's execution limit, the write never lands, and the
 * records sit in the browser looking saved. So these assertions are about HOW
 * MANY statements the write issues, not only what it returns.
 *
 * Everything here takes a fake `db`, which is why netlify/lib/records.mjs
 * imports no driver. */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const R = await import(join(HERE, '../netlify/lib/records.mjs'));

let pass = 0; const fails = [];
const check = (n, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) pass++; else fails.push(`${n}\n     expected ${E}\n     got      ${A}`);
};

const fakeDb = () => {
  const queries = [];
  return { queries, query: async (sql, params) => { queries.push({ sql: String(sql), params }); return { rows: [] }; } };
};

const books = (n) => Array.from({ length: n }, (_, i) => ({
  id: 'b' + i, title: 'Book ' + i, updatedAt: '2026-08-30T00:00:00.000Z'
}));

const write = async (records, collection = 'books') => {
  const db = fakeDb();
  const prepared = R.prepareRecords(collection, records);
  if (prepared.error) return { prepared, db, written: null };
  const written = await R.writeRecords(db, prepared.rows);
  return { prepared, db, written };
};

/* --- the regression this file exists for -------------------------------- */

{
  const { db, written } = await write(books(319));
  check('319 records all written', written, 319);
  check('in 2 statements, not 319', db.queries.length, 2);
  check('carrying every row', db.queries.reduce((n, q) => n + q.params.length / 5, 0), 319);
  check('first chunk is full', db.queries[0].params.length / 5, 200);
  check('second holds the remainder', db.queries[1].params.length / 5, 119);
}

{
  const { db } = await write(books(200));
  check('a chunk-sized write is one statement', db.queries.length, 1);
}
{
  const { db } = await write(books(201));
  check('one over the chunk takes two', db.queries.length, 2);
}
{
  const { db } = await write(books(1));
  check('a single edit is one statement', db.queries.length, 1);
  check('with five parameters', db.queries[0].params.length, 5);
}
{
  const { db, written } = await write([]);
  check('nothing to write issues nothing', [written, db.queries.length], [0, 0]);
}

/* --- placeholders line up with the parameters ---------------------------- */

{
  const { db } = await write(books(3));
  const q = db.queries[0];
  const highest = Math.max(...[...q.sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1])));
  check('the last placeholder matches the parameter count', highest, q.params.length);
  check('placeholders are unique and complete', new Set([...q.sql.matchAll(/\$(\d+)/g)].map(m => m[1])).size, 15);
  check('rows are comma separated, not concatenated', (q.sql.match(/\),\s*\(/g) || []).length, 2);
  check('the jsonb cast survives', /\$3::jsonb/.test(q.sql), true);
  check('it is still an upsert', /ON CONFLICT \(id\) DO UPDATE/.test(q.sql), true);
  check('last write still wins', /store_records\.updated_at <= EXCLUDED\.updated_at/.test(q.sql), true);
}

/* --- a repeated id would break ON CONFLICT ------------------------------- */

{
  const { db, written } = await write([
    { id: 'same', title: 'First', updatedAt: '2026-08-30T00:00:00.000Z' },
    { id: 'same', title: 'Second', updatedAt: '2026-08-30T01:00:00.000Z' }
  ]);
  check('a repeated id collapses to one row', written, 1);
  check('and it is the last one', /Second/.test(db.queries[0].params[2]), true);
}

/* --- shaping ------------------------------------------------------------- */

{
  const p = R.prepareRecords('books', [{ id: 'x', title: 'No stamp' }]);
  check('a missing timestamp is filled in', !Number.isNaN(Date.parse(p.rows[0][3])), true);
}
{
  const p = R.prepareRecords('books', [{ id: 'x', title: 'Bad stamp', updatedAt: 'not a date' }]);
  check('an unparseable timestamp is replaced', !Number.isNaN(Date.parse(p.rows[0][3])), true);
}
{
  const p = R.prepareRecords('books', [{ id: 'x', deleted: true, updatedAt: '2026-08-30T00:00:00.000Z' }]);
  check('a tombstone keeps its flag', p.rows[0][4], true);
}
{
  const p = R.prepareRecords('plants', [{ id: 'x', updatedAt: '2026-08-30T00:00:00.000Z' }]);
  check('the collection travels with the row', p.rows[0][1], 'plants');
}

/* --- rejections ---------------------------------------------------------- */

{
  const p = R.prepareRecords('books', [{ id: 'big', title: 'x'.repeat(70 * 1024) }]);
  check('an oversized record is refused', [p.code, p.status], ['record-too-large', 413]);
  check('and yields no rows to write', p.rows, undefined);
}
{
  const p = R.prepareRecords('books', [{ noId: true }, null, 'nonsense', { id: '' }]);
  check('unusable entries are skipped, not fatal', p.rows.length, 0);
}
{
  const p = R.prepareRecords('books', [{ noId: true }, { id: 'ok', title: 'Kept' }]);
  check('a good record survives a bad neighbour', p.rows.length, 1);
}

/* ------------------------------------------------------------------------ */

console.log(`\nstore writes: ${pass} passed, ${fails.length} failed`);
if (fails.length) { fails.forEach(f => console.error('  ✗ ' + f)); process.exit(1); }
