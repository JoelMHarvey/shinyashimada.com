/* The error reporter (server/error-report.mjs) sends nothing personal, and
 * nothing at all without a DSN, and the server calls it with a function's
 * name and never the address asked for.
 *
 *   node --test tests/error-report.test.mjs
 *
 * No network: fetch is replaced, and the DSN is a made-up one. */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  MAX_EVENTS_PER_MINUTE, MAX_MESSAGE, buildEvent, installProcessHandlers, parseDsn, reportError,
  resetRateLimit, scrub
} from '../server/error-report.mjs';
import { createApp } from '../server/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const quiet = { log() {}, warn() {}, error() {} };
const DSN = 'https://abc123@errors.example.test/7';

// A made-up key in a payment provider's shape, in two pieces so that GitHub's
// secret scanning does not take this file for a leak.
const FAKE_KEY = 'sk_' + 'live_' + 'abcdefghijklmnopqrstuvwxyz012345';

const SECRETS = [
  'jane.doe@example.com', '203.0.113.7', '2001:db8::8a2e:370:7334',
  'My mother is ill and I need help', '07700900123', '4242424242424242',
  FAKE_KEY, 'token=abc', 'Jane Doe',
  // this site: a note on a balcony plant, a book in the library, the passcode
  'Shiso bolted, cut back and moved to the north rail', 'Il nome della rosa', 'open sesame on the balcony'
];

function sampleError() {
  return new TypeError(
    'could not save note \'My mother is ill and I need help\' for "Jane Doe" ' +
      '<jane.doe@example.com> from 203.0.113.7 / 2001:db8::8a2e:370:7334, phone 07700900123, ' +
      `card 4242424242424242, key ${FAKE_KEY}, ` +
      'see https://example.com/reset?token=abc ; ' +
      'plant note "Shiso bolted, cut back and moved to the north rail", book \'Il nome della rosa\', ' +
      'passcode `open sesame on the balcony` ; ' +
      'DETAIL: Key (email)=(jane.doe@example.com) already exists; column \'email\' of relation "users"'
  );
}

/** Replace fetch and SENTRY_DSN for one test; undone in afterEach. */
const realFetch = globalThis.fetch;
const realDsn = process.env.SENTRY_DSN;
let calls;
function stub({ dsn, fail = false } = {}) {
  calls = [];
  if (dsn) process.env.SENTRY_DSN = dsn;
  else delete process.env.SENTRY_DSN;
  globalThis.fetch = async (url, init) => {
    calls.push([url, init]);
    if (fail) throw new Error('down');
    return new Response('{}');
  };
}

