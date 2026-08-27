/* ==========================================================================
   plants-camera.js — the live balcony camera on the inventory page.

   Click-to-start, deliberately. Auto-playing a live stream on every visit
   spends Shin's mobile data and holds the home tunnel open for a page she
   may have opened to check watering. Stopping actually tears the stream
   down — the iframe is emptied, not just hidden.

   The card stays out of the way entirely unless a camera is configured and
   this device holds the passcode: an error box about an unconfigured camera
   would be noise on every other visit.
   ========================================================================== */

(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var CONNECT_TIMEOUT_MS = 15000;

  var config = null;
  var timer = null;

  I18N.extend({
    'cam.title':   { en: 'The balcony, live', ja: 'ベランダ・ライブ', es: 'El balcón, en directo' },
    'cam.watch':   { en: 'Watch live', ja: 'ライブを見る', es: 'Ver en directo' },
    'cam.stop':    { en: 'Stop', ja: '停止', es: 'Detener' },
    'cam.idle': {
      en: 'The stream only runs while you are watching, so it does not sit in the background using data.',
      ja: '見ている間だけ配信します。バックグラウンドで通信し続けることはありません。',
      es: 'La transmisión solo funciona mientras la ves, así que no consume datos de fondo.'
    },
    'cam.connecting': { en: 'Connecting to the camera…', ja: 'カメラに接続中…', es: 'Conectando con la cámara…' },
    'cam.offline': {
      en: 'No answer from the camera. The computer at home relays the stream, so this usually means it is asleep or off the network.',
      ja: 'カメラから応答がありません。自宅のパソコンが中継しているため、スリープ中かネットワークから外れている可能性があります。',
      es: 'La cámara no responde. El ordenador de casa retransmite la señal, así que suele estar apagado o fuera de la red.'
    },
    'cam.retry': { en: 'Try again', ja: '再試行', es: 'Reintentar' }
  });

  I18N.apply();

  function setState(state) {
    $('camera').setAttribute('data-state', state);
  }

  function clearStage() {
    var stage = $('cam-stage');
    stage.querySelectorAll('iframe, video').forEach(function (n) {
      // Blanking the source is what actually ends the stream; removing the
      // node alone can leave the connection open until GC.
      if (n.tagName === 'IFRAME') n.src = 'about:blank';
      if (n.tagName === 'VIDEO') { n.pause(); n.removeAttribute('src'); n.load(); }
      n.remove();
    });
    if (timer) { clearTimeout(timer); timer = null; }
  }

  function showPlaceholder(messageKey, buttonKey) {
    $('cam-placeholder').hidden = false;
    $('cam-message').textContent = I18N.t(messageKey);
    var btn = $('cam-start');
    btn.hidden = !buttonKey;
    if (buttonKey) btn.textContent = I18N.t(buttonKey);
    $('cam-stop').hidden = true;
  }

  function stop() {
    clearStage();
    setState('idle');
    showPlaceholder('cam.idle', 'cam.watch');
  }

  /**
   * Is the relay actually answering?
   *
   * A cross-origin iframe fires `load` even when the navigation failed, so
   * the load event alone would report a dead relay as live. A no-cors fetch
   * cannot read the response, but it does settle differently for "host
   * answered" and "host unreachable", which is the only distinction needed.
   */
  function probe() {
    return fetch(config.url, { mode: 'no-cors', cache: 'no-store' })
      .then(function () { return true; })
      .catch(function () { return false; });
  }

  function start() {
    if (!config || !config.url) return;
    clearStage();
    setState('connecting');
    showPlaceholder('cam.connecting', null);
    $('cam-stop').hidden = false;

    probe().then(function (reachable) {
      if (!reachable) { offline(); return; }
      if ($('camera').getAttribute('data-state') === 'connecting') embed();
    });
  }

  function embed() {
    var stage = $('cam-stage');
    var node;

    if (config.mode === 'hls') {
      node = document.createElement('video');
      node.src = config.url;
      node.autoplay = true;
      node.muted = true;              // required for autoplay on mobile
      node.playsInline = true;
      node.controls = true;
      node.addEventListener('loadeddata', live);
      node.addEventListener('error', offline);
    } else {
      node = document.createElement('iframe');
      node.setAttribute('allow', 'autoplay; fullscreen');
      node.setAttribute('referrerpolicy', 'no-referrer');
      // The relay is the user's own machine, but there is no reason to hand
      // the framed page any more authority than it needs.
      node.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      node.src = config.url;
      node.addEventListener('load', live);
      node.addEventListener('error', offline);
    }

    stage.appendChild(node);

    // An iframe pointing at a dead host can sit there indefinitely without
    // firing either event, so time it out rather than spin forever.
    timer = setTimeout(offline, CONNECT_TIMEOUT_MS);
  }

  function live() {
    if (timer) { clearTimeout(timer); timer = null; }
    setState('live');
    $('cam-placeholder').hidden = true;
    $('cam-stop').hidden = false;
  }

  function offline() {
    clearStage();
    setState('offline');
    showPlaceholder('cam.offline', 'cam.retry');
  }

  function paintTitle() {
    $('cam-title').textContent = (config && config.label) || I18N.t('cam.title');
  }

  /* ----------------------------------------------------------------- boot -- */

  function load() {
    var headers = {};
    var code = Store.auth.get();
    if (code) headers['X-Store-Passcode'] = code;

    // Bounded: a config request that never settles would leave the card
    // permanently undecided, and this is a nicety on a page whose real job
    // is the watering schedule.
    var abort = new AbortController();
    var giveUp = setTimeout(function () { abort.abort(); }, 8000);

    fetch('/api/camera', { headers: headers, signal: abort.signal })
      .then(function (res) { clearTimeout(giveUp); return res.ok ? res.json() : null; })
      .then(function (payload) {
        // Not configured, or this device is not unlocked: show nothing at all.
        if (!payload || !payload.ok || !payload.url) return;
        config = payload;
        paintTitle();
        $('camera').classList.remove('hidden');
        stop();
      })
      .catch(function () {
        clearTimeout(giveUp);
        /* the inventory is the point; the camera is a bonus */
      });
  }

  $('cam-start').addEventListener('click', function () {
    if ($('camera').getAttribute('data-state') === 'offline') start();
    else start();
  });
  $('cam-stop').addEventListener('click', stop);

  // Reclaim the stream when the tab is hidden — nobody is watching.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && $('camera').getAttribute('data-state') === 'live') stop();
  });

  document.addEventListener('langchange', function () {
    paintTitle();
    if ($('camera').getAttribute('data-state') === 'idle') showPlaceholder('cam.idle', 'cam.watch');
    if ($('camera').getAttribute('data-state') === 'offline') showPlaceholder('cam.offline', 'cam.retry');
  });

  load();
})();
