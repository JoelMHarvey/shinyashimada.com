/* ==========================================================================
   A very small cron, for the one scheduled function.

   Five fields (minute hour day-of-month month day-of-week), in UTC as
   Netlify reads them, with `*`, numbers, lists, ranges and `/` steps, and
   the usual rule that when both day fields are restricted either may match.
   No names (`MON`, `JAN`) and no `@daily` shorthands except the four
   Netlify documents (@yearly, @monthly, @weekly, @daily, @hourly).

   nextRun() walks forward a minute at a time. That is at most ~527,000
   steps for a once-a-year schedule and a few hundred for this site's daily
   one, which is nothing next to the clarity of not doing calendar
   arithmetic by hand.
   ========================================================================== */

const MACROS = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@hourly': '0 * * * *'
};

const RANGES = [
  [0, 59],   // minute
  [0, 23],   // hour
  [1, 31],   // day of month
  [1, 12],   // month
  [0, 7]     // day of week, 0 and 7 both Sunday
];

function parseField(text, [min, max]) {
  const set = new Set();
  for (const part of text.split(',')) {
    const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!m) throw new Error(`bad cron field "${text}"`);
    const step = m[2] ? Number(m[2]) : 1;
    let lo = min, hi = max;
    if (m[1] !== '*') {
      const [a, b] = m[1].split('-').map(Number);
      lo = a;
      hi = b ?? (m[2] ? max : a);
    }
    if (lo < min || hi > max || lo > hi || step < 1) throw new Error(`cron field "${text}" out of range`);
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  return set;
}

/** A parsed schedule: { minute, hour, dom, month, dow, domStar, dowStar }. */
export function parseCron(expr) {
  const text = MACROS[String(expr).trim()] || String(expr).trim();
  const fields = text.split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron needs five fields: "${expr}"`);
  const [minute, hour, dom, month, dow] = fields.map((f, i) => parseField(f, RANGES[i]));
  if (dow.has(7)) dow.add(0);
  return {
    minute, hour, dom, month, dow,
    domStar: fields[2] === '*',
    dowStar: fields[4] === '*'
  };
}

function matches(c, d) {
  if (!c.minute.has(d.getUTCMinutes()) || !c.hour.has(d.getUTCHours()) || !c.month.has(d.getUTCMonth() + 1)) {
    return false;
  }
  const domOk = c.dom.has(d.getUTCDate());
  const dowOk = c.dow.has(d.getUTCDay());
  if (c.domStar && c.dowStar) return true;
  if (c.domStar) return dowOk;
  if (c.dowStar) return domOk;
  return domOk || dowOk;
}

/** The first matching minute strictly after `from`, in UTC. */
export function nextRun(expr, from = new Date()) {
  const c = typeof expr === 'string' ? parseCron(expr) : expr;
  const d = new Date(from.getTime());
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(d.getUTCMinutes() + 1);
  for (let i = 0; i < 60 * 24 * 366 * 5; i++) {
    if (matches(c, d)) return d;
    d.setUTCMinutes(d.getUTCMinutes() + 1);
  }
  throw new Error(`cron "${expr}" never fires`);
}

/**
 * Run `job` on `expr` until stop() is called. Timers are re-armed from the
 * clock after every run, so a long run or a sleeping laptop does not drift
 * the schedule. Very long waits are chunked: setTimeout tops out at ~24.8
 * days.
 */
export function schedule(expr, job, { now = () => new Date(), log = console } = {}) {
  const parsed = parseCron(expr);
  let timer = null;
  let stopped = false;
  let upcoming = null;
  const MAX_WAIT = 2 ** 31 - 1;
  // unref: a pending schedule alone never keeps the process alive.
  const later = (fn, ms) => {
    timer = setTimeout(fn, ms);
    timer.unref?.();
  };

  function arm() {
    if (stopped) return;
    const at = nextRun(parsed, now());
    upcoming = at;
    const wait = () => {
      if (stopped) return;
      const ms = at.getTime() - now().getTime();
      if (ms > MAX_WAIT) {
        later(wait, MAX_WAIT);
      } else if (ms > 0) {
        later(fire, ms);
      } else {
        fire();
      }
    };
    const fire = async () => {
      try {
        await job(at);
      } catch (err) {
        log.error('[cron] job failed', err);
      }
      arm();
    };
    wait();
  }

  arm();
  return {
    /** When it fires next. */
    get next() {
      return upcoming;
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    }
  };
}
