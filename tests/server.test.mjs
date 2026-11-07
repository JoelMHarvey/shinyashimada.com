/* The self-hosted server (server/): static serving as Netlify does it, the
 * /api routing to functions, the health route, the S3 blob adapter against a
 * fake bucket, and the scheduler's arithmetic.
 *
 *   node --test tests/server.test.mjs
 *
 * No network and no database: the functions under test are fakes in a temp
 * directory, except where the real ones answer without either. */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createApp, clientIp } from '../server/server.mjs';
import { nextRun, parseCron, schedule } from '../server/cron.mjs';
import { loadRoutingConfig, matchPattern, parseToml } from '../server/netlify-config.mjs';
import { createS3Blobs, signRequest } from '../netlify/lib/s3-blobs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const quiet = { log() {}, warn() {}, error() {} };

/** Start a handler on a free port; returns { base, close }. */
async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(r))
  };
}

const get = (base, p, init = {}) => fetch(base + p, { redirect: 'manual', ...init });

/* ------------------------------------------------------------ static -- */

describe('static files, as Netlify serves them', () => {
  let srv;
  before(async () => {
    const app = await createApp({ root: ROOT, scheduler: false, log: quiet, env: { ...process.env } });
    srv = await listen(app.handle);
  });
  after(() => srv.close());

  test('/ is index.html, with netlify.toml headers and a revalidating cache', async () => {
    const res = await get(srv.base, '/');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/html; charset=UTF-8');
    assert.equal(res.headers.get('cache-control'), 'public, max-age=0, must-revalidate');
    assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal(res.headers.get('permissions-policy'), 'geolocation=(), camera=(), microphone=()');
    assert.match(res.headers.get('etag'), /^"[0-9a-f]{40}"$/);
    assert.match(await res.text(), /<html/i);
  });

  test('an unchanged file answers 304 to its ETag', async () => {
    const first = await get(srv.base, '/assets/js/care.js');
    assert.equal(first.headers.get('content-type'), 'application/javascript; charset=UTF-8');
    const again = await get(srv.base, '/assets/js/care.js', { headers: { 'If-None-Match': first.headers.get('etag') } });
    assert.equal(again.status, 304);
  });

  test('a directory gets its trailing slash, then its index', async () => {
    const res = await get(srv.base, '/plants?x=1');
    assert.equal(res.status, 301);
    assert.equal(res.headers.get('location'), '/plants/?x=1');
    assert.equal((await get(srv.base, '/plants/')).status, 200);
    const idx = await get(srv.base, '/plants/index');
    assert.equal(idx.status, 301);
    assert.equal(idx.headers.get('location'), '/plants/');
    assert.equal((await get(srv.base, '/plants/index.html')).status, 200);
  });

  test('a miss is 404.html with a 404, and /404 is that page with a 200', async () => {
    const miss = await get(srv.base, '/no-such-page');
    assert.equal(miss.status, 404);
    assert.match(miss.headers.get('content-type'), /text\/html/);
    assert.match(await miss.text(), /<html/i);
    assert.equal((await get(srv.base, '/404')).status, 200);
  });

  test('what Netlify does not publish stays unpublished', async () => {
    for (const p of ['/.gitignore', '/netlify.toml', '/node_modules/pg/package.json', '/homelab/', '/.git/HEAD']) {
      assert.equal((await get(srv.base, p)).status, 404, p);
    }
  });

  test('no way out of the root', async () => {
    // The URL parser folds /%2e%2e/ into /../ and resolves it inside the
    // root; what is left to refuse is an encoded separator or a NUL.
    for (const p of ['/..%2fpackage.json', '/assets/..%2f..%2fpackage.json', '/assets/..%5c..%5cpackage.json', '/%2e%2e/%2e%2e/etc/passwd', '/%00']) {
      assert.equal((await get(srv.base, p)).status, 404, p);
    }
  });

  test('netlify.toml redirects: /italian/* to /forza/, keeping the query', async () => {
    const res = await get(srv.base, '/italian/old/page?a=1');
    assert.equal(res.status, 301);
    assert.equal(res.headers.get('location'), '/forza/?a=1');
  });

  test('HEAD answers headers only', async () => {
    const res = await get(srv.base, '/', { method: 'HEAD' });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '');
  });
});

