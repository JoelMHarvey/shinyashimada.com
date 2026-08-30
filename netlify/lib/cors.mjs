/* ==========================================================================
   Cross-origin access for the shared endpoints.

   The library lives on two sites — shinyashimada.com (this one) and
   joelmharvey.com (GitHub Pages) — but there is only one copy of the data,
   here in Postgres. joelmharvey.com therefore calls these functions from a
   different origin, which the browser blocks unless the response says
   otherwise.

   An allowlist rather than `*`, because these endpoints accept a passcode
   header: `*` would let any page on the internet make a visitor's browser
   replay it. Same-origin callers (shinyashimada.com itself) send no Origin
   header on same-origin requests and are unaffected either way.
   ========================================================================== */

const DEFAULT_ORIGINS = [
  'https://joelmharvey.com',
  'https://www.joelmharvey.com',
  'https://shinyashimada.com',
  'https://www.shinyashimada.com'
];

/** Localhost on any port, for `netlify dev` and the test harness. */
const LOCAL_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/**
 * Origins we answer to. `ALLOWED_ORIGINS` (comma separated) replaces the
 * defaults entirely, so a fork can point this at its own domains.
 */
export function allowedOrigins(env = process.env) {
  const configured = String(env.ALLOWED_ORIGINS || '').trim();
  if (!configured) return DEFAULT_ORIGINS.slice();
  return configured
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

/** The value to echo back, or null when the origin is not welcome. */
export function originAllowed(origin, env = process.env) {
  if (!origin) return null;
  const clean = String(origin).trim().replace(/\/$/, '');
  if (LOCAL_RE.test(clean)) return clean;
  return allowedOrigins(env).includes(clean) ? clean : null;
}

/**
 * Headers to merge into a response. Empty for an origin we do not allow, so
 * the browser refuses the response rather than us returning a partial grant.
 *
 * `Vary: Origin` matters: without it a CDN could serve one site's allowance
 * to the other and break whichever missed the cache.
 */
export function corsHeaders(req, env = process.env) {
  const allowed = originAllowed(req?.headers?.get?.('origin'), env);
  if (!allowed) return { Vary: 'Origin' };
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Store-Passcode',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
}

/** Answer a preflight, or null when this is not one. */
export function preflight(req, env = process.env) {
  if (req.method !== 'OPTIONS') return null;
  return new Response(null, { status: 204, headers: corsHeaders(req, env) });
}
