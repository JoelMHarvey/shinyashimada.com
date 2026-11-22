/* Which database addresses get TLS, and that TLS always checks the
 * certificate (netlify/lib/db-ssl.mjs). */
import test from 'node:test';
import assert from 'node:assert/strict';

import pg from 'pg';

import { connectionFor, sslFor } from '../netlify/lib/db-ssl.mjs';

const VERIFY = { rejectUnauthorized: true };

test('this machine and its Docker network: no TLS', () => {
  assert.equal(sslFor('postgres://u:p@localhost:5432/db'), false);
  assert.equal(sslFor('postgres://u:p@127.0.0.1/db'), false);
  assert.equal(sslFor('postgres://u:p@[::1]:5432/db'), false);
  assert.equal(sslFor('postgresql://u:p@postgres:5432/shinyashimada'), false);
});

test('sslmode=disable is honoured wherever the server is', () => {
  assert.equal(sslFor('postgres://u:p@db.example.com/db?sslmode=disable'), false);
  assert.equal(sslFor('postgres://u:p@db.example.com/db?a=1&sslmode=disable'), false);
});

test('a remote server: TLS with the certificate checked', () => {
  assert.deepEqual(sslFor('postgres://u:p@ep-x.eu-west-2.aws.neon.tech/db'), VERIFY);
  assert.deepEqual(sslFor('postgres://u:p@db.example.com/db?sslmode=require'), VERIFY);
  assert.deepEqual(sslFor('postgres://u:p@203.0.113.7:5432/db'), VERIFY);
  assert.deepEqual(sslFor('postgres://u:p@[2001:db8::1]:5432/db'), VERIFY);
});

test('a name that only contains "localhost" is not this machine', () => {
  assert.deepEqual(sslFor('postgres://u:p@localhost.example.com/db'), VERIFY);
  assert.deepEqual(sslFor('postgres://u:p@db.example.com/localhost'), VERIFY);
});

test('no setting returns TLS without the check', () => {
  for (const mode of ['no-verify', 'prefer', 'allow', 'require', 'verify-ca', 'verify-full']) {
    assert.deepEqual(sslFor(`postgres://u:p@db.example.com/db?sslmode=${mode}`), VERIFY);
  }
});

test('an address it cannot read is treated as remote', () => {
  assert.deepEqual(sslFor('not a url'), VERIFY);
});

test('what the driver ends up with: sslmode in the address cannot switch the check off', () => {
  // pg lets sslmode in the address override the ssl option, so read back
  // what a real Client settled on.
  const settled = (url) => new pg.Client(connectionFor(url)).connectionParameters.ssl;
  for (const mode of ['no-verify', 'prefer', 'require', 'verify-full']) {
    assert.deepEqual(settled(`postgres://u:p@db.example.com/db?sslmode=${mode}`), VERIFY);
  }
  assert.deepEqual(settled('postgres://u:p@db.example.com/db'), VERIFY);
  assert.equal(settled('postgres://u:p@db.example.com/db?sslmode=disable'), false);
  assert.equal(settled('postgresql://u:p@postgres:5432/shinyashimada'), false);
  assert.equal(settled('postgres://u:p@localhost/db?sslmode=require'), false);
});

test('connectionFor keeps everything in the address except sslmode', () => {
  const { connectionString } = connectionFor('postgres://u:p%40x@db.example.com:6543/db?sslmode=require&application_name=site');
  const u = new URL(connectionString);
  assert.equal(u.username, 'u');
  assert.equal(decodeURIComponent(u.password), 'p@x');
  assert.equal(u.host, 'db.example.com:6543');
  assert.equal(u.pathname, '/db');
  assert.equal(u.searchParams.get('application_name'), 'site');
  assert.equal(u.searchParams.has('sslmode'), false);
});
