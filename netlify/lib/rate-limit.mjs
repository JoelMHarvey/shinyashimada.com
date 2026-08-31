/* ==========================================================================
   A spend guard for the endpoints that cost money per call.

   Netlify functions are stateless and there is no Redis here, so the counter
   lives in the same blob store the pictures use. Counters are per clock hour
   and per clock day, which is coarse but is what this needs to be: the point
   is to bound a runaway bill, not to police a queue.

   Honest about what it is not: blob read-modify-write is not atomic, so two
   requests landing in the same millisecond can both read the same count and
   each write count+1, losing one increment. For a single-user study app
   behind a passcode that is an acceptable trade — the ceiling still holds to
   within a request or two. Do not reuse this where the limit is a security
   boundary rather than a cost one.
   ========================================================================== */

const STORE = 'vocab-usage';

async function store() {
  try {
    const { getStore } = await import('@netlify/blobs');
    return getStore(STORE);
  } catch {
    return null;
  }
}

/** Local counters, used when the blob store is unavailable (dev, tests). */
const memory = new Map();

function windowKeys(now = new Date()) {
  const iso = now.toISOString();
  return { hour: `h:${iso.slice(0, 13)}`, day: `d:${iso.slice(0, 10)}` };
}

async function bump(s, key) {
  if (!s) {
    const n = (memory.get(key) || 0) + 1;
    memory.set(key, n);
    return n;
  }
  const current = Number(await s.get(key)) || 0;
  const next = current + 1;
  // Blobs have no TTL, but a key names its own window and stale ones are
  // never read again; a handful of tiny objects a day is not worth a sweep.
  await s.set(key, String(next));
  return next;
}

async function peek(s, key) {
  if (!s) return memory.get(key) || 0;
  return Number(await s.get(key)) || 0;
}

/**
 * Count one use against the hourly and daily ceilings.
 * Returns { allowed, reason, hour, day } — the caller decides the response.
 */
export async function spend({ perHour, perDay }) {
  const s = await store();
  const { hour, day } = windowKeys();

  const [usedHour, usedDay] = await Promise.all([peek(s, hour), peek(s, day)]);

  if (usedDay >= perDay) {
    return { allowed: false, reason: 'daily', hour: usedHour, day: usedDay };
  }
  if (usedHour >= perHour) {
    return { allowed: false, reason: 'hourly', hour: usedHour, day: usedDay };
  }

  const [nowHour, nowDay] = await Promise.all([bump(s, hour), bump(s, day)]);
  return { allowed: true, hour: nowHour, day: nowDay };
}

/** Read the counters without spending one, for a health check. */
export async function usage() {
  const s = await store();
  const { hour, day } = windowKeys();
  const [h, d] = await Promise.all([peek(s, hour), peek(s, day)]);
  return { hour: h, day: d };
}
