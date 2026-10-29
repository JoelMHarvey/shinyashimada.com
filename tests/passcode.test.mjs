/* The brake on passcode guessing (netlify/lib/passcode.mjs).
 *
 * Runs without Netlify, so the counters are the in-memory fallback. The
 * properties that matter are the same either way: wrong guesses from one
 * address run out, the right passcode is refused too once they have, a
 * forged X-Forwarded-For does not buy a fresh allowance, and nobody else is
 * locked out with the guesser. */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const P = await import(join(HERE, '../netlify/lib/passcode.mjs'));
const { default: camera } = await import(join(HERE, '../netlify/functions/camera.mjs'));

let pass = 0; const fails = [];
const check = (n, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) pass++; else fails.push(`${n}\n     expected ${E}\n     got      ${A}`);
};

process.env.SITE_PASSCODE = 'right-passcode';
const req = (passcode, headers = {}) => new Request('https://x/api/camera', {
  headers: passcode === null ? headers : { 'x-store-passcode': passcode, ...headers }
});
const from = (ip) => ({ ip });
const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);

/* --- the allowance ------------------------------------------------------- */

P._resetMemory();
check('the right passcode passes', await P.checkPasscode(req('right-passcode'), from('203.0.113.5'), { now: NOW }), 'ok');
check('a wrong one does not', await P.checkPasscode(req('guess'), from('203.0.113.5'), { now: NOW }), 'bad');

P._resetMemory();
for (let i = 0; i < P.MAX_FAILURES; i++) await P.checkPasscode(req('guess-' + i), from('203.0.113.5'), { now: NOW });
check('locked after the allowance of wrong guesses',
  await P.checkPasscode(req('another'), from('203.0.113.5'), { now: NOW }), 'locked');
check('and the right passcode is refused while locked',
  await P.checkPasscode(req('right-passcode'), from('203.0.113.5'), { now: NOW }), 'locked');
check('another address is not locked with it',
  await P.checkPasscode(req('right-passcode'), from('198.51.100.7'), { now: NOW }), 'ok');
check('the lock lifts when the window rolls over',
  await P.checkPasscode(req('right-passcode'), from('203.0.113.5'), { now: NOW + P.WINDOW_MS }), 'ok');

/* --- what counts --------------------------------------------------------- */

P._resetMemory();
for (let i = 0; i < P.MAX_FAILURES * 2; i++) await P.checkPasscode(req(null), from('203.0.113.9'), { now: NOW });
check('requests with no passcode at all are not counted as guesses',
  await P.checkPasscode(req('right-passcode'), from('203.0.113.9'), { now: NOW }), 'ok');

P._resetMemory();
for (let i = 0; i < P.MAX_FAILURES * 3; i++) await P.checkPasscode(req('last-months-passcode'), from('203.0.113.10'), { now: NOW });
check('a device repeating one stale passcode does not lock the address',
  await P.checkPasscode(req('right-passcode'), from('203.0.113.10'), { now: NOW }), 'ok');

/* --- which address ------------------------------------------------------- */

P._resetMemory();
for (let i = 0; i < P.MAX_FAILURES; i++) {
  await P.checkPasscode(req('guess-' + i, { 'x-forwarded-for': `10.0.0.${i}` }), from('203.0.113.20'), { now: NOW });
}
check('a forged X-Forwarded-For does not reset the count',
  await P.checkPasscode(req('right-passcode', { 'x-forwarded-for': '10.9.9.9' }), from('203.0.113.20'), { now: NOW }), 'locked');

check('the address is Netlify\'s, not X-Forwarded-For',
  P.clientAddress(req('x', { 'x-forwarded-for': '1.2.3.4' }), from('203.0.113.20')), '203.0.113.20');
check('falls back to the header Netlify sets',
  P.clientAddress(req('x', { 'x-nf-client-connection-ip': '192.0.2.44', 'x-forwarded-for': '1.2.3.4' }), undefined), '192.0.2.44');
check('IPv6 is keyed by its /64',
  P.clientAddress(req('x'), from('2001:db8:aa:bb:1:2:3:4')), '2001:db8:aa:bb::/64');
check('so rotating inside the /64 does not help',
  P.clientAddress(req('x'), from('2001:db8:aa:bb:ffff:2:3:4')), '2001:db8:aa:bb::/64');

/* --- through the functions ----------------------------------------------- */

P._resetMemory();
process.env.CAMERA_STREAM_URL = 'https://cam.example/stream.html?src=balcony&mode=mse';
{
  const ctx = from('203.0.113.77');
  for (let i = 0; i < P.MAX_FAILURES; i++) await camera(req('nope-' + i), ctx);
  const res = await camera(req('right-passcode'), ctx);
  check('the camera answers 429 to a locked-out address', [res.status, (await res.json()).code], [429, 'too-many-attempts']);
  check('and says when to come back', res.headers.get('retry-after'), String(P.WINDOW_MS / 1000));
  const other = await camera(req('right-passcode'), from('203.0.113.78'));
  check('while a passcode holder elsewhere still gets the camera', other.status, 200);
}

delete process.env.SITE_PASSCODE;
delete process.env.CAMERA_STREAM_URL;

console.log(`\npasscode: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log(fails.map((f) => '  ✗ ' + f).join('\n'));
  process.exit(1);
}
