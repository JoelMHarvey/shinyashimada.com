/* The lockfile must describe packages any machine can fetch.
 *
 * This exists because it did not, once. A Playwright symlink into
 * node_modules — added locally so the browser tests could resolve it — was
 * picked up by `npm install` and recorded as a linked package pointing at an
 * absolute path on that machine. It installed fine there, because the path
 * existed, and broke the deploy where it did not.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const lock = JSON.parse(readFileSync(join(HERE, '../package-lock.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(HERE, '../package.json'), 'utf8'));

let pass = 0; const fails = [];
const check = (n, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) pass++; else fails.push(`${n}\n     expected ${E}\n     got      ${A}`);
};

const entries = Object.entries(lock.packages || {});

check('lockfile is version 3', lock.lockfileVersion, 3);
check('lockfile has entries', entries.length > 1, true);

// The defect that broke the deploy.
check('no linked packages',
  entries.filter(([, v]) => v.link).map(([k]) => k), []);
check('no paths escaping the project',
  entries.filter(([k]) => k.startsWith('../')).map(([k]) => k), []);
check('no machine-specific absolute paths',
  entries.filter(([k]) => /^\/|\/(opt|home|Users)\//.test(k)).map(([k]) => k), []);

// Anything without these cannot be fetched reproducibly on a clean builder.
check('every dependency has a resolved URL',
  entries.filter(([k, v]) => k && !v.resolved).map(([k]) => k), []);
check('every dependency has an integrity hash',
  entries.filter(([k, v]) => k && !v.integrity).map(([k]) => k), []);
check('every resolved URL is a registry URL',
  entries.filter(([k, v]) => k && v.resolved && !/^https:\/\//.test(v.resolved)).map(([k]) => k), []);

// The lockfile must actually match what package.json asks for.
const root = lock.packages[''] || {};
check('root dependencies match package.json', root.dependencies, pkg.dependencies);
check('root devDependencies match package.json', root.devDependencies, pkg.devDependencies);
check('lockfile name matches', lock.name, pkg.name);

// The one runtime dependency has to be there, or the functions cannot run.
check('pg is locked', !!lock.packages['node_modules/pg'], true);

console.log(fails.length
  ? `${pass} passed, ${fails.length} FAILED:\n` + fails.map((f) => '  ✗ ' + f).join('\n')
  : `✓ all ${pass} lockfile assertions passed`);
process.exit(fails.length ? 1 : 0);
