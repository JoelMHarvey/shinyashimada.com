/* ==========================================================================
   /api/vocab-image — pictures attached to vocabulary cards.

   GET  /api/vocab-image?key=<key>   -> the image bytes
   POST /api/vocab-image             -> { key }   (raw body, Content-Type set)

   Uploads need the shared passcode. Reads do too when one is configured,
   because the pictures are part of the same private notebook as the words.

   Nothing here touches the database: a key is just an object in the blob
   store, and `vocab_entries.image_key` is what ties one to a card. That
   separation means an upload can be retried without leaving half a row
   behind, and an orphaned object costs nothing but space.

   Environment:
     SITE_PASSCODE   when set, required for both upload and read
     VOCAB_IMAGE_DIR local directory used when not running on Netlify
   ========================================================================== */

import { corsHeaders, preflight } from '../lib/cors.mjs';
import { secretsMatch } from '../lib/records.mjs';
import {
  IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  getImage,
  isImageKey,
  putImage
} from '../lib/images.mjs';

function json(body, status, req) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders(req)
    }
  });
}

function isAuthed(req) {
  const expected = process.env.SITE_PASSCODE;
  if (!expected) return true;
  return secretsMatch(req.headers.get('x-store-passcode'), expected);
}

export default async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  if (!isAuthed(req)) return json({ error: 'unauthorized' }, 401, req);

  const url = new URL(req.url);

  if (req.method === 'GET') {
    const key = url.searchParams.get('key');
    if (!isImageKey(key)) return json({ error: 'bad_key' }, 400, req);

    const found = await getImage(key);
    if (!found) return json({ error: 'not_found' }, 404, req);

    return new Response(found.bytes, {
      status: 200,
      headers: {
        'Content-Type': found.contentType,
        // The key is a hash of the bytes, so an image at a given key can
        // never change. Cache it hard.
        'Cache-Control': 'private, max-age=31536000, immutable',
        ...corsHeaders(req)
      }
    });
  }

  if (req.method === 'POST') {
    const contentType = (req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!IMAGE_TYPES.has(contentType)) {
      return json({ error: 'unsupported_type', accepted: [...IMAGE_TYPES.keys()] }, 415, req);
    }

    const bytes = Buffer.from(await req.arrayBuffer());
    if (!bytes.length) return json({ error: 'empty' }, 400, req);
    if (bytes.length > MAX_IMAGE_BYTES) {
      return json({ error: 'too_large', maxBytes: MAX_IMAGE_BYTES }, 413, req);
    }

    try {
      const key = await putImage(bytes, contentType);
      return json({ key, bytes: bytes.length }, 200, req);
    } catch (err) {
      console.error('[vocab-image] upload failed', err);
      return json({ error: 'store_failed' }, 500, req);
    }
  }

  return json({ error: 'method_not_allowed' }, 405, req);
};
