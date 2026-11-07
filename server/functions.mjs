/* ==========================================================================
   Loading netlify/functions/* and calling them the way Netlify does.

   Every function here is the modern shape — `export default async (req,
   context) => Response` — so a call is a standard Request in and a Response
   out. A v1 `export const handler = async (event, context)` would be
   adapted (eventFromRequest / responseFromResult); none exists today, but a
   file in the old shape should work rather than 500.

   What the functions use from `context` is `ip` (the passcode brake,
   netlify/lib/passcode.mjs) and nothing else. The rest of Netlify's context
   is filled with honest stand-ins: `geo` is empty, because nothing here
   looks a visitor up, and `deploy.context` is "production".
   ========================================================================== */

import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Netlify's own global, for any code that reads Netlify.env. Harmless when
    nothing does, which is the case today. */
export function installNetlifyGlobal(env = process.env) {
  if (globalThis.Netlify) return;
  globalThis.Netlify = {
    env: {
      get: (k) => env[k],
      has: (k) => k in env,
      set: (k, v) => { env[k] = String(v); },
      delete: (k) => { delete env[k]; },
      toObject: () => ({ ...env })
    },
    context: null
  };
}

/** Load every function in `dir`: { name -> { name, kind, call, schedule, paths } }. */
export async function loadFunctions(dir) {
  const out = new Map();
  let files = [];
  try {
    files = await readdir(dir);
  } catch {
    return out;
  }
  for (const file of files.sort()) {
    if (!/\.(mjs|js|cjs)$/.test(file)) continue;
    const name = file.replace(/\.(mjs|js|cjs)$/, '');
    if (name.endsWith('-background')) {
      // None today. Netlify answers 202 at once and runs these for up to 15
      // minutes; served synchronously they would only be slower, not wrong,
      // but say so rather than pretend.
      console.warn(`[functions] ${name}: background functions run synchronously here`);
    }
    const mod = await import(pathToFileURL(path.join(dir, file)).href);
    const config = mod.config || {};

    let kind;
    let call;
    if (typeof mod.default === 'function') {
      kind = 'v2';
      call = (req, context) => mod.default(req, context);
    } else if (typeof mod.handler === 'function') {
      kind = 'v1';
      call = async (req, context) => responseFromResult(await mod.handler(await eventFromRequest(req, context), context));
    } else {
      throw new Error(`netlify/functions/${file} exports neither a default function nor a handler`);
    }

    const paths = config.path ? [].concat(config.path) : [];
    out.set(name, { name, kind, call, schedule: config.schedule || null, paths });
  }
  return out;
}

/** The context object a function is called with. */
export function makeContext({ ip, requestId = randomUUID(), siteUrl = '', params = {} } = {}) {
  const pending = [];
  return {
    ip,
    geo: {},
    requestId,
    params,
    account: { id: '' },
    deploy: { context: 'production', id: 'self-hosted', published: true },
    server: { region: 'self-hosted' },
    site: { id: '', name: 'shinyashimada-com', url: siteUrl },
    waitUntil(promise) {
      pending.push(Promise.resolve(promise).catch((err) => console.error('[functions] waitUntil', err)));
    },
    _pending: pending
  };
}

/* ------------------------------------------------------- v1 adapters -- */

export async function eventFromRequest(req) {
  const url = new URL(req.url);
  const headers = Object.fromEntries(req.headers.entries());
  const multiValueHeaders = {};
  for (const [k, v] of req.headers.entries()) multiValueHeaders[k] = [v];
  const query = {};
  const multiQuery = {};
  for (const [k, v] of url.searchParams.entries()) {
    query[k] = v;
    (multiQuery[k] ||= []).push(v);
  }
  let body = null;
  let isBase64Encoded = false;
  if (!['GET', 'HEAD'].includes(req.method)) {
    const bytes = Buffer.from(await req.arrayBuffer());
    const type = req.headers.get('content-type') || '';
    if (/^(text\/|application\/(json|x-www-form-urlencoded|xml|javascript))/.test(type) || !bytes.length) {
      body = bytes.toString('utf8');
    } else {
      body = bytes.toString('base64');
      isBase64Encoded = true;
    }
  }
  return {
    rawUrl: req.url,
    rawQuery: url.search.slice(1),
    path: url.pathname,
    httpMethod: req.method,
    headers,
    multiValueHeaders,
    queryStringParameters: query,
    multiValueQueryStringParameters: multiQuery,
    body,
    isBase64Encoded
  };
}

export function responseFromResult(result = {}) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(result.headers || {})) headers.set(k, String(v));
  for (const [k, list] of Object.entries(result.multiValueHeaders || {})) {
    for (const v of [].concat(list)) headers.append(k, String(v));
  }
  const body = result.body == null
    ? null
    : result.isBase64Encoded ? Buffer.from(result.body, 'base64') : String(result.body);
  return new Response(body, { status: result.statusCode || 200, headers });
}
