/* The check-in to Mission Control after a scheduled run (server/heartbeat.mjs).
 *
 *   node --test tests/heartbeat.test.mjs
 *
 * No network: fetch is a fake that records what it was asked for. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  checkIn, expectedSeconds, graceSeconds, heartbeatName, heartbeatUrl, runWithHeartbeat
} from '../server/heartbeat.mjs';

const TOKEN = 'tok-SECRET-123';
const BASE = 'https://ops.example.test/api/heartbeat';
const ENV = { HEARTBEAT_URL: BASE, HEARTBEAT_TOKEN: TOKEN };
const FN = 'balcony-trello-sync';
const CRON = '0 21 * * *';
const EXPECTED_URL = `${BASE}/${TOKEN}/shinyashimada-balcony-trello-sync?project=shinyashimada&expected=86400&grace=7200`;

/** A fetch that records its calls and answers (or fails) as told. */
function fakeFetch(answer = () => new Response('ok', { status: 200 })) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return answer(url, init);
  };
  return { fetch, calls };
}

/** A log that keeps every line as one string. */
function fakeLog() {
  const lines = [];
  const keep = (...args) => lines.push(args.map((a) => (a instanceof Error ? `${a.stack} ${a.cause || ''}` : String(a))).join(' '));
  return { lines, log: keep, warn: keep, error: keep };
}

const ok = async () => new Response('done', { status: 200 });

describe('the heartbeat check-in', () => {
  test('the name, the interval and the grace', () => {
    assert.equal(heartbeatName(FN), 'shinyashimada-balcony-trello-sync');
    assert.equal(heartbeatName('Nightly_Job.v2'), 'shinyashimada-nightly-job-v2');
    assert.match(heartbeatName('x'.repeat(200)), /^[a-z0-9][a-z0-9_-]{0,63}$/);
    assert.equal(expectedSeconds(CRON), 86400);
    assert.equal(expectedSeconds('@hourly'), 3600);
    assert.equal(expectedSeconds('*/5 * * * *'), 300);
    assert.equal(expectedSeconds('not a cron'), 86400);
    assert.equal(graceSeconds(86400), 7200);
    assert.equal(graceSeconds(3600), 600);
  });

  test('URL or token unset or empty: no fetch at all', async () => {
    const envs = [
      {},
      { HEARTBEAT_URL: BASE },
      { HEARTBEAT_TOKEN: TOKEN },
      { HEARTBEAT_URL: '', HEARTBEAT_TOKEN: TOKEN },
      { HEARTBEAT_URL: BASE, HEARTBEAT_TOKEN: '' },
      { HEARTBEAT_URL: '  ', HEARTBEAT_TOKEN: '  ' }
    ];
    for (const env of envs) {
      const f = fakeFetch();
      const log = fakeLog();
      const res = await runWithHeartbeat(FN, CRON, ok, { env, fetch: f.fetch, log });
      assert.equal(res.status, 200);
      assert.equal(f.calls.length, 0, JSON.stringify(Object.keys(env)));
      assert.deepEqual(log.lines, []);
      assert.equal(heartbeatUrl(FN, CRON, { env }), null);
    }
  });

  test('a good run: exactly one GET to the expected address, with a timeout', async () => {
    const f = fakeFetch();
    const log = fakeLog();
    const res = await runWithHeartbeat(FN, CRON, ok, { env: ENV, fetch: f.fetch, log });
    assert.equal(res.status, 200);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, EXPECTED_URL);
    assert.equal(f.calls[0].init.method, 'GET');
    assert.ok(f.calls[0].init.signal instanceof AbortSignal);
    assert.deepEqual(log.lines, []);
  });

  test('a trailing slash on HEARTBEAT_URL makes no difference', async () => {
    const f = fakeFetch();
    await runWithHeartbeat(FN, CRON, ok, { env: { ...ENV, HEARTBEAT_URL: `${BASE}//` }, fetch: f.fetch, log: fakeLog() });
    assert.equal(f.calls[0].url, EXPECTED_URL);
  });

  test('a run that throws: no check-in, and the error reaches the caller', async () => {
    const f = fakeFetch();
    await assert.rejects(
      runWithHeartbeat(FN, CRON, async () => { throw new Error('trello down'); }, { env: ENV, fetch: f.fetch, log: fakeLog() }),
      /trello down/
    );
    assert.equal(f.calls.length, 0);
  });

  test('a run that answers non-2xx, or no Response: no check-in', async () => {
    for (const result of [new Response('sync failed', { status: 500 }), new Response('', { status: 302 }), new Response('no', { status: 404 }), undefined, {}]) {
      const f = fakeFetch();
      const res = await runWithHeartbeat(FN, CRON, async () => result, { env: ENV, fetch: f.fetch, log: fakeLog() });
      assert.equal(res, result);
      assert.equal(f.calls.length, 0);
    }
  });

  test('fetch rejects: swallowed, one line, no token and no address in it', async () => {
    const f = fakeFetch(() => {
      throw Object.assign(new TypeError(`fetch failed for ${EXPECTED_URL}`), { cause: Object.assign(new Error(`connect ${EXPECTED_URL}`), { code: 'ECONNREFUSED' }) });
    });
    const log = fakeLog();
    const res = await runWithHeartbeat(FN, CRON, ok, { env: ENV, fetch: f.fetch, log });
    assert.equal(res.status, 200);
    assert.equal(f.calls.length, 1);
    assert.equal(log.lines.length, 1);
    assert.equal(log.lines[0], '[heartbeat] shinyashimada-balcony-trello-sync: check-in failed (TypeError ECONNREFUSED)');
    assert.ok(!log.lines[0].includes(TOKEN) && !log.lines[0].includes('ops.example.test'));
  });

  test('fetch times out: swallowed, one line, no token', async () => {
    const f = fakeFetch(() => { throw new DOMException(`The operation timed out: ${EXPECTED_URL}`, 'TimeoutError'); });
    const log = fakeLog();
    assert.equal(await checkIn(FN, CRON, { env: ENV, fetch: f.fetch, log }), false);
    assert.equal(log.lines.length, 1);
    assert.match(log.lines[0], /check-in failed \(TimeoutError\)$/);
    assert.ok(!log.lines[0].includes(TOKEN) && !log.lines[0].includes('ops.example.test'));
  });

  test('Mission Control answers non-2xx: one line with the status, no token', async () => {
    const f = fakeFetch(() => new Response(`bad token ${TOKEN}`, { status: 403 }));
    const log = fakeLog();
    assert.equal(await checkIn(FN, CRON, { env: ENV, fetch: f.fetch, log }), false);
    assert.deepEqual(log.lines, ['[heartbeat] shinyashimada-balcony-trello-sync: check-in answered 403']);
  });
});
