/**
 * Send unhandled server errors to GlitchTip (Sentry-compatible), with personal
 * data removed. No package: one fetch. Does nothing at all unless SENTRY_DSN is
 * set in the server's environment, so tests, local runs and a server without
 * the setting send nothing. The DSN is never in the repo and never reaches the
 * browser (this file is server-only).
 *
 * What leaves the app, and nothing else: the error's class name, its message
 * after scrub() (emails, IPs, numbers, tokens and quoted free text removed),
 * and the stack as file, function and line. No request body, query string,
 * cookie, header, user or IP address is ever read, so none can be sent. The
 * route is sent as the function's name ("/.netlify/functions/store"), never
 * the address asked for.
 *
 * The same reporter as the family's other apps (error-report.ts), as plain
 * JavaScript for this server. Keep the scrubbing and the event the same.
 */

export const MAX_MESSAGE = 200;
export const MAX_FRAMES = 40;
export const MAX_EVENTS_PER_MINUTE = 20;
const TIMEOUT_MS = 3000;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>)]+/gi
const IPV6 = /(?<![\w:.])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?![\w:])/g
const PG_VALUE = /=\s*\([^)]*\)/g
const QUOTED = /"[^"\n]*"|'[^'\n]*'/g
const BACKTICK = /`([^`\n]*)`/g
const CODE = /^[A-Za-z_][A-Za-z0-9_.]{0,60}(?:\(\))?$/
const TOKEN = /\b[A-Za-z0-9_-]{24,}\b/g
const NUMBER = /\d[\d.,:/-]*/g
const ERROR_CODE = /^[A-Z0-9_]{2,24}$/

/**
 * Remove personal data from an error message. Order matters.
 *
 * Strict on purpose: a message can quote what a person typed, or print the
 * whole query it was given (Prisma does). So only the first and last lines are
 * kept (the middle of a long message is where arguments are dumped), everything
 * in single or double quotes goes, every number goes, and so do emails, links,
 * IP addresses and long tokens. Code names in backticks stay. What cannot be
 * caught is free text with no quotes round it inside those two lines.
 */
export function scrub(text) {
  let s = text == null ? '' : String(text)
  let lines = s.split('\n').map((l) => l.trim()).filter(Boolean)
  if (lines.length > 2) lines = [lines[0], lines[lines.length - 1]]
  s = lines.join(' | ')
  s = s.replace(EMAIL, '[email]')
  s = s.replace(URL_RE, '[url]')
  s = s.replace(PG_VALUE, '=([value])')
  s = s.replace(QUOTED, '[text]')
  s = s.replace(BACKTICK, (m, inner) => (CODE.test(inner) ? m : '[text]'))
  s = s.replace(IPV6, '[ip]')
  s = s.replace(TOKEN, '[token]')
  s = s.replace(NUMBER, '[n]')
  return s.split(/\s+/).filter(Boolean).join(' ').slice(0, MAX_MESSAGE)
}

/** A machine code for the error (Prisma P2002, ECONNREFUSED, SQLSTATE), never text. */
export function errorCode(error) {
  const code = error?.code
  return typeof code === 'string' && ERROR_CODE.test(code) ? code : ''
}

/** Store URL and public key for a DSN, or null when it is missing or malformed. */
export function parseDsn(dsn) {
  if (!dsn) return null;
  try {
    const u = new URL(dsn.trim());
    const parts = u.pathname.split('/').filter(Boolean);
    const project = parts.pop() ?? '';
    if (!/^https?:$/.test(u.protocol) || !u.username || !/^\d+$/.test(project)) return null;
    const prefix = parts.length ? `/${parts.join('/')}` : '';
    return { url: `${u.protocol}//${u.host}${prefix}/api/${project}/store/`, key: u.username };
  } catch {
    return null;
  }
}

