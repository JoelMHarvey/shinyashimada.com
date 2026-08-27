/* Balcony → Trello sync.
 *
 * Runs the real sync against a fake Postgres and a fake Trello (stubbed at
 * the fetch layer, so URL building, marker embedding and marker parsing are
 * all exercised for real). The two behaviours that matter:
 *   · a daily run must not repost the same job every day
 *   · ticking a card must actually log the care, or the card comes straight back
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

process.env.TRELLO_KEY = 'test-key';
process.env.TRELLO_TOKEN = 'test-token';

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = new Date('2026-08-27T09:00:00Z');
const ago = (d) => { const x = new Date(NOW); x.setDate(x.getDate() - d); return x.toISOString(); };

let pass = 0; const fails = [];
const check = (n, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) pass++; else fails.push(`${n}\n     expected ${E}\n     got      ${A}`);
};

/* ---- fake Postgres ---------------------------------------------------- */
function fakeDb(seed = []) {
  const rows = seed.map((r) => ({
    id: r.id, collection: r.collection, data: r.data,
    updated_at: r.updatedAt || NOW.toISOString(), deleted: !!r.deleted
  }));
  return {
    rows,
    async query(sql, params = []) {
      if (/CREATE TABLE|CREATE INDEX/.test(sql)) return { rows: [] };
      if (/^\s*SELECT id, data, updated_at, deleted/.test(sql)) {
        return { rows: rows.filter((r) => r.collection === params[0] && !r.deleted) };
      }
      if (/INSERT INTO store_records/.test(sql)) {
        const [id, collection, data, updatedAt, deleted] = params;
        const row = { id, collection, data: JSON.parse(data), updated_at: updatedAt, deleted: !!deleted };
        const i = rows.findIndex((r) => r.id === id);
        if (i === -1) rows.push(row);
        else if (rows[i].updated_at <= updatedAt) rows[i] = row;
        return { rows: [] };
      }
      return { rows: [] };
    }
  };
}

/* ---- fake Trello ------------------------------------------------------ */
function fakeTrello(initialCards = []) {
  const state = { cards: initialCards.slice(), created: [], archived: [], calls: [] };
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    const method = opts.method || 'GET';
    state.calls.push(`${method} ${u.pathname}`);
    if (!u.searchParams.get('key') || !u.searchParams.get('token')) {
      return { ok: false, status: 401, text: async () => 'no creds' };
    }
    if (method === 'GET' && /\/lists\/.+\/cards$/.test(u.pathname)) {
      return { ok: true, status: 200, text: async () => JSON.stringify(state.cards) };
    }
    if (method === 'POST' && u.pathname === '/1/cards') {
      const card = {
        id: `card-${state.created.length + 1}`,
        name: u.searchParams.get('name'),
        desc: u.searchParams.get('desc'),
        due: u.searchParams.get('due') || null,
        dueComplete: false
      };
      state.created.push(card);
      state.cards.push(card);
      return { ok: true, status: 200, text: async () => JSON.stringify(card) };
    }
    if (method === 'PUT' && /^\/1\/cards\//.test(u.pathname)) {
      const id = u.pathname.split('/').pop();
      state.archived.push(id);
      state.cards = state.cards.filter((c) => c.id !== id);
      return { ok: true, status: 200, text: async () => '{}' };
    }
    return { ok: false, status: 404, text: async () => 'not found' };
  };
  return state;
}

const { syncBalconyToTrello, tasksFromPlants } = await import(join(HERE, '../netlify/lib/balcony.mjs'));
const { markerFor } = await import(join(HERE, '../netlify/lib/trello.mjs'));

const thirstyMonstera = {
  id: 'p1', collection: 'plants',
  data: { id: 'p1', speciesId: 'monstera', name: 'Big monstera', location: 'south rail',
          care: { watered: ago(20), fertilised: ago(2), repotted: ago(30), pruned: ago(10) }, log: [] }
};
const happyJade = {
  id: 'p2', collection: 'plants',
  data: { id: 'p2', speciesId: 'jade', name: 'The fat one',
          care: { watered: ago(1), fertilised: ago(1), pruned: ago(1), repotted: ago(1) }, log: [] }
};