/* --------------------------------------------------------- functions -- */

describe('functions behind /api and /.netlify/functions', () => {
  let srv, dir, app;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'fns-'));
    await writeFile(path.join(dir, 'echo.mjs'), `
      export default async (req, context) => Response.json({
        url: req.url, method: req.method, ip: context.ip,
        nfIp: req.headers.get('x-nf-client-connection-ip'),
        body: req.method === 'POST' ? await req.text() : null,
        geo: context.geo
      }, { headers: { 'Cache-Control': 'no-store', 'X-Fn': 'echo' } });`);
    await writeFile(path.join(dir, 'oldstyle.mjs'), `
      export const handler = async (event) => ({
        statusCode: 201,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: event.httpMethod, q: event.queryStringParameters, body: event.body })
      });`);
    await writeFile(path.join(dir, 'nightly.mjs'), `
      export const config = { schedule: '0 21 * * *' };
      export default async () => new Response('ran');`);
    await writeFile(path.join(dir, 'boom.mjs'), `export default async () => { throw new Error('kaboom'); };`);
    app = await createApp({ root: ROOT, functionsDir: dir, scheduler: false, log: quiet, env: { ...process.env } });
    srv = await listen(app.handle);
  });
  after(async () => {
    await srv.close();
    await rm(dir, { recursive: true, force: true });
  });

  test('/api/<name> reaches the function through netlify.toml’s rule, URL intact', async () => {
    const res = await get(srv.base, '/api/echo?x=1');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-fn'), 'echo');
    assert.equal(res.headers.get('x-frame-options'), null, 'netlify.toml headers are for files, not functions');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    const body = await res.json();
    assert.equal(new URL(body.url).pathname, '/api/echo');
    assert.equal(new URL(body.url).search, '?x=1');
    assert.deepEqual(body.geo, {});
  });

  test('sub-paths and the direct /.netlify/functions path reach it too', async () => {
    assert.equal((await get(srv.base, '/api/echo/a/b')).status, 200);
    assert.equal((await get(srv.base, '/.netlify/functions/echo')).status, 200);
    assert.equal((await get(srv.base, '/.netlify/functions/echo/more')).status, 200);
  });

  test('POST bodies arrive', async () => {
    const res = await get(srv.base, '/api/echo', { method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json' } });
    assert.equal((await res.json()).body, '{"a":1}');
  });

  test('context.ip is Caddy’s address for the visitor, not one the client chose', async () => {
    const res = await get(srv.base, '/api/echo', {
      headers: { 'X-Forwarded-For': '6.6.6.6, 203.0.113.5', 'X-Nf-Client-Connection-Ip': '6.6.6.6' }
    });
    const body = await res.json();
    assert.equal(body.ip, '203.0.113.5');
    assert.equal(body.nfIp, '203.0.113.5');
  });

  test('without a proxy header, the socket address', () => {
    assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '::ffff:10.0.0.2' } }), '10.0.0.2');
    assert.equal(clientIp({ headers: { 'x-forwarded-for': '1.2.3.4' }, socket: { remoteAddress: '10.0.0.2' } }, { trustProxy: false }), '10.0.0.2');
  });

  test('a v1 handler(event) is adapted', async () => {
    const res = await get(srv.base, '/api/oldstyle?q=tea', { method: 'POST', body: 'hi', headers: { 'content-type': 'text/plain' } });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { method: 'POST', q: { q: 'tea' }, body: 'hi' });
  });

  test('a scheduled function has no public URL, as on Netlify', async () => {
    assert.equal((await get(srv.base, '/api/nightly')).status, 403);
    assert.equal(app.functions.get('nightly').schedule, '0 21 * * *');
  });

  test('a function that throws is a 500 in JSON, an unknown one the 404 page', async () => {
    const boom = await get(srv.base, '/api/boom');
    assert.equal(boom.status, 500);
    assert.equal((await boom.json()).code, 'function-error');
    const none = await get(srv.base, '/api/nothing-here');
    assert.equal(none.status, 404);
    assert.match(none.headers.get('content-type'), /text\/html/);
  });

  test('GET /api/health/live is 200 with no database', async () => {
    const res = await get(srv.base, '/api/health/live');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});

