/* ==========================================================================
   /api/trello — configure and run the balcony → Trello sync.

     GET  ?action=status            -> { configured, database, settings }
     GET  ?action=boards            -> boards this token can see
     GET  ?action=lists&board=<id>  -> lists on a board
     POST { action: 'settings', settings }
     POST { action: 'sync' }        -> run a sync now
     POST { action: 'preview' }     -> what a sync would do, writing nothing

   This endpoint is ALWAYS passcode-gated, even though the rest of the site
   works with SITE_PASSCODE unset. The store holds our own plant notes; this
   reaches into somebody's Trello account, where a token can see every board
   they have. Refusing to run without a passcode is the safe default, not an
   inconvenience — so it returns 503 rather than quietly operating in the open.
   ========================================================================== */

import { getPool, ensureSchema, secretsMatch, json } from '../lib/db.mjs';
import { isConfigured, listBoards, listLists } from '../lib/trello.mjs';
import { readSettings, writeSettings, syncBalconyToTrello } from '../lib/balcony.mjs';

function authorised(req) {
  const expected = process.env.SITE_PASSCODE;
  if (!expected) return { ok: false, reason: 'no-passcode' };
  return secretsMatch(req.headers.get('x-store-passcode'), expected)
    ? { ok: true }
    : { ok: false, reason: 'unauthorized' };
}

export default async function handler(req) {
  const url = new URL(req.url);

  const auth = authorised(req);
  if (!auth.ok) {
    return auth.reason === 'no-passcode'
      ? json({
          error: 'Set SITE_PASSCODE before enabling Trello sync — this endpoint reaches a Trello account and will not run unprotected.',
          code: 'passcode-required'
        }, 503)
      : json({ error: 'Passcode required.', code: 'unauthorized' }, 401);
  }

  if (!isConfigured()) {
    return json({
      error: 'Trello is not configured. Set TRELLO_KEY and TRELLO_TOKEN.',
      code: 'no-trello'
    }, 503);
  }

  const db = getPool();
  if (!db) return json({ error: 'Cloud sync is not configured.', code: 'no-database' }, 503);
  try {
    await ensureSchema(db);
  } catch (err) {
    console.error('[trello] schema init failed', err);
    return json({ error: 'Database is unavailable.', code: 'schema-failed' }, 503);
  }

  try {
    if (req.method === 'GET') {
      const action = url.searchParams.get('action') || 'status';

      if (action === 'status') {
        return json({ ok: true, configured: true, database: true, settings: await readSettings(db) });
      }
      if (action === 'boards') {
        return json({ ok: true, boards: await listBoards() });
      }
      if (action === 'lists') {
        const board = url.searchParams.get('board');
        if (!board) return json({ error: 'A `board` is required.', code: 'bad-board' }, 400);
        return json({ ok: true, lists: await listLists(board) });
      }
      return json({ error: 'Unknown action.', code: 'bad-action' }, 400);
    }

    if (req.method === 'POST') {
      let body;
      try { body = await req.json(); } catch { return json({ error: 'Body must be JSON.' }, 400); }

      if (body?.action === 'settings') {
        const incoming = body.settings || {};
        const saved = await writeSettings(db, {
          enabled: !!incoming.enabled,
          boardId: incoming.boardId || null,
          listId: incoming.listId || null,
          lang: ['en', 'ja', 'es'].includes(incoming.lang) ? incoming.lang : 'en'
        });
        return json({ ok: true, settings: saved });
      }

      if (body?.action === 'sync' || body?.action === 'preview') {
        const settings = await readSettings(db);
        const listId = body.listId || settings.listId;
        const result = await syncBalconyToTrello(db, {
          listId,
          lang: settings.lang || 'en',
          dryRun: body.action === 'preview'
        });
        return json({ ok: true, result });
      }

      return json({ error: 'Unknown action.', code: 'bad-action' }, 400);
    }

    return json({ error: 'Method not allowed.' }, 405, { Allow: 'GET, POST' });
  } catch (err) {
    console.error('[trello] request failed', err);
    return json(
      { error: err.message || 'Trello request failed.', code: err.code || 'trello-failed' },
      err.status || 500
    );
  }
}
