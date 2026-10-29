/* ==========================================================================
   The passcode check every gated function shares, with a brake on guessing.

   Without one, the passcode could be guessed as fast as Netlify will run a
   function, and it is a shared passphrase rather than a long random key. So
   wrong guesses are counted per client address over a short window, and once
   an address has used up its allowance every request from it is refused, the
   right passcode included, until the window rolls over. Refusing the right
   one too is the point: otherwise a guesser loses nothing by being locked.

   What is counted is *different* wrong passcodes, not wrong requests. A
   phone still holding last month's passcode sends that one value from every
   panel on every page load, and must not lock the whole household out; a
   guesser has to send a new value every time. Each is kept as a short HMAC
   keyed by the real passcode, so the store never holds a guess in a form
   that could be tested offline.

   The address is the one Netlify saw the connection come from (`context.ip`,
   or the `x-nf-client-connection-ip` header it sets). Never X-Forwarded-For:
   a client writes that header itself, so keying on it would hand every
   request a fresh allowance.

   Counters live in Netlify Blobs with strong consistency (an eventually
   consistent read would let a burst of guesses all see the same old count),
   or in memory where there is no blob store (dev, tests). A missing header is
   a visitor, not a guess, and does not count.
   ========================================================================== */

import { createHmac } from 'node:crypto';

import { secretsMatch } from './records.mjs';

export const MAX_FAILURES = 10;
export const WINDOW_MS = 15 * 60 * 1000;

const STORE = 'passcode-failures';
const memory = new Map();

async function store() {
  try {
    const { getStore } = await import('@netlify/blobs');
    return getStore({ name: STORE, consistency: 'strong' });
  } catch {
    return null;
  }
}

/** Where the request came from, as Netlify saw it. IPv6 is keyed by /64,
    since one connection usually has a whole /64 to rotate through. */
export function clientAddress(req, context) {
  const raw = String(
    context?.ip || req?.headers?.get?.('x-nf-client-connection-ip') || 'unknown'
  ).trim().toLowerCase();
  if (raw.includes(':') && !raw.includes('.')) {
    const groups = raw.split('::')[0].split(':').filter(Boolean);
    return groups.slice(0, 4).join(':') + '::/64';
  }
  return raw;
}

function windowKey(address, now) {
  const slot = Math.floor(now / WINDOW_MS);
  return `${slot}:${address.replace(/[^0-9a-z.:/]/g, '_')}`;
}

/** The distinct wrong guesses seen in this window, as fingerprints. */
async function seen(s, key) {
  if (!s) return memory.get(key) || [];
  try {
    const list = JSON.parse((await s.get(key)) || '[]');
    return Array.isArray(list) ? list : [];
  } catch (err) {
    if (err instanceof SyntaxError) return [];
    throw err;
  }
}

async function remember(s, key, list) {
  if (!s) {
    memory.set(key, list);
    return;
  }
  await s.set(key, JSON.stringify(list));
}

function fingerprint(given, expected) {
  return createHmac('sha256', String(expected)).update(String(given)).digest('hex').slice(0, 16);
}

/**
 * Check the X-Store-Passcode header against SITE_PASSCODE.
 * Returns 'ok', 'bad' or 'locked'. The caller decides what an unset
 * SITE_PASSCODE means for its endpoint; this assumes one is configured.
 */
export async function checkPasscode(req, context, { now = Date.now() } = {}) {
  const expected = process.env.SITE_PASSCODE;
  const given = req.headers.get('x-store-passcode');
  const key = windowKey(clientAddress(req, context), now);

  let s = null;
  let wrong = [];
  try {
    s = await store();
    wrong = await seen(s, key);
  } catch (err) {
    // A counter we cannot read must not take the site down with it.
    console.error('[passcode] failure counter unavailable', err?.message || err);
    s = null;
    wrong = memory.get(key) || [];
  }

  if (wrong.length >= MAX_FAILURES) return 'locked';
  if (secretsMatch(given, expected)) return 'ok';

  if (given) {
    const mark = fingerprint(given, expected);
    if (!wrong.includes(mark)) {
      const next = [...wrong, mark];
      try {
        await remember(s, key, next);
      } catch (err) {
        console.error('[passcode] could not count a failure', err?.message || err);
        memory.set(key, next);
      }
    }
  }
  return 'bad';
}

/** The body and headers for a locked-out address. */
export function lockedResponseInit() {
  return {
    body: { error: 'Too many wrong passcodes. Try again later.', code: 'too-many-attempts' },
    status: 429,
    headers: { 'Retry-After': String(Math.ceil(WINDOW_MS / 1000)) }
  };
}

/** For tests: forget every in-memory count. */
export function _resetMemory() {
  memory.clear();
}
