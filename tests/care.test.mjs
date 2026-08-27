import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const HERE = dirname(fileURLToPath(import.meta.url));
await import(join(HERE, '../assets/js/care.js'));
import { readFileSync } from 'node:fs';
const Care = globalThis.Care;
const data = JSON.parse(readFileSync(join(HERE, '../data/species.json'), 'utf8'));

const speciesById = {};
data.species.forEach(s => { speciesById[s.id] = s; });

let pass = 0; const fails = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) pass++; else fails.push(`${name}\n     expected ${e}\n     got      ${a}`);
}
function at(iso, weather = 1) {
  return Care.create({ speciesById, now: () => new Date(iso), weatherFactor: () => weather });
}
const daysAgo = (iso, n) => { const d = new Date(iso); d.setDate(d.getDate() - n); return d.toISOString(); };
const taskOf = (c, p, type) => c.tasksFor(p).find(t => t.type === type);

/* ---- seasons ---------------------------------------------------------- */
check('season Apr', Care.seasonOf(new Date('2026-04-15')), 'spring');
check('season Jun', Care.seasonOf(new Date('2026-06-15')), 'rainy');
check('season Aug', Care.seasonOf(new Date('2026-08-15')), 'summer');
check('season Nov', Care.seasonOf(new Date('2026-11-15')), 'autumn');
check('season Jan', Care.seasonOf(new Date('2026-01-15')), 'winter');

/* ---- watering intervals track the season ------------------------------ */
const monstera = { id: 'p1', speciesId: 'monstera', care: {} };
check('monstera water gap, summer', at('2026-08-10').waterIntervalDays(monstera), 5);
check('monstera water gap, winter', at('2026-01-10').waterIntervalDays(monstera), 14);
check('monstera water gap, spring', at('2026-04-10').waterIntervalDays(monstera), 7);

/* Forecast bends the interval: heat shortens, heavy rain stretches. */
check('summer gap in a heatwave', at('2026-08-10', 0.7).waterIntervalDays(monstera), 4);
check('summer gap after downpour', at('2026-08-10', 1.4).waterIntervalDays(monstera), 7);
/* A manual override always wins over species + weather. */
check('manual override wins',
  at('2026-08-10', 0.7).waterIntervalDays({ speciesId: 'monstera', waterEvery: 10, care: {} }), 10);

/* ---- watering due dates ----------------------------------------------- */
let c = at('2026-08-10');
check('never watered -> due today', taskOf(c, monstera, 'water').state, 'today');
check('watered today -> not due',
  taskOf(c, { speciesId: 'monstera', care: { watered: '2026-08-10T09:00:00Z' } }, 'water').days, 5);
check('watered 8 days ago in summer -> 3 days overdue',
  taskOf(c, { speciesId: 'monstera', care: { watered: daysAgo('2026-08-10', 8) } }, 'water').days, -3);
check('overdue state',
  taskOf(c, { speciesId: 'monstera', care: { watered: daysAgo('2026-08-10', 8) } }, 'water').state, 'overdue');

/* ---- feeding rests out of season -------------------------------------- */
check('monstera feeds in summer',
  taskOf(at('2026-08-10'), { speciesId: 'monstera', care: { fertilised: daysAgo('2026-08-10', 40) } }, 'fertilise').state,
  'overdue');
check('monstera rests in winter',
  taskOf(at('2026-01-10'), { speciesId: 'monstera', care: { fertilised: daysAgo('2026-01-10', 400) } }, 'fertilise').state,
  'resting');
check('viola feeds in winter (a winter plant)',
  taskOf(at('2026-01-10'), { speciesId: 'viola', care: { fertilised: daysAgo('2026-01-10', 20) } }, 'fertilise').state,
  'overdue');

/* ---- pruning windows: the heart of the request ------------------------ */
const hydrangea = id => ({ speciesId: 'hydrangea', care: id });

// Hydrangea prunes in July only.
check('hydrangea in July, never pruned -> due now',
  taskOf(at('2026-07-10'), hydrangea({}), 'prune').state, 'today');
