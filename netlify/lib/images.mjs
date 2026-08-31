/* ==========================================================================
   Where a vocabulary card's picture lives.

   Netlify Blobs in production, a directory on disk when running locally, so
   the upload and browse flows can be exercised without deploying. Both are
   behind the same three calls: put, get, remove.

   Keys are `<sha256 of the bytes>.<ext>`, which means the same screenshot
   uploaded twice costs one object, and a key never encodes anything about
   the entry it belongs to — the database column owns that relationship.
   ========================================================================== */

import { createHash } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const STORE = 'vocab-images';
const LOCAL_DIR = process.env.VOCAB_IMAGE_DIR || '.vocab-images';

/** What a browser may upload, and what we are willing to serve back. */
export const IMAGE_TYPES = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif']
]);

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * The Netlify blob store, or null when we are not running on Netlify.
 * getStore() throws rather than returning null when there is no blob
 * context, so the failure is caught and treated as "use the disk".
 */
async function blobStore() {
  try {
    const { getStore } = await import('@netlify/blobs');
    return getStore(STORE);
  } catch {
    return null;
  }
}

export function keyFor(bytes, contentType) {
  const ext = IMAGE_TYPES.get(contentType) || 'bin';
  return `${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}.${ext}`;
}

export async function putImage(bytes, contentType) {
  const key = keyFor(bytes, contentType);
  const store = await blobStore();
  if (store) {
    await store.set(key, bytes, { metadata: { contentType } });
    return key;
  }
  await mkdir(LOCAL_DIR, { recursive: true });
  await writeFile(path.join(LOCAL_DIR, key), Buffer.from(bytes));
  return key;
}

/** The bytes and their type, or null when the key is unknown. */
export async function getImage(key) {
  const store = await blobStore();
  if (store) {
    const res = await store.getWithMetadata(key, { type: 'arrayBuffer' });
    if (!res) return null;
    return {
      bytes: Buffer.from(res.data),
      contentType: res.metadata?.contentType || typeFromKey(key)
    };
  }
  try {
    return { bytes: await readFile(path.join(LOCAL_DIR, key)), contentType: typeFromKey(key) };
  } catch {
    return null;
  }
}

export async function removeImage(key) {
  const store = await blobStore();
  if (store) {
    await store.delete(key);
    return;
  }
  try {
    await unlink(path.join(LOCAL_DIR, key));
  } catch {
    /* already gone */
  }
}

/** Fall back to the extension when metadata is missing. */
export function typeFromKey(key) {
  const ext = String(key).split('.').pop();
  for (const [type, e] of IMAGE_TYPES) if (e === ext) return type;
  return 'application/octet-stream';
}

/** A key we generated: 32 hex characters and a known extension. */
export function isImageKey(key) {
  return /^[0-9a-f]{32}\.(jpg|png|webp|gif)$/.test(String(key || ''));
}