describe('the real functions', () => {
  test('all ten load, and the Trello sync is the one on a schedule', async () => {
    const app = await createApp({ root: ROOT, scheduler: false, log: quiet, env: { ...process.env } });
    assert.equal(app.functions.size, 10);
    const scheduled = [...app.functions.values()].filter((f) => f.schedule).map((f) => [f.name, f.schedule]);
    assert.deepEqual(scheduled, [['balcony-trello-sync', '0 21 * * *']]);
    assert.ok([...app.functions.values()].every((f) => f.kind === 'v2'));
  });

  test('/api/camera answers through the server (503 with no passcode set)', async () => {
    const saved = process.env.SITE_PASSCODE;
    delete process.env.SITE_PASSCODE;
    const app = await createApp({ root: ROOT, scheduler: false, log: quiet, env: { ...process.env } });
    const srv = await listen(app.handle);
    try {
      const res = await get(srv.base, '/api/camera');
      assert.equal(res.status, 503);
      assert.equal((await res.json()).code, 'passcode-required');
    } finally {
      await srv.close();
      if (saved !== undefined) process.env.SITE_PASSCODE = saved;
    }
  });
});

/* -------------------------------------------------------- netlify.toml -- */

describe('reading netlify.toml', () => {
  test('the real file: three redirects in order, one header block', () => {
    const { redirects, headers } = loadRoutingConfig(ROOT);
    assert.deepEqual(redirects.map((r) => [r.from, r.to, r.status]), [
      ['/api/*', '/.netlify/functions/:splat', 200],
      ['/italian/*', '/forza/', 301],
      ['/*', '/404.html', 404]
    ]);
    assert.equal(headers.length, 1);
    assert.equal(headers[0].for, '/*');
    assert.equal(headers[0].values['X-Content-Type-Options'], 'nosniff');
  });

  test('the subset parser', () => {
    const t = parseToml(`
      [build]
        publish = "." # a comment
      [functions."store"]
        included_files = []
      [[redirects]]
        from = "/a/*"
        status = 200
        force = true
    `);
    assert.equal(t.build.publish, '.');
    assert.deepEqual(t.functions.store.included_files, []);
    assert.deepEqual(t.redirects, [{ from: '/a/*', status: 200, force: true }]);
  });

  test('pattern matching', () => {
    assert.deepEqual(matchPattern('/api/*', '/api/weather'), { splat: 'weather' });
    assert.deepEqual(matchPattern('/api/*', '/api/store/x'), { splat: 'store/x' });
    assert.deepEqual(matchPattern('/italian/*', '/italian'), { splat: '' });
    assert.equal(matchPattern('/api/*', '/apiary'), null);
    assert.deepEqual(matchPattern('/b/:id', '/b/42'), { id: '42' });
  });
});

/* ----------------------------------------------------------- the cron -- */

describe('the scheduler', () => {
  const at = (s) => new Date(s);

  test('the Trello sync: 21:00 UTC, which is 06:00 in Tokyo', () => {
    assert.equal(nextRun('0 21 * * *', at('2026-11-07T12:00:00Z')).toISOString(), '2026-11-07T21:00:00.000Z');
    assert.equal(nextRun('0 21 * * *', at('2026-11-07T21:00:00Z')).toISOString(), '2026-11-08T21:00:00.000Z');
    assert.equal(nextRun('0 21 * * *', at('2026-12-31T21:30:00Z')).toISOString(), '2027-01-01T21:00:00.000Z');
  });

  test('steps, lists, ranges and the day-of-week rule', () => {
    assert.equal(nextRun('*/15 * * * *', at('2026-11-07T12:07:30Z')).toISOString(), '2026-11-07T12:15:00.000Z');
    assert.equal(nextRun('0 9 * * 1-5', at('2026-11-07T12:00:00Z')).toISOString(), '2026-11-09T09:00:00.000Z'); // Sat -> Mon
    assert.equal(nextRun('0 0 * * 7', at('2026-11-07T12:00:00Z')).toISOString(), '2026-11-08T00:00:00.000Z');  // 7 is Sunday
    // Both day fields restricted: either may match (the 1st, or a Friday).
    assert.equal(nextRun('0 0 1 * 5', at('2026-11-07T12:00:00Z')).toISOString(), '2026-11-13T00:00:00.000Z');
    assert.equal(nextRun('5,35 * * * *', at('2026-11-07T12:06:00Z')).toISOString(), '2026-11-07T12:35:00.000Z');
    assert.equal(nextRun('@daily', at('2026-11-07T12:00:00Z')).toISOString(), '2026-11-08T00:00:00.000Z');
    assert.equal(nextRun('0 0 29 2 *', at('2026-03-01T00:00:00Z')).toISOString(), '2028-02-29T00:00:00.000Z');
  });

  test('a bad expression is refused, not silently never run', () => {
    assert.throws(() => parseCron('0 21 * *'));
    assert.throws(() => parseCron('61 * * * *'));
    assert.throws(() => parseCron('0 21 * * MON'));
    assert.throws(() => nextRun('0 0 31 2 *'));
  });

  test('schedule() fires the job at the minute and re-arms', async () => {
    // A clock 30 ms short of the minute.
    let offset = 60_000 - (Date.now() % 60_000) - 30;
    const now = () => new Date(Date.now() + offset);
    const fired = [];
    const job = schedule('* * * * *', async (when) => { fired.push(when); offset += 0; }, { now, log: quiet });
    await new Promise((r) => setTimeout(r, 200));
    job.stop();
    assert.equal(fired.length, 1);
    assert.equal(fired[0].getUTCSeconds(), 0);
    assert.ok(job.next > fired[0], 're-armed for the following minute');
  });
});

