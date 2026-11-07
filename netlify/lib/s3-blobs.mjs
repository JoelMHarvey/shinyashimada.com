/* ==========================================================================
   Netlify-Blobs-shaped stores in an S3-compatible bucket.

   For running off Netlify: a private bucket in Hetzner Object Storage (or
   anything else that speaks S3). No SDK — the five calls this site makes
   are a signed GET, PUT, HEAD, DELETE and a ListObjectsV2, and AWS
   Signature V4 is a page of node:crypto.

   Layout: one bucket, a store is a prefix. `vocab-images/<hash>.jpg`,
   `passcode-failures/<window>:<address>`, `vocab-usage/d:2026-11-07`.

   A blob's Netlify metadata (`{ contentType }` for the pictures) travels as
   base64 JSON in `x-amz-meta-blob-metadata`, and `contentType` is also set
   as the object's Content-Type.

   Environment:
     S3_ENDPOINT           https://nbg1.your-objectstorage.com
     S3_REGION             nbg1
     S3_BUCKET             the bucket's name
     S3_ACCESS_KEY_ID      \  an access key scoped to that bucket
     S3_SECRET_ACCESS_KEY  /
     S3_FORCE_PATH_STYLE   'true' for https://endpoint/bucket/key; otherwise
                           virtual-host style, https://bucket.endpoint/key
   ========================================================================== */

import { createHash, createHmac } from 'node:crypto';

const META_HEADER = 'x-amz-meta-blob-metadata';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding as SigV4 wants it: everything but A-Z a-z 0-9 - _ . ~ */
export function uriEncode(str, keepSlash = false) {
  let out = '';
  for (const byte of Buffer.from(String(str), 'utf8')) {
    const c = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~]/.test(c) || (keepSlash && c === '/')) out += c;
    else out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

/** The headers that sign one request (AWS Signature Version 4). */
export function signRequest({
  method, url, headers = {}, body = '', region, accessKeyId, secretAccessKey,
  service = 's3', now = new Date()
}) {
  const u = new URL(url);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const payloadHash = sha256(body);

  const all = {
    ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])),
    host: u.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate
  };
  const names = Object.keys(all).sort();
  const canonicalHeaders = names.map((n) => `${n}:${all[n]}\n`).join('');
  const signedHeaders = names.join(';');

  const query = [...u.searchParams.entries()]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)])
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  // The path is already encoded once (see objectUrl); S3 signs it as sent.
  const canonical = [method, u.pathname || '/', query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');

  let key = hmac('AWS4' + secretAccessKey, date);
  key = hmac(key, region);
  key = hmac(key, service);
  key = hmac(key, 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');

  return {
    ...all,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  };
}

function settingsFrom(env) {
  const need = ['S3_ENDPOINT', 'S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'];
  const missing = need.filter((n) => !env[n]);
  if (missing.length) throw new Error(`S3 blob store: missing ${missing.join(', ')}`);
  return {
    endpoint: env.S3_ENDPOINT.replace(/\/+$/, ''),
    region: env.S3_REGION,
    bucket: env.S3_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    pathStyle: /^(1|true|yes)$/i.test(env.S3_FORCE_PATH_STYLE || '')
  };
}

async function toBytes(data) {
  if (data == null) return Buffer.alloc(0);
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data.arrayBuffer === 'function') return Buffer.from(await data.arrayBuffer());
  throw new TypeError('Unsupported blob input');
}

function decodeMetadata(headers) {
  const raw = headers.get(META_HEADER);
  if (!raw) {
    const type = headers.get('content-type');
    return type && type !== 'application/octet-stream' ? { contentType: type } : {};
  }
  try {
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    return {};
  }
}

function shape(bytes, type = 'text', contentType) {
  switch (type) {
    case 'arrayBuffer':
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    case 'json':
      return JSON.parse(bytes.toString('utf8'));
    case 'blob':
      return new Blob([bytes], contentType ? { type: contentType } : {});
    case 'stream':
      return new Blob([bytes]).stream();
    default:
      return bytes.toString('utf8');
  }
}

const unescapeXml = (s) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/**
 * A client for one bucket. `store(name)` gives the Netlify-shaped store.
 * `fetch` and `env` are injectable for tests.
 */
