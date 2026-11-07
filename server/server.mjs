#!/usr/bin/env node
/* ==========================================================================
   shinyashimada.com without Netlify: one small Node server that does what
   Netlify does for this site.

     - the static site, from the repository root, as Netlify serves it
       (server/static.mjs)
     - netlify.toml's [[redirects]] and [[headers]], read from the file
       itself (server/netlify-config.mjs), so /api/* reaches the functions
       through the same rule it does on Netlify
     - every netlify/functions/* at /.netlify/functions/<name>[/...], called
       with a standard Request and a context carrying the visitor's address
     - the scheduled function on its cron, in UTC (server/cron.mjs)
     - GET /api/health/live, 200 without touching the database

   Behind Caddy: TLS, compression and the domain are Caddy's. The visitor's
   address is the last X-Forwarded-For entry, which Caddy writes itself
   (with no trusted_proxies set it replaces whatever the client sent).

   Environment (server only; the functions read their own, see README):
     PORT                 default 8000
     HOST                 default 0.0.0.0
     SITE_URL             default https://shinyashimada.com (context.site.url)
     TRUST_PROXY          default on; "false" to ignore X-Forwarded-* and use
                          the socket's address (no proxy in front)
     SCHEDULED_FUNCTIONS  default on; "off" in any second copy of the app, so
                          only one runs the daily Trello sync
   ========================================================================== */

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { schedule } from './cron.mjs';
import { installNetlifyGlobal, loadFunctions, makeContext } from './functions.mjs';
import { fillTarget, headersFor, loadRoutingConfig, matchPattern } from './netlify-config.mjs';
import {
  STATIC_CACHE_CONTROL, contentTypeFor, notModified, readWithEtag, resolveStatic
} from './static.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');

/** Netlify's limit for a synchronous function's request body. */
export const MAX_BODY_BYTES = 6 * 1024 * 1024;

const FUNCTIONS_PREFIX = '/.netlify/functions/';
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer',
  'http2-settings'
]);

const off = (v) => /^(0|false|off|no)$/i.test(String(v ?? ''));

