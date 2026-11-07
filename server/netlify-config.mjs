/* ==========================================================================
   Reads the routing half of netlify.toml — [[redirects]] and [[headers]] —
   so the server follows the same file Netlify does, rather than a copy of
   it that drifts.

   A TOML subset, on purpose: tables, arrays of tables, and `key = value`
   with strings, numbers and booleans, plus `key = { ... }` inline tables of
   the same. That is everything netlify.toml uses here. Anything else is
   skipped, and the tests read the real file so a new shape shows up there.

   _redirects and _headers files are read too, in Netlify's plain-text
   format, and win over netlify.toml as they do on Netlify (their rules come
   first). The site has neither today.
   ========================================================================== */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

function parseValue(raw) {
  const v = raw.trim();
  if (v.startsWith('"') || v.startsWith("'")) {
    const q = v[0];
    const end = v.indexOf(q, 1);
    const body = v.slice(1, end < 0 ? undefined : end);
    return q === '"' ? body.replace(/\\"/g, '"').replace(/\\\\/g, '\\') : body;
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^[+-]?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v.startsWith('{') && v.endsWith('}')) {
    const out = {};
    for (const part of v.slice(1, -1).split(',')) {
      const i = part.indexOf('=');
      if (i > 0) out[unquoteKey(part.slice(0, i))] = parseValue(part.slice(i + 1));
    }
    return out;
  }
  if (v.startsWith('[') && v.endsWith(']')) {
    return v.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean).map(parseValue);
  }
  return v;
}

const unquoteKey = (k) => k.trim().replace(/^["']|["']$/g, '');

/** Strip a trailing comment that is not inside a string. */
function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === q && line[i - 1] !== '\\') q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '#') return line.slice(0, i);
  }
  return line;
}

/** The TOML subset described above, as a plain object. */
export function parseToml(text) {
  const root = {};
  let current = root;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;

    let m;
    if ((m = line.match(/^\[\[\s*([^\]]+?)\s*\]\]$/))) {
      const keys = m[1].split('.').map(unquoteKey);
      let parent = root;
      for (const k of keys.slice(0, -1)) {
        parent[k] ??= {};
        parent = Array.isArray(parent[k]) ? parent[k][parent[k].length - 1] : parent[k];
      }
      const last = keys[keys.length - 1];
      parent[last] ??= [];
      const table = {};
      parent[last].push(table);
      current = table;
      continue;
    }
    if ((m = line.match(/^\[\s*([^\]]+?)\s*\]$/))) {
      // A sub-table of the most recent array entry ([headers.values] under
      // [[headers]]), or a plain table from the root.
      const keys = m[1].match(/("[^"]*"|'[^']*'|[^.]+)/g).map(unquoteKey);
      let parent = root;
      for (const k of keys.slice(0, -1)) {
        parent[k] ??= {};
        parent = Array.isArray(parent[k]) ? parent[k][parent[k].length - 1] : parent[k];
      }
      const last = keys[keys.length - 1];
      parent[last] ??= {};
      current = parent[last];
      continue;
    }
    const eq = line.indexOf('=');
    if (eq > 0) current[unquoteKey(line.slice(0, eq))] = parseValue(line.slice(eq + 1));
  }
  return root;
}

/** Netlify's _redirects: `from to [status][!]` per line. */
export function parseRedirectsFile(text) {
  const rules = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const [from, to, code] = line.split(/\s+/);
    if (!from || !to) continue;
    const force = /!$/.test(code || '');
    rules.push({ from, to, status: Number(String(code || '301').replace('!', '')) || 301, force });
  }
  return rules;
}

/** Netlify's _headers: a path line, then indented `Name: value` lines. */
export function parseHeadersFile(text) {
  const rules = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      current = { for: raw.trim(), values: {} };
      rules.push(current);
    } else if (current) {
      const i = raw.indexOf(':');
      if (i > 0) current.values[raw.slice(0, i).trim()] = raw.slice(i + 1).trim();
    }
  }
  return rules;
}

/** { redirects, headers } for the site rooted at `root`. */
export function loadRoutingConfig(root) {
  let redirects = [];
  let headers = [];

  const toml = path.join(root, 'netlify.toml');
  if (existsSync(toml)) {
    const cfg = parseToml(readFileSync(toml, 'utf8'));
    redirects = (cfg.redirects || []).map((r) => ({
      from: r.from,
      to: r.to,
      status: Number(r.status) || 301,
      force: !!r.force
    }));
    headers = (cfg.headers || []).map((h) => ({ for: h.for, values: { ...(h.values || {}) } }));
  }

  const redirectsFile = path.join(root, '_redirects');
  if (existsSync(redirectsFile)) {
    redirects = [...parseRedirectsFile(readFileSync(redirectsFile, 'utf8')), ...redirects];
  }
  const headersFile = path.join(root, '_headers');
  if (existsSync(headersFile)) {
    headers = [...parseHeadersFile(readFileSync(headersFile, 'utf8')), ...headers];
  }

  return { redirects, headers };
}

/* ----------------------------------------------------------- matching -- */

/**
 * Match a Netlify `from` pattern against a path. `*` is the splat (it also
 * matches the bare prefix: `/italian/*` takes `/italian`), `:name` a single
 * segment. Returns the captured values, or null.
 */
export function matchPattern(pattern, pathname) {
  const names = [];
  let re = '';
  const parts = pattern.split('/');
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (i === 0) continue;
    if (part === '*' && i === parts.length - 1) {
      re += '(?:/(.*))?';
      names.push('splat');
    } else if (part.startsWith(':')) {
      re += '/([^/]+)';
      names.push(part.slice(1));
    } else {
      re += '/' + part.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    }
  }
  const m = new RegExp(`^${re}/?$`).exec(pathname);
  if (!m) return null;
  const out = {};
  names.forEach((n, i) => { out[n] = m[i + 1] ?? ''; });
  return out;
}

/** `to` with :splat and :placeholders filled in. */
export function fillTarget(to, params) {
  return to.replace(/:([a-zA-Z_]+)/g, (whole, name) => (name in params ? params[name] : whole));
}

/** The custom headers for a path, merged in file order. */
export function headersFor(rules, pathname) {
  const out = {};
  for (const rule of rules) {
    const glob = '^' + rule.for.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
    if (new RegExp(glob).test(pathname)) Object.assign(out, rule.values);
  }
  return out;
}
