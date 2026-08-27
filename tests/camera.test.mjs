/* /api/camera refusal states. The URL is a route into a home network, so the
 * interesting cases are all the ways it must decline to hand it over. */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const { default: handler } = await import(join(HERE, '../netlify/functions/camera.mjs'));

let pass = 0; const fails = [];
const check = (n, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) pass++; else fails.push(`${n}\n     expected ${E}\n     got      ${A}`);
};
const reset = () => {
  delete process.env.SITE_PASSCODE; delete process.env.CAMERA_STREAM_URL;
  delete process.env.CAMERA_MODE; delete process.env.CAMERA_LABEL;
};
const call = async (headers = {}) => {
  const res = await handler(new Request('https://x/api/camera', { headers }));
  return { status: res.status, body: JSON.parse(await res.text()) };
};
const WITH = { 'x-store-passcode': 'good' };

reset();
{
  const r = await call();
  check('refuses with no passcode configured', [r.status, r.body.code], [503, 'passcode-required']);
}
reset(); process.env.SITE_PASSCODE = 'good';
{
  const r = await call({ 'x-store-passcode': 'bad' });
  check('rejects a wrong passcode', [r.status, r.body.code], [401, 'unauthorized']);
  const r2 = await call();
  check('rejects a missing passcode', [r2.status, r2.body.code], [401, 'unauthorized']);
}
{
  const r = await call(WITH);
  check('says when no camera is set up', [r.status, r.body.code], [503, 'no-camera']);
}
process.env.CAMERA_STREAM_URL = 'http://192.168.1.21:1984/stream.html?src=balcony';
{
  const r = await call(WITH);
  check('rejects a private/plain-http address', [r.status, r.body.code], [500, 'bad-camera-url']);
  check('and explains why', /not reachable/.test(r.body.error), true);
}
process.env.CAMERA_STREAM_URL = 'not a url';
{
  const r = await call(WITH);
  check('rejects a malformed URL', [r.status, r.body.code], [500, 'bad-camera-url']);
}
process.env.CAMERA_STREAM_URL = 'https://balcony.example.com/stream.html?src=balcony';
{
  const r = await call(WITH);
  check('serves a valid URL to a passcode holder', [r.status, r.body.ok], [200, true]);
  check('url passed through', r.body.url, 'https://balcony.example.com/stream.html?src=balcony');
  check('defaults to iframe mode', r.body.mode, 'iframe');
}
process.env.CAMERA_MODE = 'hls'; process.env.CAMERA_LABEL = 'Balcony';
{
  const r = await call(WITH);
  check('honours a valid mode', r.body.mode, 'hls');
  check('and the label', r.body.label, 'Balcony');
}
process.env.CAMERA_MODE = 'javascript:alert(1)';
{
  const r = await call(WITH);
  check('ignores an unknown mode', r.body.mode, 'iframe');
}
{
  const res = await handler(new Request('https://x/api/camera', { method: 'POST', headers: WITH }));
  check('rejects non-GET', res.status, 405);
}
{
  const res = await handler(new Request('https://x/api/camera', { headers: WITH }));
  check('never cached', res.headers.get('cache-control'), 'no-store');
}

console.log(fails.length
  ? `${pass} passed, ${fails.length} FAILED:\n` + fails.map((f) => '  ✗ ' + f).join('\n')
  : `✓ all ${pass} camera endpoint assertions passed`);
process.exit(fails.length ? 1 : 0);
