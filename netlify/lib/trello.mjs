/* ==========================================================================
   Trello REST helpers for the balcony sync.

   Cards carry a hidden marker in their description — [balcony:<plantId>:<type>]
   — which is how a task is matched to its card across runs. Without it a
   daily sync would post "Water the monstera" every single day.

   The loop is closed in both directions, narrowly:
     · an overdue task with no open card  -> a card is created
     · a marker card ticked as complete   -> the care is logged on the plant,
                                             and the card is archived
   Without that second half the card is a dead end: Shin ticks it, the site
   still thinks the plant is thirsty, and the card comes straight back.
   ========================================================================== */

const API = 'https://api.trello.com/1';
const TIMEOUT_MS = 9000;

/** Cards are matched by plant and task type, not by due date: one open card
 *  per job, however late it gets. */
export function markerFor(plantId, taskType) {
  return `[balcony:${plantId}:${taskType}]`;
}

const MARKER_RE = /\[balcony:([^\]:]+):([^\]:]+)\]/;

export function parseMarker(desc) {
  const m = MARKER_RE.exec(String(desc || ''));
  return m ? { plantId: m[1], taskType: m[2] } : null;
}

function credentials() {
  const key = process.env.TRELLO_KEY;
  const token = process.env.TRELLO_TOKEN;
  if (!key || !token) {
    const err = new Error('Trello is not configured. Set TRELLO_KEY and TRELLO_TOKEN.');
    err.code = 'no-trello';
    err.status = 503;
    throw err;
  }
  return { key, token };
}

export function isConfigured() {
  return !!(process.env.TRELLO_KEY && process.env.TRELLO_TOKEN);
}

async function call(path, { method = 'GET', params = {}, body } = {}) {
  const { key, token } = credentials();
  const url = new URL(API + path);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  });
  url.searchParams.set('key', key);
  url.searchParams.set('token', token);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      signal: controller.signal,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`Trello ${method} ${path} responded ${res.status}: ${text.slice(0, 160)}`);
      err.status = res.status === 401 ? 401 : 502;
      err.code = res.status === 401 ? 'trello-unauthorised' : 'trello-failed';
      throw err;
    }
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------- reading -- */

export async function listBoards() {
  const boards = await call('/members/me/boards', {
    params: { filter: 'open', fields: 'name,url' }
  });
  return (boards || []).map((b) => ({ id: b.id, name: b.name, url: b.url }));
}

export async function listLists(boardId) {
  const lists = await call(`/boards/${encodeURIComponent(boardId)}/lists`, {
    params: { filter: 'open', fields: 'name' }
  });
  return (lists || []).map((l) => ({ id: l.id, name: l.name }));
}

export async function openCards(listId) {
  const cards = await call(`/lists/${encodeURIComponent(listId)}/cards`, {
    params: { filter: 'open', fields: 'name,desc,due,dueComplete' }
  });
  return cards || [];
}

/* ------------------------------------------------------------- writing -- */

export async function createCard({ listId, name, desc, due }) {
  return call('/cards', {
    method: 'POST',
    params: { idList: listId, name, desc, due: due || undefined, pos: 'top' }
  });
}

export async function archiveCard(cardId) {
  return call(`/cards/${encodeURIComponent(cardId)}`, {
    method: 'PUT',
    params: { closed: 'true' }
  });
}

/* --------------------------------------------------------- card content -- */

const STRINGS = {
  water:     { en: 'Water',   ja: '水やり',   es: 'Regar' },
  fertilise: { en: 'Feed',    ja: '肥料',     es: 'Abonar' },
  prune:     { en: 'Prune',   ja: '剪定',     es: 'Podar' },
  repot:     { en: 'Repot',   ja: '植え替え', es: 'Trasplantar' }
};

const FOOTER = {
  en: 'From the balcony inventory at shinyashimada.com. Tick this card off and the plant is logged as done on the next sync.',
  ja: 'shinyashimada.com のベランダ記録より。このカードを完了にすると、次回の同期で植物の記録に反映されます。',
  es: 'Del inventario del balcón en shinyashimada.com. Marca la tarjeta como completada y se registrará en la planta en la próxima sincronización.'
};

const OVERDUE = {
  en: (n) => (n === 1 ? '1 day late' : `${n} days late`),
  ja: (n) => `${n}日遅れ`,
  es: (n) => (n === 1 ? '1 día de retraso' : `${n} días de retraso`)
};

const EMOJI = { water: '💧', fertilise: '🌱', prune: '✂️', repot: '🪴' };

export function cardFor(task, lang = 'en') {
  const l = STRINGS[task.taskType] ? lang : 'en';
  const action = (STRINGS[task.taskType] || STRINGS.water)[l] || STRINGS.water.en;
  const late = task.daysLate > 0 ? ` · ${(OVERDUE[l] || OVERDUE.en)(task.daysLate)}` : '';

  const parts = [
    task.location ? `📍 ${task.location}` : null,
    task.species ? `🪴 ${task.species}` : null,
    task.tip ? `\n${task.tip}` : null,
    `\n---\n${FOOTER[l] || FOOTER.en}`,
    markerFor(task.plantId, task.taskType)
  ].filter(Boolean);

  return {
    name: `${EMOJI[task.taskType] || '•'} ${action} — ${task.plantName}${late}`,
    desc: parts.join('\n'),
    due: task.dueISO || undefined
  };
}