describe('error-report', () => {
  beforeEach(() => {
    resetRateLimit();
    stub();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realDsn === undefined) delete process.env.SENTRY_DSN;
    else process.env.SENTRY_DSN = realDsn;
  });

  test('builds an event with no personal data in it', () => {
    const event = buildEvent(sampleError(), { app: 't', where: 'route', route: 'POST /.netlify/functions/store' });
    const blob = JSON.stringify(event);
    for (const secret of SECRETS) assert.ok(!blob.includes(secret), secret);
    const value = event.exception.values[0];
    assert.equal(value.type, 'TypeError');
    // quoted text goes whole, even a single word: it may be a name
    assert.ok(!value.value.includes("'email'"));
    assert.ok(value.value.includes('[text]'));
    assert.ok(value.value.includes('[email]'));
    assert.equal(event.transaction, 'POST /.netlify/functions/store');
    assert.ok(value.stacktrace.frames.length > 0);
  });

  test('sends only the expected fields', () => {
    const event = buildEvent(sampleError(), { app: 't' });
    for (const banned of ['request', 'user', 'extra', 'contexts', 'breadcrumbs', 'server_name', 'modules']) {
      assert.ok(!(banned in event), banned);
    }
    const home = process.env.HOME ?? '/Users/';
    for (const frame of event.exception.values[0].stacktrace.frames) {
      assert.deepEqual(Object.keys(frame).sort(), ['filename', 'function', 'in_app', 'lineno']);
      assert.ok(!frame.filename.includes(home), frame.filename);
    }
  });

  test('drops a dumped query and short amounts', () => {
    const message =
      '\nInvalid `store.put()` call:\n\n' +
      '{ data: { name: \'Shiso\', owner: "Jane", total: 1284.5, note: \'see you at 9\' } }\n\n' +
      'Unique constraint failed on the fields: (`owner`), total 284.50 on 2026-11-22 at 09:15';
    const out = scrub(message);
    for (const secret of ['Shiso', 'Jane', '1284', '284.50', 'see you', '2026', '09:15', 'data:']) assert.ok(!out.includes(secret), secret);
    assert.ok(out.includes('`store.put()`'));
    assert.equal(scrub("KeyError: 'Jane'"), 'KeyError: [text]');
    assert.equal(scrub('passphrase "open-sesame-balcony" refused'), 'passphrase [text] refused');
  });

  test('caps the message', () => {
    assert.ok(scrub('word '.repeat(500)).length <= MAX_MESSAGE);
  });

  test('sends nothing without a DSN', async () => {
    process.env.SENTRY_DSN = '';
    assert.equal(await reportError(sampleError(), { app: 't' }), false);
    delete process.env.SENTRY_DSN;
    assert.equal(await reportError(sampleError(), { app: 't' }), false);
    assert.equal(calls.length, 0);
  });

  test('treats a malformed DSN as no DSN', () => {
    for (const bad of ['', 'not a url', 'https://errors.example.test/3', 'ftp://k@errors.example.test/3', 'https://k@errors.example.test/abc']) {
      assert.equal(parseDsn(bad), null);
    }
  });

  test('sends one scrubbed POST when a DSN is set', async () => {
    stub({ dsn: DSN });
    assert.equal(await reportError(sampleError(), { app: 't', where: 'cron:digest' }), true);
    assert.equal(calls.length, 1);
    const [url, init] = calls[0];
    assert.equal(url, 'https://errors.example.test/api/7/store/');
    assert.ok(init.headers['X-Sentry-Auth'].includes('sentry_key=abc123'));
    for (const secret of SECRETS) assert.ok(!String(init.body).includes(secret), secret);
    assert.equal(JSON.parse(String(init.body)).tags.where, 'cron:digest');
  });

  test('never throws when the tracker is down', async () => {
    stub({ dsn: DSN, fail: true });
    assert.equal(await reportError(sampleError(), { app: 't' }), true);
  });

  test('caps a flood', async () => {
    stub({ dsn: DSN });
    const results = await Promise.all(Array.from({ length: 30 }, () => reportError(sampleError(), { app: 't' })));
    assert.equal(results.filter(Boolean).length, MAX_EVENTS_PER_MINUTE);
    assert.equal(calls.length, MAX_EVENTS_PER_MINUTE);
  });

  test('the process handlers are not installed without a DSN', () => {
    const before = [process.listenerCount('uncaughtException'), process.listenerCount('unhandledRejection')];
    assert.equal(installProcessHandlers('t'), false);
    assert.deepEqual([process.listenerCount('uncaughtException'), process.listenerCount('unhandledRejection')], before);
  });
});

/* ------------------------------------------------- the server's calls -- */

