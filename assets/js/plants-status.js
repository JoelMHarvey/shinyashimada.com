/* ==========================================================================
   plants-status.js — what is actually switched on.

   The Trello panel and the camera card both hide themselves when they are not
   configured, which is right for a visitor and useless for the person setting
   the site up: nothing appears, and nothing says why. This row is the missing
   half — one chip per integration, naming what is missing and what to do
   about it.

   It only renders for someone holding the passcode. A visitor has no business
   reading the site's configuration state.
   ========================================================================== */

(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var esc = Shell.esc;

  I18N.extend({
    'st.cloud':   { en: 'Sync', ja: '同期', es: 'Sync' },
    'st.trello':  { en: 'Trello', ja: 'Trello', es: 'Trello' },
    'st.camera':  { en: 'Camera', ja: 'カメラ', es: 'Cámara' },

    'st.on':      { en: 'on', ja: 'オン', es: 'activo' },
    'st.ready':   { en: 'ready', ja: '準備完了', es: 'listo' },
    'st.off':     { en: 'off', ja: 'オフ', es: 'inactivo' },
    'st.missing': { en: 'not set up', ja: '未設定', es: 'sin configurar' },
    'st.local':   { en: 'this device', ja: 'この端末のみ', es: 'este dispositivo' },
    'st.problem': { en: 'problem', ja: '問題あり', es: 'problema' },

    'st.hint.trelloKeys': {
      en: 'Add TRELLO_KEY and TRELLO_TOKEN in Netlify, then redeploy.',
      ja: 'Netlify で TRELLO_KEY と TRELLO_TOKEN を設定し、再デプロイしてください。',
      es: 'Añade TRELLO_KEY y TRELLO_TOKEN en Netlify y vuelve a desplegar.'
    },
    'st.hint.trelloOff': {
      en: 'Configured, but the morning sync is switched off. Click to open.',
      ja: '設定済みですが、朝の自動同期はオフです。クリックして開きます。',
      es: 'Configurado, pero la sincronización matinal está desactivada. Haz clic para abrir.'
    },
    'st.hint.trelloOn': {
      en: 'Syncing each morning. Click to change the board or list.',
      ja: '毎朝同期しています。ボードやリストの変更はこちらから。',
      es: 'Sincroniza cada mañana. Haz clic para cambiar el tablero o la lista.'
    },
    'st.hint.cameraMissing': {
      en: 'Add CAMERA_STREAM_URL in Netlify once the home relay is running — see homelab/README.md.',
      ja: '自宅の中継サーバーを起動したら、Netlify で CAMERA_STREAM_URL を設定してください（homelab/README.md 参照）。',
      es: 'Añade CAMERA_STREAM_URL en Netlify cuando el relé de casa esté funcionando — ver homelab/README.md.'
    },
    'st.hint.cameraOn': {
      en: 'Configured. The live view is at the top of this page.',
      ja: '設定済みです。ライブ映像はこのページの上部にあります。',
      es: 'Configurado. La vista en directo está arriba en esta página.'
    },
    'st.hint.cloudOn': {
      en: 'Plants are saved to the database and shared between devices.',
      ja: '植物のデータはデータベースに保存され、端末間で共有されます。',
      es: 'Las plantas se guardan en la base de datos y se comparten entre dispositivos.'
    },
    'st.hint.cloudLocal': {
      en: 'Saving on this device only — nothing is reaching the database.',
      ja: 'この端末にのみ保存されています。データベースには保存されていません。',
      es: 'Guardando solo en este dispositivo; nada llega a la base de datos.'
    }
  });

  I18N.apply();

  function headers() {
    var h = {};
    var code = Store.auth.get();
    if (code) h['X-Store-Passcode'] = code;
    return h;
  }

  /** Resolve to the payload on success, or { code } on a handled refusal. */
  function probe(url) {
    var abort = new AbortController();
    var giveUp = setTimeout(function () { abort.abort(); }, 8000);
    return fetch(url, { headers: headers(), signal: abort.signal })
      .then(function (res) {
        clearTimeout(giveUp);
        return res.text().then(function (text) {
          var body = null;
          try { body = text ? JSON.parse(text) : null; } catch (e) { body = null; }
          return { status: res.status, body: body || {} };
        });
      })
      .catch(function () { clearTimeout(giveUp); return { status: 0, body: {} }; });
  }

  function chip(label, state, tone, hint) {
    return '<span class="chip ' + tone + '" title="' + esc(hint || '') + '">' +
      esc(label) + ' · ' + esc(state) + '</span>';
  }

  function render(results) {
    var out = [];

    // Sync deliberately has no chip here: the pill beside it already reports
    // cloud-versus-local, and saying it twice is noise. These chips exist for
    // the integrations that have no other indicator at all.

    // Trello
    var tr = results.trello;
    if (tr.status === 200) {
      var enabled = tr.body.settings && tr.body.settings.enabled && tr.body.settings.listId;
      out.push('<button type="button" class="chip ' + (enabled ? 'chip--green' : 'chip--sky') +
        '" id="st-trello" style="cursor:pointer;border:0" title="' +
        esc(I18N.t(enabled ? 'st.hint.trelloOn' : 'st.hint.trelloOff')) + '">' +
        esc(I18N.t('st.trello')) + ' · ' + esc(I18N.t(enabled ? 'st.on' : 'st.ready')) + '</button>');
    } else if (tr.body.code === 'no-trello') {
      out.push(chip(I18N.t('st.trello'), I18N.t('st.missing'), 'chip--gold', I18N.t('st.hint.trelloKeys')));
    } else if (tr.status !== 0) {
      out.push(chip(I18N.t('st.trello'), I18N.t('st.problem'), 'chip--danger', tr.body.error || ''));
    }

    // Camera
    var cam = results.camera;
    if (cam.status === 200) {
      out.push(chip(I18N.t('st.camera'), I18N.t('st.on'), 'chip--green', I18N.t('st.hint.cameraOn')));
    } else if (cam.body.code === 'no-camera') {
      out.push(chip(I18N.t('st.camera'), I18N.t('st.missing'), 'chip--gold', I18N.t('st.hint.cameraMissing')));
    } else if (cam.status !== 0) {
      out.push(chip(I18N.t('st.camera'), I18N.t('st.problem'), 'chip--danger', cam.body.error || ''));
    }

    $('integrations').innerHTML = out.join('');

    var trelloChip = $('st-trello');
    if (trelloChip) {
      trelloChip.addEventListener('click', function () {
        var open = $('open-trello');
        if (open) open.click();
      });
    }
  }

  function refresh() {
    Promise.all([
      probe('/api/store?health=1'),
      probe('/api/trello?action=status'),
      probe('/api/camera')
    ]).then(function (r) {
      render({ store: r[0], trello: r[1], camera: r[2] });
    });
  }

  function start() {
    // Configuration state is for whoever holds the passcode, not for visitors.
    probe('/api/store?health=1').then(function (res) {
      var authRequired = res.body && res.body.authRequired;
      if (authRequired && !Store.auth.has()) return;
      refresh();
    });
  }

  document.addEventListener('langchange', function () {
    if ($('integrations').innerHTML) refresh();
  });

  start();
})();