check('hydrangea in July, pruned 5 days ago -> waits a year',
  taskOf(at('2026-07-10'), hydrangea({ pruned: daysAgo('2026-07-10', 5) }), 'prune').date.toISOString().slice(0, 7),
  '2027-07');
check('hydrangea in March -> next window is this July',
  taskOf(at('2026-03-10'), hydrangea({}), 'prune').date.toISOString().slice(0, 7), '2026-07');
check('hydrangea in September -> next window is next July',
  taskOf(at('2026-09-10'), hydrangea({}), 'prune').date.toISOString().slice(0, 7), '2027-07');
check('hydrangea pruned last year, July again -> due now',
  taskOf(at('2026-07-10'), hydrangea({ pruned: '2025-07-12T00:00:00Z' }), 'prune').state, 'today');

// Rosemary has two windows a year (Apr/May and Sep/Oct).
check('rosemary pruned in April, checked in September -> due again',
  taskOf(at('2026-09-10'), { speciesId: 'rosemary', care: { pruned: '2026-04-20T00:00:00Z' } }, 'prune').state,
  'today');
check('rosemary pruned in April, checked in May -> already done',
  taskOf(at('2026-05-10'), { speciesId: 'rosemary', care: { pruned: '2026-04-20T00:00:00Z' } }, 'prune').date.toISOString().slice(0, 7),
  '2026-09');

// Haworthia has no pruning at all.
check('haworthia has no prune task',
  taskOf(at('2026-05-10'), { speciesId: 'haworthia', care: {} }, 'prune'), undefined);

/* ---- repotting is a two-yearly job ------------------------------------ */
check('repot in window, done 300 days ago -> not yet',
  taskOf(at('2026-05-10'), { speciesId: 'monstera', care: { repotted: daysAgo('2026-05-10', 300) } }, 'repot').state,
  'later');
check('repot in window, done 600 days ago -> due',
  taskOf(at('2026-05-10'), { speciesId: 'monstera', care: { repotted: daysAgo('2026-05-10', 600) } }, 'repot').state,
  'today');
check('repot never done, in window -> due',
  taskOf(at('2026-05-10'), { speciesId: 'monstera', care: {} }, 'repot').state, 'today');

/* ---- urgency picks the worst job -------------------------------------- */
const neglected = {
  speciesId: 'monstera',
  care: { watered: daysAgo('2026-08-10', 20), fertilised: daysAgo('2026-08-10', 35) }
};
check('urgency picks the most overdue', at('2026-08-10').urgency(neglected).type, 'water');
check('healthy plant has no urgency',
  at('2026-08-10').urgency({ speciesId: 'monstera', care: {
    watered: '2026-08-10T00:00:00Z', fertilised: '2026-08-09T00:00:00Z',
    pruned: '2026-06-15T00:00:00Z', repotted: '2026-05-10T00:00:00Z' } }),
  null);

/* ---- every seeded species schedules without throwing ------------------- */
let broken = [];
['2026-01-15','2026-04-15','2026-06-15','2026-08-15','2026-11-15'].forEach(day => {
  const cc = at(day);
  data.species.forEach(s => {
    try {
      const ts = cc.tasksFor({ speciesId: s.id, care: {} });
      if (!ts.some(t => t.type === 'water')) broken.push(`${s.id} @${day}: no water task`);
      ts.forEach(t => {
        if (t.state !== 'resting' && !(t.date instanceof Date)) broken.push(`${s.id} @${day}: ${t.type} has no date`);
      });
    } catch (e) { broken.push(`${s.id} @${day}: threw ${e.message}`); }
  });
});
check('all 34 species schedule cleanly across the year', broken, []);

console.log(fails.length
  ? `${pass} passed, ${fails.length} FAILED:\n` + fails.map(f => '  ✗ ' + f).join('\n')
  : `✓ all ${pass} care-scheduling assertions passed`);
process.exit(fails.length ? 1 : 0);