/* ------------------------------------------------------- the S3 store -- */

/** An in-memory S3 that checks every request is signed for this bucket. */
function fakeS3({ bucket, accessKeyId }) {
  const objects = new Map();
  const seen = [];
  const handler = (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      seen.push({ method: req.method, path: url.pathname, auth: req.headers.authorization });
      if (!String(req.headers.authorization || '').startsWith(`AWS4-HMAC-SHA256 Credential=${accessKeyId}/`)) {
        res.statusCode = 403;
        return res.end('<Error><Code>AccessDenied</Code></Error>');
      }
      const [, b, ...rest] = url.pathname.split('/');
      if (b !== bucket) {
        res.statusCode = 404;
        return res.end('<Error><Code>NoSuchBucket</Code></Error>');
      }
      const key = decodeURIComponent(rest.join('/'));
      if (req.method === 'GET' && !key && url.searchParams.get('list-type') === '2') {
        const prefix = url.searchParams.get('prefix') || '';
        const items = [...objects.keys()].filter((k) => k.startsWith(prefix))
          .map((k) => `<Contents><Key>${k}</Key><ETag>"e"</ETag></Contents>`).join('');
        return res.end(`<ListBucketResult><IsTruncated>false</IsTruncated>${items}</ListBucketResult>`);
      }
      const obj = objects.get(key);
      if (req.method === 'PUT') {
        objects.set(key, { body: Buffer.concat(chunks), type: req.headers['content-type'], meta: req.headers['x-amz-meta-blob-metadata'] });
        res.setHeader('ETag', '"e"');
        return res.end();
      }
      if (req.method === 'DELETE') {
        objects.delete(key);
        res.statusCode = 204;
        return res.end();
      }
      if (!obj) {
        res.statusCode = 404;
        return res.end('<Error><Code>NoSuchKey</Code></Error>');
      }
      res.setHeader('Content-Type', obj.type || 'application/octet-stream');
      if (obj.meta) res.setHeader('x-amz-meta-blob-metadata', obj.meta);
      res.end(req.method === 'HEAD' ? undefined : obj.body);
    });
  };
  return { handler, objects, seen };
}

