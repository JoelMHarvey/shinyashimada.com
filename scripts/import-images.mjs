#!/usr/bin/env node
/* ==========================================================================
   Attach the pictures OneNote held to the vocabulary already in Postgres.

     SITE_PASSCODE=… node --env-file=.env scripts/import-images.mjs \
       data/spanish-vocab.json --export .onenote-export

     … --dry-run          say what would happen, upload nothing
     … --base http://localhost:8899   upload somewhere other than production

   Images go to the live site's /api/vocab-image rather than straight to a
   store, because the blob store only exists inside Netlify — uploading
   through the endpoint is what puts them where the deployed site can read
   them. The database is then pointed at the returned key.

   Safe to re-run: an image already carrying the same key is left alone, and
   the key is a hash of the bytes, so re-uploading the same picture does not
   create a second object.

   Environment:
     DATABASE_URL    Postgres connection string
     SITE_PASSCODE   the shared passcode the endpoint requires
     VOCAB_API_BASE  defaults to https://shinyashimada.com
   ========================================================================== */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import pg from 'pg';

const argv = process.argv.slice(2);
const value = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

const file = argv.find((a) => !a.startsWith('--'));
const exportDir = value('export', '.onenote-export');
const base = (value('base', process.env.VOCAB_API_BASE || 'https://shinyashimada.com')).replace(/\/$/, '');
const dryRun = argv.includes('--dry-run');

if (!file) {
  console.error('usage: node --env-file=.env scripts/import-images.mjs <parsed.json> [--export dir] [--base url] [--dry-run]');
  process.exit(1);
}

const passcode = process.env.SITE_PASSCODE;
if (!passcode && !dryRun) {
  console.error('SITE_PASSCODE is not set — the upload endpoint will refuse every request.');
  process.exit(1);
}

const TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };

const payload = JSON.parse(await readFile(file, 'utf8'));
const wanted = payload.entries.filter((e) => e.image_ref);
console.log(`${wanted.length} of ${payload.entries.length} entries reference a picture.`);
if (!wanted.length) process.exit(0);

/* Which files did the sync actually download? Keyed by resource id. */
const onDisk = new Map();
try {
  for (const name of await readdir(path.join(exportDir, 'images'))) {
    const id = name.replace(/\.[^.]+$/, '');
    onDisk.set(id, path.join(exportDir, 'images', name));
  }
} catch {
  console.error(`No ${exportDir}/images. Re-run the sync with --images first.`);
  process.exit(1);
}
console.log(`${onDisk.size} image file(s) on disk.`);

const safe = (ref) => String(ref).replace(/[^A-Za-z0-9!._-]/g, '_').slice(0, 120);

let missing = 0;
const jobs = [];
for (const e of wanted) {
  const local = onDisk.get(safe(e.image_ref));
  if (!local) { missing++; continue; }
  jobs.push({ entry: e, local });
}
console.log(`${jobs.length} ready to upload, ${missing} referenced but not downloaded.`);

if (dryRun) {
  for (const j of jobs.slice(0, 10)) console.log(`  ${j.entry.term}  <-  ${path.basename(j.local)}`);
  console.log('\n--dry-run: nothing uploaded, nothing written.');
  process.exit(0);
}

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});
await client.connect();

const keyByRef = new Map();   // the same screenshot often sits on several rows
let uploaded = 0;
let attached = 0;
let failed = 0;

try {
  for (const [i, job] of jobs.entries()) {
    const ref = job.entry.image_ref;
    let key = keyByRef.get(ref);

    if (!key) {
      const ext = path.extname(job.local).slice(1).toLowerCase();
      const type = TYPES[ext];
      if (!type) { failed++; continue; }
      try {
        const res = await fetch(`${base}/api/vocab-image`, {
          method: 'POST',
          headers: { 'Content-Type': type, 'X-Store-Passcode': passcode },
          body: await readFile(job.local)
        });
        if (!res.ok) {
          console.log(`\n  ! ${job.entry.term}: upload returned ${res.status}`);
          failed++;
          continue;
        }
        key = (await res.json()).key;
        keyByRef.set(ref, key);
        uploaded++;
      } catch (err) {
        console.log(`\n  ! ${job.entry.term}: ${err.message}`);
        failed++;
        continue;
      }
    }

    const { rowCount } = await client.query(
      `UPDATE vocab_entries
          SET image_key = $1,
              image_alt = COALESCE($2, image_alt),
              updated_at = now()
        WHERE language = 'es' AND topic_id = $3 AND lower(term) = lower($4)`,
      [key, job.entry.image_alt ?? null, job.entry.topic_id, job.entry.term]
    );
    attached += rowCount;
    process.stdout.write(`\r  ${i + 1}/${jobs.length}`);
  }
  process.stdout.write('\n');
} finally {
  await client.end();
}

console.log(`\n${uploaded} distinct image(s) uploaded, ${attached} entr(ies) updated` +
  (failed ? `, ${failed} failed` : '') + '.');
