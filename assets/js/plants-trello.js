/* ==========================================================================
   plants-trello.js — the Trello sync panel on the balcony page.

   The endpoint it talks to is always passcode-gated, even when the rest of
   the site is open, because a Trello token can see every board the account
   has. So the first thing this panel does is explain, in plain words, why it
   is unavailable — an unexplained disabled control is worse than none.
   ========================================================================== */

(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var esc = Shell.esc;

  var settings = null;
  var boards = [];

  I18N.extend({
    'tr.open':  { en: 'Trello sync…', ja: 'Trello 連携…', es: 'Sincronización con Trello…' },
    'tr.title': { en: 'Trello sync', ja: 'Trello 連携', es: 'Sincronización con Trello' },
    'tr.blurb': {
      en: 'Overdue balcony jobs become cards on a Trello list. Tick a card off there and the plant is logged as done here on the next sync.',
      ja: '期限を過ぎたお世話が Trello のリストにカードとして追加されます。カードを完了にすると、次回の同期でこちらの記録にも反映されます。',
      es: 'Las tareas atrasadas del balcón se convierten en tarjetas de Trello. Marca una como completada allí y aquí se registrará en la próxima sincronización.'
    },
    'tr.board':   { en: 'Board', ja: 'ボード', es: 'Tablero' },
    'tr.list':    { en: 'List for the cards', ja: 'カードを追加するリスト', es: 'Lista para las tarjetas' },
    'tr.lang':    { en: 'Write cards in', ja: 'カードの言語', es: 'Escribir tarjetas en' },
    'tr.enabled': { en: 'Sync automatically each morning', ja: '毎朝、自動で同期する', es: 'Sincronizar automáticamente cada mañana' },
    'tr.preview': { en: 'Preview', ja: 'プレビュー', es: 'Previsualizar' },
    'tr.syncNow': { en: 'Sync now', ja: '今すぐ同期', es: 'Sincronizar ahora' },
    'tr.choose':  { en: 'Choose…', ja: '選択…', es: 'Elegir…' },
    'tr.saved':   { en: 'Settings saved', ja: '設定を保存しました', es: 'Ajustes guardados' },
    'tr.needList':{ en: 'Choose a board and a list first.', ja: 'ボードとリストを選んでください。', es: 'Elige primero un tablero y una lista.' },

    'tr.err.passcode': {
      en: 'Set SITE_PASSCODE in Netlify first. This panel reaches a Trello account, so it will not run without one — then redeploy and unlock this page with the passcode.',
      ja: 'まず Netlify で SITE_PASSCODE を設定してください。Trello アカウントに接続するため、パスコードなしでは動作しません。設定後に再デプロイし、このページをパスコードで解除してください。',
      es: 'Configura SITE_PASSCODE en Netlify primero. Este panel accede a una cuenta de Trello y no funcionará sin él; luego vuelve a desplegar y desbloquea esta página.'
    },
    'tr.err.unauthorized': {
      en: 'This device does not have the passcode. Unlock the balcony page first.',
      ja: 'この端末にパスコードがありません。先にベランダのページを解除してください。',
      es: 'Este dispositivo no tiene el código. Desbloquea primero la página del balcón.'
    },
    'tr.err.noTrello': {
      en: 'Set TRELLO_KEY and TRELLO_TOKEN in Netlify, then redeploy. A read/write token is needed, because completed cards are archived.',
      ja: 'Netlify で TRELLO_KEY と TRELLO_TOKEN を設定し、再デプロイしてください。完了したカードをアーカイブするため、読み書き可能なトークンが必要です。',
      es: 'Configura TRELLO_KEY y TRELLO_TOKEN en Netlify y vuelve a desplegar. Hace falta un token de lectura/escritura para archivar las tarjetas completadas.'
    },
    'tr.err.noDatabase': {
      en: 'The plant database is not connected, so there is nothing to sync from.',
      ja: '植物のデータベースに接続されていないため、同期するデータがありません。',
      es: 'La base de datos de plantas no está conectada, así que no hay nada que sincronizar.'
    },

    'tr.res.created':   { en: '{n} cards created', ja: '{n}件のカードを作成', es: '{n} tarjetas creadas' },
    'tr.res.completed': { en: '{n} completed cards logged', ja: '{n}件の完了カードを記録', es: '{n} tarjetas completadas registradas' },
    'tr.res.skipped':   { en: '{n} already had a card', ja: '{n}件はすでにカードあり', es: '{n} ya tenían tarjeta' },
    'tr.res.nothing':   { en: 'Nothing to do — the balcony is up to date.', ja: '対応が必要な項目はありません。', es: 'Nada que hacer: el balcón está al día.' },
    'tr.res.preview':   { en: 'Preview only — nothing was written to Trello.', ja: 'プレビューのみ — Trello には書き込んでいません。', es: 'Solo vista previa: no se escribió nada en Trello.' },
    'tr.res.errors':    { en: '{n} problems — see below', ja: '{n}件の問題', es: '{n} problemas' }
  });

  /* This file loads after plants.js has already run Shell.init(), so the
     strings above missed that first I18N.apply(). Paint them now; later
     language switches re-apply the whole document on their own. */
  I18N.apply();

  /* ---------------------------------------------------------------- api -- */

  function api(method, path, body) {
    var headers = { 'Content-Type': 'application/json' };
    var code = Store.auth.get();
    if (code) headers['X-Store-Passcode'] = code;

    return fetch('/api/trello' + (path || ''), {
      method: method,
      headers: headers,
      body: body ? JSON.stringify(body) : undefined
    }).then(function (res) {
      return res.text().then(function (text) {
        var payload = null;
        try { payload = text ? JSON.parse(text) : null; } catch (e) { payload = null; }
        if (!res.ok) {
          var err = new Error((payload && payload.error) || ('HTTP ' + res.status));
          err.status = res.status;
          err.code = payload && payload.code;
          throw err;
        }
        return payload || {};
      });
    });
  }

  /* ------------------------------------------------------------ rendering -- */

  function showProblem(err) {
    var key = err.code === 'passcode-required' ? 'tr.err.passcode'
      : err.code === 'unauthorized' ? 'tr.err.unauthorized'
      : err.code === 'no-trello' ? 'tr.err.noTrello'
      : err.code === 'no-database' ? 'tr.err.noDatabase'
      : null;

    $('tr-form').hidden = true;
    $('tr-status').innerHTML =
      '<div class="notice notice--danger"><span class="notice__icon">⚠️</span><div>' +
      esc(key ? I18N.t(key) : (err.message || I18N.t('common.error'))) +
      '</div></div>';
  }

  function fillSelect(el, items, selected, placeholder) {
    el.innerHTML = '<option value="">' + esc(placeholder) + '</option>' +
      items.map(function (i) {
        return '<option value="' + esc(i.id) + '">' + esc(i.name) + '</option>';
      }).join('');
    el.value = selected || '';
  }

  function loadLists(boardId, selectedList) {
    if (!boardId) { fillSelect($('tr-list'), [], '', I18N.t('tr.choose')); return Promise.resolve(); }
    return api('GET', '?action=lists&board=' + encodeURIComponent(boardId))
      .then(function (p) { fillSelect($('tr-list'), p.lists || [], selectedList, I18N.t('tr.choose')); })
      .catch(showProblem);
  }

  function renderResult(result, wasPreview) {
    var host = $('tr-result');
    if (!result) { host.innerHTML = ''; return; }

    var bits = [];
    if (result.created.length) bits.push(I18N.t('tr.res.created', { n: result.created.length }));
    if (result.completed.length) bits.push(I18N.t('tr.res.completed', { n: result.completed.length }));
    if (result.skipped) bits.push(I18N.t('tr.res.skipped', { n: result.skipped }));
    if (!bits.length) bits.push(I18N.t('tr.res.nothing'));
    if (wasPreview) bits.push(I18N.t('tr.res.preview'));

    var tone = result.errors && result.errors.length ? 'notice--danger' : 'notice--green';
    host.innerHTML =
      '<div class="notice ' + tone + '"><span class="notice__icon">' +
      (result.errors && result.errors.length ? '⚠️' : '✓') + '</span><div>' +
      esc(bits.join(' · ')) +
      (result.created.length
        ? '<br><span class="tiny muted">' + result.created.slice(0, 6).map(function (c) {
            return esc(c.name);
          }).join('<br>') + '</span>'
        : '') +
      (result.errors && result.errors.length
        ? '<br><span class="tiny">' + esc(result.errors.map(function (e) { return e.message; }).join(' · ')) + '</span>'
        : '') +
      '</div></div>';
  }

  function open() {
    $('tr-result').innerHTML = '';
    $('tr-status').innerHTML = '<div class="center" style="padding:1rem"><span class="spinner"></span></div>';
    $('tr-form').hidden = true;
    $('trello').showModal();

    api('GET', '?action=status')
      .then(function (p) {
        settings = p.settings || {};
        return api('GET', '?action=boards');
      })
      .then(function (p) {
        boards = p.boards || [];
        $('tr-status').innerHTML = '';
        $('tr-form').hidden = false;
        fillSelect($('tr-board'), boards, settings.boardId, I18N.t('tr.choose'));
        $('tr-lang').value = settings.lang || I18N.lang;
        $('tr-enabled').checked = !!settings.enabled;
        return loadLists(settings.boardId, settings.listId);
      })
      .catch(showProblem);
  }

  function currentSettings() {
    return {
      enabled: $('tr-enabled').checked,
      boardId: $('tr-board').value || null,
      listId: $('tr-list').value || null,
      lang: $('tr-lang').value
    };
  }

  function save() {
    var next = currentSettings();
    if (next.enabled && !next.listId) { Shell.toast(I18N.t('tr.needList'), 'error'); return Promise.resolve(false); }
    return api('POST', '', { action: 'settings', settings: next })
      .then(function (p) {
        settings = p.settings;
        Shell.toast(I18N.t('tr.saved'));
        return true;
      })
      .catch(function (err) { showProblem(err); return false; });
  }

  function run(action) {
    var next = currentSettings();
    if (!next.listId) { Shell.toast(I18N.t('tr.needList'), 'error'); return; }

    $('tr-result').innerHTML = '<div class="center" style="padding:.6rem"><span class="spinner"></span></div>';
    // Save first, so a sync always uses what is on screen.
    save().then(function (ok) {
      if (!ok) return;
      return api('POST', '', { action: action, listId: next.listId })
        .then(function (p) { renderResult(p.result, action === 'preview'); })
        .catch(showProblem);
    });
  }

  /* ----------------------------------------------------------------- boot -- */

  var trigger = $('open-trello');
  if (!trigger) return;

  trigger.addEventListener('click', function () {
    var menu = $('datamenu');
    if (menu && menu.open) menu.close();
    open();
  });

  $('trello').querySelectorAll('[data-close]').forEach(function (btn) {
    btn.addEventListener('click', function () { $('trello').close(); });
  });
  $('trello').addEventListener('click', function (e) {
    if (e.target === $('trello')) $('trello').close();
  });

  $('tr-board').addEventListener('change', function () { loadLists($('tr-board').value, null); });
  $('tr-save').addEventListener('click', function () { save(); });
  $('tr-preview').addEventListener('click', function () { run('preview'); });
  $('tr-sync').addEventListener('click', function () { run('sync'); });

})();