/* ---- task selection --------------------------------------------------- */
{
  const tasks = tasksFromPlants([thirstyMonstera.data, happyJade.data], { now: NOW, lang: 'en' });
  check('only overdue jobs are picked up', tasks.map((t) => `${t.plantId}:${t.taskType}`), ['p1:water']);
  check('lateness is reported', tasks[0].daysLate, 15);
  check('plant name carried through', tasks[0].plantName, 'Big monstera');
}

/* ---- first run creates a card ----------------------------------------- */
{
  const db = fakeDb([thirstyMonstera, happyJade]);
  const trello = fakeTrello([]);
  const r = await syncBalconyToTrello(db, { listId: 'list-1', lang: 'en', now: NOW });

  check('one card created', trello.created.length, 1);
  check('card carries the marker', trello.created[0].desc.includes(markerFor('p1', 'water')), true);
  check('card names the plant', trello.created[0].name.includes('Big monstera'), true);
  check('card says how late it is', trello.created[0].name.includes('15 days late'), true);
  check('healthy plant gets nothing', trello.created.filter((c) => c.name.includes('fat one')).length, 0);
  check('result summarises', [r.due, r.created.length, r.skipped], [1, 1, 0]);
}

/* ---- the important one: a second run must not repost ------------------ */
{
  const db = fakeDb([thirstyMonstera, happyJade]);
  const trello = fakeTrello([]);
  await syncBalconyToTrello(db, { listId: 'list-1', lang: 'en', now: NOW });
  const second = await syncBalconyToTrello(db, { listId: 'list-1', lang: 'en', now: NOW });

  check('second run creates nothing', trello.created.length, 1);
  check('second run reports it skipped', second.skipped, 1);

  // A week later, still unwatered and still one card.
  const later = new Date(NOW); later.setDate(later.getDate() + 7);
  await syncBalconyToTrello(db, { listId: 'list-1', lang: 'en', now: later });
  check('a week of daily runs still means one card', trello.created.length, 1);
}

/* ---- ticking the card logs the care and archives it -------------------- */
{
  const db = fakeDb([structuredClone(thirstyMonstera), happyJade]);
  const trello = fakeTrello([]);
  await syncBalconyToTrello(db, { listId: 'list-1', lang: 'en', now: NOW });

  // Shin ticks it off in Trello.
  trello.cards[0].dueComplete = true;

  const r = await syncBalconyToTrello(db, { listId: 'list-1', lang: 'en', now: NOW });
  check('completion is reported', r.completed.map((c) => `${c.plantId}:${c.taskType}`), ['p1:water']);
  check('the care was logged', r.completed[0].logged, true);
  check('the card was archived', trello.archived, ['card-1']);

  const plant = db.rows.find((row) => row.id === 'p1').data;
  check('watering recorded on the plant', plant.care.watered, NOW.toISOString());
  check('it shows in the plant history', plant.log[0].type, 'water');

  check('and no replacement card is posted', trello.created.length, 1);
}

/* ---- preview writes nothing ------------------------------------------- */
{
  const db = fakeDb([thirstyMonstera, happyJade]);
  const trello = fakeTrello([]);
  const r = await syncBalconyToTrello(db, { listId: 'list-1', lang: 'en', now: NOW, dryRun: true });
  check('preview reports what it would do', r.created.length, 1);
  check('preview creates no cards', trello.created.length, 0);
}

/* ---- guards ------------------------------------------------------------ */
{
  const db = fakeDb([thirstyMonstera]);
  fakeTrello([]);
  let code = null;
  try { await syncBalconyToTrello(db, { listId: null, now: NOW }); } catch (e) { code = e.code; }
  check('refuses to run without a list', code, 'no-list');
}

/* ---- Japanese cards ---------------------------------------------------- */
{
  const db = fakeDb([thirstyMonstera, happyJade]);
  const trello = fakeTrello([]);
  await syncBalconyToTrello(db, { listId: 'list-1', lang: 'ja', now: NOW });
  check('card is written in Japanese', trello.created[0].name.includes('水やり'), true);
  check('and still carries the marker', trello.created[0].desc.includes(markerFor('p1', 'water')), true);
}

console.log(fails.length
  ? `${pass} passed, ${fails.length} FAILED:\n` + fails.map((f) => '  ✗ ' + f).join('\n')
  : `✓ all ${pass} Trello sync assertions passed`);
process.exit(fails.length ? 1 : 0);