describe('the server tells the reporter, by function name only', () => {
  let srv;
  let dir;
  let app;
  let reports;
  const settle = () => new Promise((r) => setTimeout(r, 20));

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'shin-report-'));
    await writeFile(path.join(dir, 'boom.mjs'),
      `export default async (req) => { const b = await req.text(); throw new Error('cannot save "' + b + '"'); };`);
    await writeFile(path.join(dir, 'caught.mjs'),
      `export default async () => Response.json({ error: 'Could not save.' }, { status: 500 });`);
    await writeFile(path.join(dir, 'notset.mjs'),
      `export default async () => Response.json({ error: 'no_database' }, { status: 503 });`);
    await writeFile(path.join(dir, 'fine.mjs'),
      `export default async () => Response.json({ ok: true });`);
    await writeFile(path.join(dir, 'nightly.mjs'),
      `export const config = { schedule: '0 3 * * *' };\nexport default async () => new Response('sync failed', { status: 500 });`);
    app = await createApp({
      root: ROOT, functionsDir: dir, scheduler: false, log: quiet, env: { ...process.env },
      report: async (err, ctx) => { reports.push({ err, ctx }); return true; }
    });
    const server = http.createServer(app.handle);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    srv = { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
  });
  beforeEach(() => { reports = []; });
  after(async () => {
    await srv.close();
    app.stop();
    await rm(dir, { recursive: true, force: true });
  });

  test('a function that throws is reported with its name, not the address or the body', async () => {
    const res = await fetch(`${srv.base}/api/boom/records/42?passcode=open+sesame+on+the+balcony`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'session=abcdef', 'x-site-passcode': 'open sesame on the balcony' },
      body: 'Shiso bolted, cut back and moved to the north rail'
    });
    assert.equal(res.status, 500);
    await settle();
    assert.equal(reports.length, 1);
    assert.deepEqual(reports[0].ctx, { app: 'shinyashimada', where: 'function:boom', route: 'POST /.netlify/functions/boom' });
    // and what would leave, built from that call, holds none of it
    const blob = JSON.stringify(buildEvent(reports[0].err, reports[0].ctx));
    for (const secret of ['Shiso', 'open sesame', 'open+sesame', 'records/42', 'session=abcdef', 'passcode']) {
      assert.ok(!blob.includes(secret), secret);
    }
  });

  test('a function that caught its own error and answered 500 is reported by name', async () => {
    const res = await fetch(`${srv.base}/.netlify/functions/caught?q=Il+nome+della+rosa`);
    assert.equal(res.status, 500);
    await settle();
    assert.equal(reports.length, 1);
    assert.deepEqual(reports[0].ctx, { app: 'shinyashimada', where: 'function:caught', route: 'GET /.netlify/functions/caught' });
    assert.equal(reports[0].err.message, 'function caught answered 500');
  });

  test('a 200, a 404 and a 503 are not reported', async () => {
    assert.equal((await fetch(`${srv.base}/.netlify/functions/fine`)).status, 200);
    assert.equal((await fetch(`${srv.base}/no/such/page`)).status, 404);
    assert.equal((await fetch(`${srv.base}/.netlify/functions/notset`)).status, 503);
    assert.equal((await fetch(`${srv.base}/api/health/live`)).status, 200);
    await settle();
    assert.equal(reports.length, 0);
  });

  test('with the real reporter and no DSN, a failing function sends nothing', async () => {
    const saved = process.env.SENTRY_DSN;
    delete process.env.SENTRY_DSN;
    const fetched = [];
    const real = await createApp({ root: ROOT, functionsDir: dir, scheduler: false, log: quiet, env: { ...process.env } });
    const server = http.createServer(real.handle);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const realFetchNow = globalThis.fetch;
    try {
      const url = `http://127.0.0.1:${server.address().port}/.netlify/functions/caught`;
      globalThis.fetch = async (u, init) => { fetched.push(String(u)); return realFetchNow(u, init); };
      assert.equal((await fetch(url)).status, 500);
      await settle();
      assert.deepEqual(fetched, [url]);        // the test's own request, and no other
    } finally {
      globalThis.fetch = realFetchNow;
      if (saved !== undefined) process.env.SENTRY_DSN = saved;
      await new Promise((r) => server.close(r));
      real.stop();
    }
  });
});

describe('a scheduled function that fails is reported as cron:<name>', () => {
  test('a 500 from the daily job', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'shin-cron-'));
    await writeFile(path.join(dir, 'nightly.mjs'),
      `export const config = { schedule: '* * * * *' };\nexport default async () => new Response('sync failed', { status: 500 });`);
    const reports = [];
    const realSetTimeout = globalThis.setTimeout;
    // Fire the first scheduled run at once, and no later one.
    let fired = false;
    globalThis.setTimeout = (fn, ms, ...rest) => {
      if (!fired && ms > 1000) { fired = true; return realSetTimeout(fn, 0, ...rest); }
      return realSetTimeout(fn, ms, ...rest);
    };
    let app;
    try {
      app = await createApp({
        root: ROOT, functionsDir: dir, scheduler: true, log: quiet, env: { ...process.env },
        report: async (err, ctx) => { reports.push({ err, ctx }); return true; }
      });
      await new Promise((r) => realSetTimeout(r, 50));
    } finally {
      globalThis.setTimeout = realSetTimeout;
      app?.stop();
      await rm(dir, { recursive: true, force: true });
    }
    assert.equal(reports.length, 1);
    assert.deepEqual(reports[0].ctx, { app: 'shinyashimada', where: 'cron:nightly' });
    assert.equal(reports[0].err.message, 'cron nightly answered 500');
  });
});
