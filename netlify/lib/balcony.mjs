/* ==========================================================================
   Balcony ⇄ Trello sync.

   The overdue-task calculation deliberately reuses assets/js/care.js — the
   same unit-tested module the browser runs — so a card can never disagree
   with what the site shows. It is a UMD file with no DOM dependency, which
   is exactly why it was pulled out of the page in the first place.
   ========================================================================== */

import '../../assets/js/care.js';
import speciesData from '../../data/species.json' with { type: 'json' };
import { readCollection, writeRecord } from './records.mjs';
import { openCards, createCard, archiveCard, cardFor, parseMarker, markerFor } from './trello.mjs';

const Care = globalThis.Care;

const SPECIES_BY_ID = Object.create(null);
for (const s of speciesData.species) SPECIES_BY_ID[s.id] = s;

const SETTINGS_COLLECTION = 'settings';
const SETTINGS_ID = 'trello';

function pick(obj, lang, fallback = '') {
  if (!obj) return fallback;
  if (typeof obj === 'string') return obj;
  return obj[lang] || obj.en || fallback;
}

function displayName(plant, lang) {
  if (plant.name) return plant.name;
  const sp = plant.speciesId ? SPECIES_BY_ID[plant.speciesId] : null;
  if (sp) return pick(sp.name, lang);
  return plant.customSpecies || 'Plant';
}

/* ------------------------------------------------------------ settings -- */

export async function readSettings(db) {
  const rows = await readCollection(db, SETTINGS_COLLECTION);
  const found = rows.find((r) => r.id === SETTINGS_ID);
  return found || { id: SETTINGS_ID, enabled: false, boardId: null, listId: null, lang: 'en' };
}

export async function writeSettings(db, settings) {
  const record = {
    ...settings,
    id: SETTINGS_ID,
    updatedAt: new Date().toISOString(),
    deleted: false
  };
  await writeRecord(db, SETTINGS_COLLECTION, record);
  return record;
}

/* --------------------------------------------------------------- tasks -- */

/**
 * Every care task that is due today or overdue, flattened and ready to become
 * a card. `now` is injectable so the tests can stand in any month.
 */
export function tasksFromPlants(plants, { now = new Date(), lang = 'en' } = {}) {
  const care = Care.create({ speciesById: SPECIES_BY_ID, now: () => now });
  const out = [];

  for (const plant of plants) {
    if (plant.deleted) continue;
    const sp = plant.speciesId ? SPECIES_BY_ID[plant.speciesId] : null;

    for (const task of care.tasksFor(plant)) {
      if (task.days === null || task.days > 0) continue;   // not due yet
      out.push({
        plantId: plant.id,
        plantName: displayName(plant, lang),
        species: sp ? pick(sp.name, lang) : (plant.customSpecies || ''),
        location: plant.location || '',
        tip: sp && task.taskType !== 'water' ? pick(sp.tip, lang) : '',
        taskType: task.type,
        daysLate: Math.abs(task.days),
        dueISO: task.date instanceof Date ? task.date.toISOString() : null
      });
    }
  }

  // Most overdue first, so the top of the list is the most urgent.
  out.sort((a, b) => b.daysLate - a.daysLate);
  return out;
}

/* ---------------------------------------------------------------- sync -- */

/** Record a completed job on the plant, exactly as the site's own UI would. */
async function logCare(db, plants, plantId, taskType, when) {
  const plant = plants.find((p) => p.id === plantId);
  if (!plant) return false;

  const field = Care.CARE_FIELD[taskType];
  if (!field) return false;

  const stamp = when.toISOString();
  const care = { ...(plant.care || {}), [field]: stamp };
  const log = [{ id: `trello-${stamp}-${taskType}`, at: stamp, type: taskType, note: 'Trello' }]
    .concat(plant.log || [])
    .slice(0, 200);

  const updated = { ...plant, care, log, updatedAt: stamp, deleted: false };
  await writeRecord(db, 'plants', updated);

  // Keep the in-memory copy in step so the creation pass below sees it done.
  Object.assign(plant, updated);
  return true;
}

/**
 * One sync pass.
 *   1. Cards ticked complete are logged back onto the plant and archived.
 *   2. Overdue tasks without an open card get one.
 * Returns a summary rather than throwing on partial failure, so one bad card
 * never aborts the whole run.
 */
export async function syncBalconyToTrello(db, { listId, lang = 'en', now = new Date(), dryRun = false } = {}) {
  if (!listId) {
    const err = new Error('No Trello list selected.');
    err.code = 'no-list';
    err.status = 400;
    throw err;
  }

  const plants = await readCollection(db, 'plants');
  const cards = await openCards(listId);

  const completed = [];
  const errors = [];

  /* --- 1. completions coming back from Trello ------------------------- */
  for (const card of cards) {
    const marker = parseMarker(card.desc);
    if (!marker || !card.dueComplete) continue;
    try {
      const ok = await logCare(db, plants, marker.plantId, marker.taskType, now);
      if (!dryRun) await archiveCard(card.id);
      completed.push({ ...marker, cardId: card.id, logged: ok });
    } catch (err) {
      errors.push({ stage: 'complete', cardId: card.id, message: err.message });
    }
  }

  /* --- 2. tasks that still need a card -------------------------------- */
  const stillOpen = new Set(
    cards
      .filter((c) => !c.dueComplete)
      .map((c) => parseMarker(c.desc))
      .filter(Boolean)
      .map((m) => markerFor(m.plantId, m.taskType))
  );

  const tasks = tasksFromPlants(plants, { now, lang });
  const created = [];
  const skipped = [];

  for (const task of tasks) {
    const marker = markerFor(task.plantId, task.taskType);
    if (stillOpen.has(marker)) { skipped.push(marker); continue; }
    try {
      const payload = cardFor(task, lang);
      if (!dryRun) await createCard({ listId, ...payload });
      created.push({ marker, name: payload.name });
      stillOpen.add(marker);
    } catch (err) {
      errors.push({ stage: 'create', marker, message: err.message });
    }
  }

  return {
    ok: errors.length === 0,
    at: now.toISOString(),
    plants: plants.length,
    due: tasks.length,
    created,
    completed,
    skipped: skipped.length,
    errors
  };
}
