/* ==========================================================================
   Static files, served the way Netlify serves this site's publish dir (".").

   Checked against the live site on 7 November 2026:
     /plants              301 -> /plants/
     /plants/             plants/index.html
     /plants/index        301 -> /plants/
     /plants/index.html   200, no redirect
     /404                 404.html with a 200 (an extensionless .html match)
     /homelab/            404: a directory with no index.html
     /.gitignore, /node_modules/..., /netlify.toml   404
     Cache-Control: public, max-age=0, must-revalidate, with an ETag, so a
     browser keeps a copy but asks every time and gets a cheap 304.
   ========================================================================== */

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export const TYPES = {
  '.html': 'text/html; charset=UTF-8',
  '.htm': 'text/html; charset=UTF-8',
  '.js': 'application/javascript; charset=UTF-8',
  '.mjs': 'application/javascript; charset=UTF-8',
  '.cjs': 'application/javascript; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=UTF-8',
  '.md': 'text/markdown; charset=UTF-8',
  '.csv': 'text/csv; charset=UTF-8',
  '.xml': 'application/xml',
  '.rdf': 'application/rdf+xml',
  '.sql': 'application/sql',
  '.yml': 'text/yaml; charset=UTF-8',
  '.yaml': 'text/yaml; charset=UTF-8',
  '.toml': 'application/toml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  '.zip': 'application/zip'
};

export const STATIC_CACHE_CONTROL = 'public, max-age=0, must-revalidate';

export function contentTypeFor(file) {
  return TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/** Never served, whatever is on disk: what Netlify does not publish, plus
    the server's own working directories. */
function hidden(segments) {
  if (segments.some((s) => s.startsWith('.') && s !== '.well-known')) return true;
  const first = segments[0];
  if (first === 'node_modules') return true;
  if (segments.length === 1 && ['netlify.toml', '_redirects', '_headers'].includes(first)) return true;
  return false;
}

async function statOrNull(p) {
  try {
    return await stat(p);
  } catch {
    return null;
  }
}

/** The path's segments, decoded, or null for anything unsafe. */
function segmentsOf(pathname) {
  const out = [];
  for (const raw of pathname.split('/')) {
    if (raw === '') continue;
    let s;
    try {
      s = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (s === '.' || s === '..' || s.includes('/') || s.includes('\\') || s.includes('\0')) return null;
    out.push(s);
  }
  return out;
}

/**
 * What a GET for `pathname` resolves to:
 *   { file }                 a file to serve
 *   { redirect: '/x/' }      a 301 to add the trailing slash
 *   null                     nothing here (redirect rules, then the 404 page)
 */
export async function resolveStatic(root, pathname) {
  const segments = segmentsOf(pathname);
  if (!segments || hidden(segments)) return null;

  const base = path.resolve(root);
  const fsPath = path.join(base, ...segments);
  if (fsPath !== base && !fsPath.startsWith(base + path.sep)) return null;

  const st = await statOrNull(fsPath);
  if (st?.isFile()) return { file: fsPath };

  if (st?.isDirectory()) {
    const index = path.join(fsPath, 'index.html');
    if (!(await statOrNull(index))?.isFile()) return null;
    if (pathname.endsWith('/')) return { file: index };
    return { redirect: pathname + '/' };
  }

  // /plants/index -> /plants/
  if (segments.length && segments[segments.length - 1] === 'index') {
    const dir = path.dirname(fsPath);
    if ((await statOrNull(path.join(dir, 'index.html')))?.isFile()) {
      return { redirect: pathname.slice(0, -'index'.length) };
    }
  }

  // /404 -> 404.html
  if (segments.length && !path.extname(fsPath)) {
    const html = fsPath + '.html';
    if ((await statOrNull(html))?.isFile()) return { file: html };
  }
  return null;
}

/* The ETag is a hash of the bytes, remembered against size and mtime so a
   file is hashed once per change rather than once per request. */
const etags = new Map();

export async function readWithEtag(file) {
  const st = await stat(file);
  const bytes = await readFile(file);
  const stamp = `${st.size}:${st.mtimeMs}`;
  const known = etags.get(file);
  if (known && known.stamp === stamp) return { bytes, etag: known.etag };
  const etag = `"${createHash('sha1').update(bytes).digest('hex')}"`;
  etags.set(file, { stamp, etag });
  return { bytes, etag };
}

/** True when the request's If-None-Match already holds this ETag. */
export function notModified(ifNoneMatch, etag) {
  if (!ifNoneMatch) return false;
  if (ifNoneMatch.trim() === '*') return true;
  return ifNoneMatch.split(',').map((t) => t.trim().replace(/^W\//, '')).includes(etag);
}
