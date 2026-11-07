#!/usr/bin/env node
/* ==========================================================================
   Copy the site's Netlify Blobs into the S3 bucket the server uses.

     NETLIFY_SITE_ID=… NETLIFY_AUTH_TOKEN=… \
     S3_ENDPOINT=… S3_REGION=… S3_BUCKET=… S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=… \
       node scripts/copy-blobs-to-s3.mjs [--dry-run] [--store vocab-images] [--all]

   By default only `vocab-images` is copied: the pictures are the only blobs
   that are data. `passcode-failures` and `vocab-usage` are counters for a
   15-minute, hourly or daily window; anything in them is stale within a day
   of the move, so --all is there for completeness, not need.

   Safe to re-run: a key already in the bucket is skipped (the picture keys
   are hashes of their bytes, so the same key is the same picture). Prints keys and counts, never the token or the keys'
   secrets. Uses the --env-file of your choice for the values:
     node --env-file=.env.move scripts/copy-blobs-to-s3.mjs
   ========================================================================== */

import { getStore } from '@netlify/blobs';

import { createS3Blobs } from '../netlify/lib/s3-blobs.mjs';

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const named = argv.flatMap((a, i) => (a === '--store' && argv[i + 1] ? [argv[i + 1]] : []));
const stores = argv.includes('--all')
  ? ['vocab-images', 'passcode-failures', 'vocab-usage']
  : named.length ? named : ['vocab-images'];

const siteID = process.env.NETLIFY_SITE_ID;
const token = process.env.NETLIFY_AUTH_TOKEN;
if (!siteID || !token) {
  console.error('Set NETLIFY_SITE_ID and NETLIFY_AUTH_TOKEN (a personal access token).');
  process.exit(2);
}

let s3;
try {
  s3 = createS3Blobs();
} catch (err) {
  console.error(err.message);
  process.exit(2);
}

let copied = 0, skipped = 0, failed = 0;

for (const name of stores) {
  const from = getStore({ name, siteID, token });
  const to = s3.store(name);

  const existing = new Map();
  if (!dryRun) for (const b of (await to.list()).blobs) existing.set(b.key, b);

  const keys = [];
  for await (const page of from.list({ paginate: true })) for (const b of page.blobs) keys.push(b.key);
  console.log(`${name}: ${keys.length} in Netlify, ${existing.size} already in the bucket`);

  for (const key of keys) {
    if (existing.has(key)) {
      skipped++;
      continue;
    }
    if (dryRun) {
      console.log(`  would copy ${name}/${key}`);
      continue;
    }
    try {
      const blob = await from.getWithMetadata(key, { type: 'arrayBuffer' });
      if (!blob) {
        console.warn(`  gone before it was read: ${key}`);
        continue;
      }
      await to.set(key, blob.data, { metadata: blob.metadata || {} });
      copied++;
      console.log(`  copied ${name}/${key} (${blob.data.byteLength} bytes)`);
    } catch (err) {
      failed++;
      console.error(`  failed ${name}/${key}: ${err.message}`);
    }
  }
}

console.log(`${dryRun ? 'dry run: ' : ''}${copied} copied, ${skipped} already there, ${failed} failed`);
process.exit(failed ? 1 : 0);