export function createS3Blobs({ env = process.env, fetch: doFetch = globalThis.fetch } = {}) {
  const cfg = settingsFrom(env);

  function objectUrl(key = '', query = '') {
    const path = key ? '/' + uriEncode(key, true) : '/';
    const qs = query ? `?${query}` : '';
    if (cfg.pathStyle) return `${cfg.endpoint}/${uriEncode(cfg.bucket)}${key ? path : '/'}${qs}`;
    const u = new URL(cfg.endpoint);
    return `${u.protocol}//${cfg.bucket}.${u.host}${path}${qs}`;
  }

  async function send(method, key, { body = Buffer.alloc(0), headers = {}, query = '' } = {}) {
    const url = objectUrl(key, query);
    const signed = signRequest({ method, url, headers, body, ...cfg });
    delete signed.host;                    // fetch sets it, from the URL
    const res = await doFetch(url, {
      method,
      headers: signed,
      body: method === 'PUT' ? body : undefined
    });
    return res;
  }

  async function fail(res, what) {
    const text = await res.text().catch(() => '');
    const code = (text.match(/<Code>([^<]+)<\/Code>/) || [])[1] || res.status;
    const err = new Error(`S3 ${what} failed: ${code}`);
    err.status = res.status;
    throw err;
  }

  function store(name) {
    if (!name || /[/]/.test(name)) throw new Error(`bad store name: ${name}`);
    const full = (key) => {
      if (!key || typeof key !== 'string') throw new Error('A blob key is required.');
      return `${name}/${key}`;
    };

    async function fetchObject(key) {
      const res = await send('GET', full(key));
      if (res.status === 404) {
        await res.arrayBuffer().catch(() => {});
        return null;
      }
      if (!res.ok) await fail(res, `get ${name}/${key}`);
      return { bytes: Buffer.from(await res.arrayBuffer()), headers: res.headers };
    }

    return {
      name,

      async get(key, { type } = {}) {
        const hit = await fetchObject(key);
        return hit ? shape(hit.bytes, type, hit.headers.get('content-type')) : null;
      },

      async getWithMetadata(key, { type } = {}) {
        const hit = await fetchObject(key);
        if (!hit) return null;
        const metadata = decodeMetadata(hit.headers);
        return {
          data: shape(hit.bytes, type, metadata.contentType),
          etag: hit.headers.get('etag') || undefined,
          metadata
        };
      },

      async getMetadata(key) {
        const res = await send('HEAD', full(key));
        if (res.status === 404) return null;
        if (!res.ok) await fail(res, `head ${name}/${key}`);
        return { etag: res.headers.get('etag') || undefined, metadata: decodeMetadata(res.headers) };
      },

      async set(key, data, { metadata } = {}) {
        const body = await toBytes(data);
        const headers = {
          'content-type': (metadata && metadata.contentType) || 'application/octet-stream'
        };
        if (metadata && Object.keys(metadata).length) {
          headers[META_HEADER] = Buffer.from(JSON.stringify(metadata), 'utf8').toString('base64');
        }
        const res = await send('PUT', full(key), { body, headers });
        if (!res.ok) await fail(res, `put ${name}/${key}`);
        await res.arrayBuffer().catch(() => {});
        return { modified: true, etag: res.headers.get('etag') || undefined };
      },

      async setJSON(key, value, options) {
        return this.set(key, JSON.stringify(value), options);
      },

      async delete(key) {
        const res = await send('DELETE', full(key));
        if (!res.ok && res.status !== 404) await fail(res, `delete ${name}/${key}`);
        await res.arrayBuffer().catch(() => {});
      },

      /** Every key in the store (or under `prefix`). Not paginated: the
          stores here are a few thousand keys at most. */
      async list({ prefix = '' } = {}) {
        const blobs = [];
        let token = null;
        do {
          const params = new URLSearchParams({ 'list-type': '2', prefix: `${name}/${prefix}` });
          if (token) params.set('continuation-token', token);
          const query = [...params.entries()].map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`).join('&');
          const res = await send('GET', '', { query });
          if (!res.ok) await fail(res, `list ${name}`);
          const xml = await res.text();
          for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
            const key = unescapeXml((m[1].match(/<Key>([\s\S]*?)<\/Key>/) || [])[1] || '');
            const etag = unescapeXml((m[1].match(/<ETag>([\s\S]*?)<\/ETag>/) || [])[1] || '');
            if (key.startsWith(`${name}/`)) blobs.push({ key: key.slice(name.length + 1), etag });
          }
          token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
            ? unescapeXml((xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/) || [])[1] || '')
            : null;
        } while (token);
        return { blobs, directories: [] };
      }
    };
  }

  return { store, objectUrl };
}