describe('the S3 blob store', () => {
  let srv, fake, env;
  const saved = {};
  before(async () => {
    fake = fakeS3({ bucket: 'shin-blobs', accessKeyId: 'AKTEST' });
    srv = await listen(fake.handler);
    env = {
      S3_ENDPOINT: srv.base,
      S3_REGION: 'nbg1',
      S3_BUCKET: 'shin-blobs',
      S3_ACCESS_KEY_ID: 'AKTEST',
      S3_SECRET_ACCESS_KEY: 'not-a-real-secret',
      S3_FORCE_PATH_STYLE: 'true'
    };
  });
  after(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await srv.close();
  });

  test('SigV4 matches AWS’s published GET Object example', () => {
    const h = signRequest({
      method: 'GET',
      url: 'https://examplebucket.s3.amazonaws.com/test.txt',
      headers: { range: 'bytes=0-9' },
      body: '',
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      now: new Date('2013-05-24T00:00:00Z')
    });
    assert.match(h.authorization, /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
    assert.match(h.authorization, /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,/);
  });

  test('get / set / getWithMetadata / delete / list, the Netlify Blobs shape', async () => {
    const store = createS3Blobs({ env }).store('vocab-images');
    assert.equal(await store.get('nope.jpg'), null);
    await store.set('abc.jpg', Buffer.from([1, 2, 3]), { metadata: { contentType: 'image/jpeg' } });
    assert.equal(fake.objects.get('vocab-images/abc.jpg').type, 'image/jpeg');

    const hit = await store.getWithMetadata('abc.jpg', { type: 'arrayBuffer' });
    assert.deepEqual([...new Uint8Array(hit.data)], [1, 2, 3]);
    assert.deepEqual(hit.metadata, { contentType: 'image/jpeg' });

    await store.set('n', '42');
    assert.equal(await store.get('n'), '42');
    assert.deepEqual((await store.list()).blobs.map((b) => b.key).sort(), ['abc.jpg', 'n']);

    await store.delete('abc.jpg');
    assert.equal(await store.getWithMetadata('abc.jpg'), null);
  });

  test('keys with : and / are signed and stored as written', async () => {
    const store = createS3Blobs({ env }).store('passcode-failures');
    await store.set('1966:2001:db8:1:2::/64', '["x"]');
    assert.ok(fake.objects.has('passcode-failures/1966:2001:db8:1:2::/64'));
    assert.equal(await store.get('1966:2001:db8:1:2::/64'), '["x"]');
  });

  test('virtual-host style puts the bucket in the host name', () => {
    const { objectUrl } = createS3Blobs({ env: { ...env, S3_ENDPOINT: 'https://nbg1.your-objectstorage.com', S3_FORCE_PATH_STYLE: '' } });
    assert.equal(objectUrl('vocab-images/a.jpg'), 'https://shin-blobs.nbg1.your-objectstorage.com/vocab-images/a.jpg');
  });

  test('a missing setting is named, not guessed', () => {
    assert.throws(() => createS3Blobs({ env: { ...env, S3_BUCKET: '' } }), /S3_BUCKET/);
  });

  test('the site’s own code uses the bucket once S3_* is set: pictures and the passcode brake', async () => {
    for (const k of Object.keys(env)) {
      saved[k] = process.env[k];
      process.env[k] = env[k];
    }
    saved.SITE_PASSCODE = process.env.SITE_PASSCODE;
    process.env.SITE_PASSCODE = 'right';
    const { _resetBlobStore } = await import('../netlify/lib/blob-store.mjs');
    _resetBlobStore();

    const images = await import('../netlify/lib/images.mjs');
    const key = await images.putImage(Buffer.from('png-bytes'), 'image/png');
    assert.ok(fake.objects.has(`vocab-images/${key}`));
    const back = await images.getImage(key);
    assert.equal(back.contentType, 'image/png');
    assert.equal(back.bytes.toString(), 'png-bytes');

    const P = await import('../netlify/lib/passcode.mjs');
    P._resetMemory();
    const req = (pc) => new Request('https://x/api/camera', { headers: { 'x-store-passcode': pc } });
    const NOW = Date.UTC(2026, 10, 7, 12);
    for (let i = 0; i < P.MAX_FAILURES; i++) await P.checkPasscode(req('guess-' + i), { ip: '203.0.113.77' }, { now: NOW });
    P._resetMemory();   // a restart: memory gone, the bucket remembers
    assert.equal(await P.checkPasscode(req('right'), { ip: '203.0.113.77' }, { now: NOW }), 'locked');
    assert.ok([...fake.objects.keys()].some((k) => k.startsWith('passcode-failures/')));

    const { spend } = await import('../netlify/lib/rate-limit.mjs');
    assert.equal((await spend({ perHour: 5, perDay: 5 })).allowed, true);
    assert.ok([...fake.objects.keys()].some((k) => k.startsWith('vocab-usage/')));
  });
});