/** The visitor's address: Caddy's last X-Forwarded-For entry, or the socket. */
export function clientIp(req, { trustProxy = true } = {}) {
  const xff = req.headers['x-forwarded-for'];
  if (trustProxy && xff) {
    const last = String(xff).split(',').map((s) => s.trim()).filter(Boolean).pop();
    if (last) return last.replace(/^::ffff:/, '');
  }
  return String(req.socket?.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * The app: `handle(req, res)` for node:http, plus what tests and the
 * entry point need. `env` defaults to process.env, which is also what the
 * functions read.
 */
export async function createApp({
  root = ROOT,
  functionsDir = path.join(root, 'netlify', 'functions'),
  env = process.env,
  scheduler = !off(env.SCHEDULED_FUNCTIONS),
  log = console
} = {}) {
  installNetlifyGlobal(env);
  const trustProxy = !off(env.TRUST_PROXY);
  const siteUrl = env.SITE_URL || 'https://shinyashimada.com';
  const routing = loadRoutingConfig(root);
  const functions = await loadFunctions(functionsDir);

  const customPaths = new Map();
  for (const fn of functions.values()) for (const p of fn.paths) customPaths.set(p, fn);

  /* ------------------------------------------------------ responses -- */

  function send(res, status, headers, body, method) {
    res.statusCode = status;
    for (const [k, v] of Object.entries(headers)) if (v != null) res.setHeader(k, v);
    if (method === 'HEAD' || status === 204 || status === 304 || body == null) res.end();
    else res.end(body);
  }

  async function sendFile(req, res, file, status, pathname) {
    const { bytes, etag } = await readWithEtag(file);
    const headers = {
      'Content-Type': contentTypeFor(file),
      'Cache-Control': STATIC_CACHE_CONTROL,
      ETag: etag,
      ...headersFor(routing.headers, pathname)
    };
    if (status === 200 && notModified(req.headers['if-none-match'], etag)) {
      return send(res, 304, headers, null, req.method);
    }
    headers['Content-Length'] = bytes.length;
    return send(res, status, headers, bytes, req.method);
  }

  async function notFound(req, res, pathname) {
    const page = await resolveStatic(root, '/404.html');
    if (page?.file) return sendFile(req, res, page.file, 404, pathname);
    return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not Found', req.method);
  }

  function redirect(req, res, status, location, pathname, search) {
    let target = location;
    if (search && !target.includes('?')) target += search;
    return send(res, status, {
      Location: target,
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': STATIC_CACHE_CONTROL,
      ...headersFor(routing.headers, pathname)
    }, `Redirecting to ${target}`, req.method);
  }

  /* ------------------------------------------------------ functions -- */

  async function callFunction(req, res, fn, url) {
    if (fn.schedule) {
      // As on Netlify: a scheduled function has no public URL.
      return send(res, 403, { 'Content-Type': 'text/plain; charset=utf-8' },
        'Scheduled functions cannot be invoked over HTTP.', req.method);
    }

    const ip = clientIp(req, { trustProxy });
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (HOP_BY_HOP.has(k) || k.startsWith(':')) continue;
      for (const one of [].concat(v)) headers.append(k, one);
    }
    // The address the passcode brake keys on. Whatever a client sent under
    // this name is replaced, never trusted.
    headers.set('x-nf-client-connection-ip', ip);

    let body;
    if (!['GET', 'HEAD'].includes(req.method)) {
      try {
        body = await readBody(req, MAX_BODY_BYTES);
      } catch (err) {
        if (err.status === 413) {
          return send(res, 413, { 'Content-Type': 'application/json' },
            JSON.stringify({ error: 'Request body too large.' }), req.method);
        }
        throw err;
      }
    }

    const request = new Request(url.href, { method: req.method, headers, body });
    const context = makeContext({ ip, siteUrl });

    let response;
    try {
      response = await fn.call(request, context);
    } catch (err) {
      log.error(`[functions] ${fn.name} threw`, err);
      return send(res, 500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        JSON.stringify({ error: 'Internal error.', code: 'function-error' }), req.method);
    }
    if (!(response instanceof Response)) {
      log.error(`[functions] ${fn.name} returned no Response`);
      return send(res, 500, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Function returned no Response', req.method);
    }

    res.statusCode = response.status;
    for (const [k, v] of response.headers) {
      if (k === 'set-cookie') continue;
      if (HOP_BY_HOP.has(k) || k === 'content-length') continue;
      res.setHeader(k, v);
    }
    // Netlify adds this to every function response; so do we.
    if (!response.headers.has('x-content-type-options')) res.setHeader('X-Content-Type-Options', 'nosniff');
    const cookies = response.headers.getSetCookie?.() || [];
    if (cookies.length) res.setHeader('Set-Cookie', cookies);

    const bytes = req.method === 'HEAD' || [204, 304].includes(response.status)
      ? null
      : Buffer.from(await response.arrayBuffer());
    if (bytes) res.setHeader('Content-Length', bytes.length);
    res.end(bytes ?? undefined);
    return undefined;
  }

  function functionFor(pathname) {
    if (!pathname.startsWith(FUNCTIONS_PREFIX)) return null;
    const name = pathname.slice(FUNCTIONS_PREFIX.length).split('/')[0];
    return { name, fn: functions.get(name) || null };
  }

  /* ------------------------------------------------------- routing -- */

  async function applyRule(req, res, rule, params, url) {
    const target = fillTarget(rule.to, params);
    if (rule.status === 200) {
      if (/^https?:\/\//.test(target)) {
        log.error(`[routes] proxy rules are not supported: ${rule.from} -> ${rule.to}`);
        return send(res, 502, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Bad Gateway', req.method);
      }
      const t = new URL(target, url);
      const asFn = functionFor(t.pathname);
      if (asFn) {
        if (!asFn.fn) return notFound(req, res, url.pathname);
        return callFunction(req, res, asFn.fn, url);
      }
      const hit = await resolveStatic(root, t.pathname);
      if (hit?.file) return sendFile(req, res, hit.file, 200, url.pathname);
      return notFound(req, res, url.pathname);
    }
    if (rule.status >= 300 && rule.status < 400) {
      return redirect(req, res, rule.status, target, url.pathname, url.search);
    }
    // 404 (and any other status): that file, with that status.
    const hit = await resolveStatic(root, new URL(target, url).pathname);
    if (hit?.file) return sendFile(req, res, hit.file, rule.status, url.pathname);
    return notFound(req, res, url.pathname);
  }

  async function route(req, res) {
    const host = req.headers.host || 'localhost';
    const proto = trustProxy && req.headers['x-forwarded-proto']
      ? String(req.headers['x-forwarded-proto']).split(',')[0].trim()
      : 'http';
    let url;
    try {
      url = new URL(req.url, `${proto}://${host}`);
    } catch {
      return send(res, 400, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Bad Request', req.method);
    }
    const { pathname } = url;

    if (pathname === '/api/health/live') {
      return send(res, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        JSON.stringify({ ok: true }), req.method);
    }

    const direct = functionFor(pathname);
    if (direct) {
      if (!direct.fn) return notFound(req, res, pathname);
      return callFunction(req, res, direct.fn, url);
    }
    if (customPaths.has(pathname)) return callFunction(req, res, customPaths.get(pathname), url);

    // Forced rules come before files; the rest only when no file matches.
    for (const rule of routing.redirects.filter((r) => r.force)) {
      const params = matchPattern(rule.from, pathname);
      if (params) return applyRule(req, res, rule, params, url);
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const hit = await resolveStatic(root, pathname);
      if (hit?.file) return sendFile(req, res, hit.file, 200, pathname);
      if (hit?.redirect) return redirect(req, res, 301, hit.redirect, pathname, url.search);
    }

    for (const rule of routing.redirects.filter((r) => !r.force)) {
      const params = matchPattern(rule.from, pathname);
      if (params) return applyRule(req, res, rule, params, url);
    }
    return notFound(req, res, pathname);
  }

  async function handle(req, res) {
    try {
      await route(req, res);
    } catch (err) {
      log.error('[server] request failed', err);
      if (!res.headersSent) {
        send(res, 500, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Internal Server Error', req.method);
      } else {
        res.destroy(err);
      }
    }
  }

  /* ----------------------------------------------------- scheduling -- */

  const jobs = [];
  function startSchedules() {
    for (const fn of functions.values()) {
      if (!fn.schedule) continue;
      let running = false;
      const job = schedule(fn.schedule, async (at) => {
        if (running) {
          log.warn(`[cron] ${fn.name}: previous run still going, skipped ${at.toISOString()}`);
          return;
        }
        running = true;
        try {
          const req = new Request(`${siteUrl}${FUNCTIONS_PREFIX}${fn.name}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ next_run: at.toISOString() })
          });
          const response = await fn.call(req, makeContext({ ip: '127.0.0.1', siteUrl }));
          log.log(`[cron] ${fn.name} ran: ${response?.status}`);
        } finally {
          running = false;
        }
      }, { log });
      jobs.push(job);
      log.log(`[cron] ${fn.name} on "${fn.schedule}" (UTC), next at ${job.next.toISOString()}`);
    }
  }
  if (scheduler) startSchedules();

  return {
    handle,
    functions,
    routing,
    jobs,
    stop() {
      for (const j of jobs) j.stop();
    }
  };
}

/* ------------------------------------------------------------ main -- */

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const port = Number(process.env.PORT) || 8000;
  const host = process.env.HOST || '0.0.0.0';
  const app = await createApp();
  const server = http.createServer(app.handle);
  server.keepAliveTimeout = 65_000;     // longer than Caddy's idle pool
  server.headersTimeout = 66_000;
  server.requestTimeout = 60_000;
  server.listen(port, host, () => {
    console.log(`[server] ${app.functions.size} functions, listening on http://${host}:${port}`);
  });

  const shutdown = (signal) => {
    console.log(`[server] ${signal}, closing`);
    app.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
