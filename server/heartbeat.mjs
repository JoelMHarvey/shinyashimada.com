/* ==========================================================================
   The check-in to Mission Control after a scheduled run that worked.

   One GET to {HEARTBEAT_URL}/{HEARTBEAT_TOKEN}/{name}?project=...&expected=
   ...&grace=..., so the ops board can say "this job has not run since ...".
   With either variable unset or empty, nothing happens at all.

   Only a good run checks in: a function that throws, or answers anything but
   2xx, does not. The check-in itself can never fail or hold up the job: ten
   seconds at most, every error swallowed, and one log line that names the
   job but never the token or the address.
   ========================================================================== */

import { nextRun } from './cron.mjs';

const PROJECT = 'shinyashimada';
const NAME_OK = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TIMEOUT_MS = 10_000;
const DAY = 86_400;

/** "balcony-trello-sync" -> "shinyashimada-balcony-trello-sync". */
export function heartbeatName(fnName) {
  return `${PROJECT}-${String(fnName).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`.slice(0, 64);
}

/** Seconds between the next two runs of `expr`; a day if that cannot be worked out. */
export function expectedSeconds(expr, from = new Date()) {
  try {
    const first = nextRun(expr, from);
    const seconds = Math.round((nextRun(expr, first).getTime() - first.getTime()) / 1000);
    return seconds > 0 ? seconds : DAY;
  } catch {
    return DAY;
  }
}

export const graceSeconds = (expected) => Math.max(600, Math.floor(expected / 12));

/** The address to GET, or null when the check-in is switched off or the name is unusable. */
export function heartbeatUrl(fnName, expr, { env = process.env, now = () => new Date() } = {}) {
  const base = String(env.HEARTBEAT_URL || '').trim().replace(/\/+$/, '');
  const token = String(env.HEARTBEAT_TOKEN || '').trim();
  const name = heartbeatName(fnName);
  if (!base || !token || !NAME_OK.test(name)) return null;
  const expected = expectedSeconds(expr, now());
  return `${base}/${encodeURIComponent(token)}/${name}?project=${PROJECT}&expected=${expected}&grace=${graceSeconds(expected)}`;
}

/** Check in once. Never throws; resolves true only when Mission Control said 2xx. */
export async function checkIn(fnName, expr, { env = process.env, fetch = globalThis.fetch, log = console, now } = {}) {
  const name = heartbeatName(fnName);
  try {
    const url = heartbeatUrl(fnName, expr, { env, now });
    if (!url) return false;
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(TIMEOUT_MS) });
    res.body?.cancel?.().catch(() => {});
    if (res.ok) return true;
    log.error(`[heartbeat] ${name}: check-in answered ${res.status}`);
  } catch (err) {
    // The error's own message can quote the address, so only its kind is logged.
    const kind = [err?.name, err?.cause?.code].filter((s) => typeof s === 'string' && /^[\w-]{1,40}$/.test(s)).join(' ');
    log.error(`[heartbeat] ${name}: check-in failed (${kind || 'error'})`);
  }
  return false;
}

/**
 * Run a scheduled function, then check in if it worked. `run` returns the
 * function's Response; a throw passes straight through to the caller, and a
 * non-2xx Response is handed back without a check-in.
 */
export async function runWithHeartbeat(fnName, expr, run, opts = {}) {
  const response = await run();
  const status = response?.status;
  if (typeof status === 'number' && status >= 200 && status < 300) await checkIn(fnName, expr, opts);
  return response;
}
