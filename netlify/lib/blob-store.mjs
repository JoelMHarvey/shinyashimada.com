/* ==========================================================================
   Which blob store a named store opens: Netlify Blobs, or an S3 bucket.

   Three things keep state in blobs — the vocabulary pictures
   (`vocab-images`), the passcode-guessing counters (`passcode-failures`) and
   the review spend guard (`vocab-usage`). On Netlify they are Netlify Blobs.
   Off Netlify (server/server.mjs) the same calls go to an S3-compatible
   bucket when S3_BUCKET is set, through a store with the same get / set /
   getWithMetadata / delete / list shape (s3-blobs.mjs).

   Neither available: this throws, exactly as Netlify's getStore() does
   outside Netlify, and each caller already falls back — pictures to a
   directory on disk, counters to memory.
   ========================================================================== */

let s3 = null;

/** True when the S3 settings are present, so the bucket is the store. */
export function s3Configured(env = process.env) {
  return Boolean(env.S3_BUCKET && env.S3_ENDPOINT);
}

/**
 * A store by name. `options` is what Netlify's getStore takes besides the
 * name (`consistency`); the bucket is read-after-write consistent, so it
 * needs none.
 */
export async function openStore(name, options = {}) {
  if (s3Configured()) {
    if (!s3) {
      const { createS3Blobs } = await import('./s3-blobs.mjs');
      s3 = createS3Blobs();
    }
    return s3.store(name);
  }
  const { getStore } = await import('@netlify/blobs');
  return getStore({ name, ...options });
}

/** For tests: forget the cached S3 client, so a changed env is re-read. */
export function _resetBlobStore() {
  s3 = null;
}