function cleanPath(file) {
  const f = file.replace(/^file:\/\//, '').replace(/^webpack-internal:\/\/\/?/, '').replace(/\?.*$/, '');
  const nm = f.lastIndexOf('node_modules/');
  if (nm >= 0) return f.slice(nm);
  const cwd = typeof process !== 'undefined' && typeof process.cwd === 'function' ? process.cwd() : '';
  if (cwd && f.startsWith(cwd + '/')) return f.slice(cwd.length + 1);
  for (const marker of ['/.next/', '/src/', '/app/', '/server/']) {
    const i = f.lastIndexOf(marker);
    if (i >= 0) return f.slice(i + 1);
  }
  return f.split('/').pop() ?? ''; // no home directory or user name
}

export function frames(stack) {
  const out = [];
  for (const line of (stack ?? '').split('\n')) {
    const m = /^\s*at (?:(.*?) \()?(.+?):(\d+):\d+\)?\s*$/.exec(line);
    if (!m) continue;
    out.push({
      filename: cleanPath(m[2]),
      function: scrub(m[1] ?? '<anonymous>').slice(0, 120),
      lineno: Number(m[3]),
      in_app: !m[2].includes('node_modules')
    });
  }
  return out.slice(0, MAX_FRAMES).reverse(); // Sentry wants the newest frame last
}

/** The whole of what is sent. Built from the error alone. ctx: { app, where?, route? } */
export function buildEvent(error, ctx) {
  const err = error instanceof Error ? error : new Error(typeof error === 'string' ? error : 'non-error thrown');
  const tags = { app: ctx.app };
  if (ctx.where) tags.where = scrub(ctx.where).slice(0, 80);
  const code = errorCode(error);
  if (code) tags.code = code;
  const digest = err.digest;
  if (typeof digest === 'string' && /^[\w-]{1,20}$/.test(digest)) tags.digest = digest;
  return {
    event_id: crypto.randomUUID().replace(/-/g, ''),
    timestamp: Date.now() / 1000,
    platform: 'node',
    level: 'error',
    logger: 'error-report',
    environment: process.env.APP_ENV || 'production',
    tags,
    ...(ctx.route ? { transaction: ctx.route.slice(0, 200) } : {}),
    exception: {
      values: [{ type: err.name || 'Error', value: scrub(err.message), stacktrace: { frames: frames(err.stack) } }]
    }
  };
}

const sent = [];
/** For tests. */
export function resetRateLimit() {
  sent.length = 0;
}

function allowed() {
  const now = Date.now();
  while (sent.length && now - sent[0] > 60_000) sent.shift();
  if (sent.length >= MAX_EVENTS_PER_MINUTE) return false;
  sent.push(now);
  return true;
}

/** Send one error. Resolves false (and does nothing) when no DSN is set. Never throws. */
export async function reportError(error, ctx) {
  try {
    const target = parseDsn(process.env.SENTRY_DSN);
    if (!target || !allowed()) return false;
    await fetch(target.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sentry-Auth': `Sentry sentry_version=7, sentry_client=error-report/1, sentry_key=${target.key}`
      },
      body: JSON.stringify(buildEvent(error, ctx)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store'
    }).catch(() => undefined); // reporting must never break the app
    return true;
  } catch {
    return false;
  }
}

/**
 * Report an error that ends the process. Node only.
 *
 * A plain Node process dies at once on an uncaught error or an unhandled
 * rejection, before a fetch could leave. So with a DSN set this takes over
 * the last step: it prints the error as Node would, waits for the report
 * (three seconds at most) and exits with code 1, so Docker restarts the
 * container as before. With no DSN nothing is installed and Node's own
 * behaviour is untouched.
 */
export function installProcessHandlers(app, { exit = (code) => process.exit(code), log = console } = {}) {
  if (typeof process === 'undefined' || typeof process.on !== 'function') return false;
  if (!parseDsn(process.env.SENTRY_DSN)) return false;
  if (globalThis.__errorReportInstalled) return false;
  globalThis.__errorReportInstalled = true;
  let dying = false;
  const fatal = (where) => async (err) => {
    if (dying) return;
    dying = true;
    try {
      log.error(err);
      await reportError(err, { app, where });
    } finally {
      exit(1);
    }
  };
  process.on('unhandledRejection', fatal('unhandledRejection'));
  process.on('uncaughtException', fatal('uncaughtException'));
  return true;
}
