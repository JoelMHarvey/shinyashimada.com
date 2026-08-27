/* ==========================================================================
   Scheduled daily sync: overdue balcony tasks -> Trello, and completed
   Trello cards -> the plant's care log.

   Runs at 21:00 UTC, which is 06:00 in Tokyo — so the cards are waiting
   before anyone goes out to the balcony.

   The work is idempotent (a task already holding an open card is skipped),
   so a duplicate invocation costs nothing. It does nothing at all unless the
   sync has been switched on and a list chosen on the site.
   ========================================================================== */

import { getPool, ensureSchema } from '../lib/db.mjs';
import { isConfigured } from '../lib/trello.mjs';
import { readSettings, syncBalconyToTrello } from '../lib/balcony.mjs';

export const config = { schedule: '0 21 * * *' };

export default async function handler() {
  if (!isConfigured()) {
    console.log('[trello-sync] skipped: TRELLO_KEY/TRELLO_TOKEN not set');
    return new Response('trello not configured', { status: 200 });
  }

  const db = getPool();
  if (!db) {
    console.log('[trello-sync] skipped: DATABASE_URL not set');
    return new Response('no database', { status: 200 });
  }

  try {
    await ensureSchema(db);
    const settings = await readSettings(db);

    if (!settings.enabled || !settings.listId) {
      console.log('[trello-sync] skipped: sync disabled or no list selected');
      return new Response('disabled', { status: 200 });
    }

    const result = await syncBalconyToTrello(db, {
      listId: settings.listId,
      lang: settings.lang || 'en'
    });

    console.log('[trello-sync]', JSON.stringify({
      due: result.due,
      created: result.created.length,
      completed: result.completed.length,
      skipped: result.skipped,
      errors: result.errors.length
    }));

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    console.error('[trello-sync] failed', err);
    return new Response('sync failed', { status: 500 });
  }
}
