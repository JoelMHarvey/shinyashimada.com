/* ==========================================================================
   /api/camera — where the balcony stream lives.

   The URL is held in an environment variable and handed out only to callers
   holding the passcode. That keeps a route into a home network out of git,
   out of the database, and out of the page source for anyone who has not
   unlocked the site.

   Be clear about what this does and does not buy: gating the URL narrows who
   learns it, but the relay itself is reachable by anyone who has it. Put
   Cloudflare Access in front of the tunnel if the stream itself must be
   authenticated — see homelab/README.md.
   ========================================================================== */

import { secretsMatch, json } from '../lib/records.mjs';

const ALLOWED_MODES = new Set(['iframe', 'hls']);

export default async function handler(req) {
  if (req.method !== 'GET') {
    return json({ error: 'Method not allowed.' }, 405, { Allow: 'GET' });
  }

  const expected = process.env.SITE_PASSCODE;
  if (!expected) {
    return json({
      error: 'Set SITE_PASSCODE before exposing the camera — this returns a route into a home network and will not run unprotected.',
      code: 'passcode-required'
    }, 503);
  }
  if (!secretsMatch(req.headers.get('x-store-passcode'), expected)) {
    return json({ error: 'Passcode required.', code: 'unauthorized' }, 401);
  }

  const url = process.env.CAMERA_STREAM_URL;
  if (!url) {
    return json({ error: 'No camera configured.', code: 'no-camera' }, 503);
  }

  // Only ever hand back an absolute https URL. A stray private address here
  // would simply hang in the browser, which looks like a bug rather than a
  // misconfiguration, so say so plainly instead.
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return json({ error: 'CAMERA_STREAM_URL is not a valid URL.', code: 'bad-camera-url' }, 500);
  }
  if (parsed.protocol !== 'https:') {
    return json({
      error: 'CAMERA_STREAM_URL must be https — a private or plain-http address is not reachable from a visitor’s browser.',
      code: 'bad-camera-url'
    }, 500);
  }

  const mode = ALLOWED_MODES.has(process.env.CAMERA_MODE) ? process.env.CAMERA_MODE : 'iframe';

  return json({
    ok: true,
    url: parsed.toString(),
    mode,
    label: process.env.CAMERA_LABEL || null
  });
}
