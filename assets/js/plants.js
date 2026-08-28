/* ==========================================================================
   plants.js — the balcony inventory.

   Care scheduling lives in one place (the "care model" section) so the
   dashboard, the cards and the detail view can never disagree about when a
   plant is due. Watering intervals come from the species table, vary by Tokyo
   season, and are nudged by the live forecast; pruning and repotting are
   window-based, because you prune a hydrangea in July or not at all.
   ========================================================================== */

(function () {
  'use strict';

  var species = [];
  var speciesById = Object.create(null);
  var store = Store.open('plants');
  var forecast = null;
  var filterCategory = 'all';
  var editingId = null;

  var $ = function (id) { return document.getElementById(id); };
  var esc = Shell.esc;

  /* ====================================================================== */
  /*  Strings                                                               */
  /* ====================================================================== */

  I18N.extend({
    'pl.title':   { en: 'The Balcony — Shinya Shimada', ja: 'ベランダ — 島田 慎也', es: 'El Balcón — Shinya Shimada' },
    'pl.eyebrow': { en: 'Plant inventory', ja: '植物インベントリ', es: 'Inventario de plantas' },
    'pl.heading': { en: 'The Balcony', ja: 'ベランダ', es: 'El Balcón' },
    'pl.lede': {
      en: 'Every pot out there, what it wants, and when it last got it.',
      ja: 'ベランダのすべての鉢と、その世話の記録。',
      es: 'Cada maceta de ahí fuera, lo que necesita y cuándo lo recibió.'
    },

    'pl.lock.title':    { en: 'Private garden', ja: 'プライベートな庭', es: 'Jardín privado' },
    'pl.lock.body': {
      en: 'The plant records sync between devices, so they sit behind a passcode.',
      ja: '植物の記録は端末間で同期されるため、パスコードで保護されています。',
      es: 'Los registros se sincronizan entre dispositivos, así que están tras un código.'
    },
    'pl.lock.passcode': { en: 'Passcode', ja: 'パスコード', es: 'Código' },
    'pl.lock.unlock':   { en: 'Unlock', ja: 'ロック解除', es: 'Desbloquear' },
    'pl.lock.offline':  { en: 'Use this device only, without syncing', ja: 'この端末だけで使う（同期しない）', es: 'Usar solo en este dispositivo, sin sincronizar' },
    'pl.lock.wrong':    { en: 'That passcode was not accepted.', ja: 'パスコードが正しくありません。', es: 'Ese código no se aceptó.' },

    'pl.sync.cloud':   { en: 'Synced', ja: '同期済み', es: 'Sincronizado' },
    'pl.sync.local':   { en: 'This device only', ja: 'この端末のみ', es: 'Solo este dispositivo' },
    'pl.sync.syncing': { en: 'Syncing…', ja: '同期中…', es: 'Sincronizando…' },
    'pl.sync.pending': { en: '{n} waiting to sync', ja: '{n} 件が同期待ち', es: '{n} pendientes de sincronizar' },

    'pl.season.spring': { en: 'Spring', ja: '春', es: 'Primavera' },
    'pl.season.rainy':  { en: 'Rainy season', ja: '梅雨', es: 'Temporada de lluvias' },
    'pl.season.summer': { en: 'Summer', ja: '夏', es: 'Verano' },
    'pl.season.autumn': { en: 'Autumn', ja: '秋', es: 'Otoño' },
    'pl.season.winter': { en: 'Winter', ja: '冬', es: 'Invierno' },

    'pl.stat.total':   { en: 'Plants', ja: '株数', es: 'Plantas' },
    'pl.stat.overdue': { en: 'Overdue', ja: '期限切れ', es: 'Atrasadas' },
    'pl.stat.today':   { en: 'Due today', ja: '今日やること', es: 'Para hoy' },
    'pl.stat.week':    { en: 'Next 7 days', ja: '今後7日', es: 'Próximos 7 días' },

    'pl.attention.title': { en: 'Needs attention', ja: 'お世話が必要', es: 'Necesita atención' },
    'pl.attention.none':  { en: 'Nothing needs doing', ja: '今のところ何もありません', es: 'Nada pendiente' },
    'pl.attention.noneBody': {
      en: 'Everything on the balcony is watered, fed and in season. Check back tomorrow.',
      ja: 'ベランダの植物はすべて水やり・肥料ともに問題ありません。また明日。',
      es: 'Todo está regado, abonado y en su momento. Vuelve mañana.'
    },

    'pl.all.title': { en: 'All plants', ja: 'すべての植物', es: 'Todas las plantas' },
    'pl.add':       { en: '+ Add plant', ja: '+ 植物を追加', es: '+ Añadir planta' },
    'pl.more':      { en: 'Data', ja: 'データ', es: 'Datos' },

    'pl.empty.title': { en: 'No plants yet', ja: 'まだ植物がありません', es: 'Aún no hay plantas' },
    'pl.empty.body': {
      en: 'Add the first pot and the watering schedule builds itself from there.',
      ja: '最初の鉢を追加すると、水やりの予定が自動で作られます。',
      es: 'Añade la primera maceta y el calendario de riego se construye solo.'
    },

    'pl.care.water':     { en: 'Water',    ja: '水やり', es: 'Regar' },
    'pl.care.fertilise': { en: 'Feed',     ja: '肥料',   es: 'Abonar' },
    'pl.care.prune':     { en: 'Prune',    ja: '剪定',   es: 'Podar' },
    'pl.care.repot':     { en: 'Repot',    ja: '植え替え', es: 'Trasplantar' },

    'pl.did.water':     { en: 'Watered',    ja: '水やり完了',   es: 'Regada' },
    'pl.did.fertilise': { en: 'Fed',        ja: '肥料をあげた', es: 'Abonada' },
    'pl.did.prune':     { en: 'Pruned',     ja: '剪定した',     es: 'Podada' },
    'pl.did.repot':     { en: 'Repotted',   ja: '植え替えた',   es: 'Trasplantada' },

    'pl.when.overdue':  { en: '{n} days late', ja: '{n}日遅れ', es: '{n} días de retraso' },
    'pl.when.overdue1': { en: '1 day late',    ja: '1日遅れ',   es: '1 día de retraso' },
    'pl.when.today':    { en: 'Today',         ja: '今日',      es: 'Hoy' },
    'pl.when.never':    { en: 'Never recorded', ja: '記録なし',  es: 'Sin registro' },
    'pl.when.resting':  { en: 'Resting — no feed this season', ja: '休眠中 — 今季は肥料不要', es: 'En reposo — sin abono esta temporada' },
    'pl.when.notNeeded':{ en: 'Not needed', ja: '不要', es: 'No necesario' },
    'pl.when.last':     { en: 'Last: {d}', ja: '前回: {d}', es: 'Última vez: {d}' },
    'pl.when.next':     { en: 'Next: {d}', ja: '次回: {d}', es: 'Próxima: {d}' },
    'pl.mark':          { en: 'Done', ja: '完了', es: 'Hecho' },

    'pl.f.species':       { en: 'Species', ja: '種類', es: 'Especie' },
    'pl.f.customSpecies': { en: 'Species name', ja: '種類の名前', es: 'Nombre de la especie' },
    'pl.f.other':         { en: 'Something else…', ja: 'その他…', es: 'Otra…' },
    'pl.f.nickname':      { en: 'Name for this plant', ja: 'この株の呼び名', es: 'Nombre de esta planta' },
    'pl.f.nicknamePh':    { en: 'e.g. the big one by the door', ja: '例：ドアのそばの大きいの', es: 'p. ej. la grande junto a la puerta' },
    'pl.f.location':      { en: 'Where it lives', ja: '置き場所', es: 'Dónde está' },
    'pl.f.locationPh':    { en: 'e.g. south rail', ja: '例：南側の手すり', es: 'p. ej. baranda sur' },
    'pl.f.pot':           { en: 'Pot size (cm)', ja: '鉢のサイズ（cm）', es: 'Maceta (cm)' },
    'pl.f.acquired':      { en: 'Arrived on', ja: 'お迎えした日', es: 'Llegó el' },
    'pl.f.waterEvery':    { en: 'Water every (days)', ja: '水やり間隔（日）', es: 'Regar cada (días)' },
    'pl.f.auto':          { en: 'Automatic', ja: '自動', es: 'Automático' },
    'pl.f.notes':         { en: 'Notes', ja: 'メモ', es: 'Notas' },
    'pl.f.hintAuto': {
      en: 'Leave the watering interval blank to follow the species guide, which changes with the season.',
      ja: '水やり間隔を空欄にすると、季節に応じた種類ごとの目安に従います。',
      es: 'Deja el riego en blanco para seguir la guía de la especie, que cambia con la estación.'
    },

    'pl.f.photo':       { en: 'Photo', ja: '写真', es: 'Foto' },
    'pl.f.photoAdd':    { en: 'Add photo', ja: '写真を追加', es: 'Añadir foto' },
    'pl.f.photoChange': { en: 'Change photo', ja: '写真を変更', es: 'Cambiar foto' },
    'pl.f.photoRemove': { en: 'Remove', ja: '削除', es: 'Quitar' },
    'pl.photoErr': {
      en: 'Could not read that photo — try a different one.',
      ja: '写真を読み込めませんでした。別の写真をお試しください。',
      es: 'No se pudo leer esa foto; prueba con otra.'
    },

    'pl.new':    { en: 'Add a plant', ja: '植物を追加', es: 'Añadir una planta' },
    'pl.editing':{ en: 'Edit plant', ja: '植物を編集', es: 'Editar planta' },
    'pl.confirmDelete': { en: 'Remove this plant and its whole history?', ja: 'この植物と履歴をすべて削除しますか？', es: '¿Eliminar esta planta y todo su historial?' },
    'pl.saved':  { en: 'Saved', ja: '保存しました', es: 'Guardado' },
    'pl.needName': { en: 'Give the plant a species or a name first.', ja: '種類か名前を入力してください。', es: 'Indica primero una especie o un nombre.' },

    'pl.detail.title':   { en: 'Plant', ja: '植物', es: 'Planta' },
    'pl.detail.history': { en: 'History', ja: '履歴', es: 'Historial' },
    'pl.detail.noHistory': { en: 'Nothing logged yet.', ja: 'まだ記録がありません。', es: 'Aún no hay registros.' },
    'pl.detail.sun':     { en: 'Light', ja: '日当たり', es: 'Luz' },
    'pl.detail.minTemp': { en: 'Hardy to', ja: '耐寒温度', es: 'Resiste hasta' },
    'pl.detail.arrived': { en: 'Arrived', ja: 'お迎え', es: 'Llegó' },
    'pl.detail.pot':     { en: 'Pot', ja: '鉢', es: 'Maceta' },

    'pl.sun.full-sun':        { en: 'Full sun', ja: '日なた', es: 'Pleno sol' },
    'pl.sun.part-sun':        { en: 'Part sun', ja: '半日陰', es: 'Sol parcial' },
    'pl.sun.bright-indirect': { en: 'Bright, indirect', ja: '明るい日陰', es: 'Luz indirecta' },
    'pl.sun.shade':           { en: 'Shade', ja: '日陰', es: 'Sombra' },

    'pl.cat.all':       { en: 'All', ja: 'すべて', es: 'Todas' },
    'pl.cat.foliage':   { en: 'Foliage', ja: '観葉', es: 'Follaje' },
    'pl.cat.flowering': { en: 'Flowering', ja: '花', es: 'Con flor' },
    'pl.cat.herb':      { en: 'Herbs', ja: 'ハーブ', es: 'Hierbas' },
    'pl.cat.succulent': { en: 'Succulents', ja: '多肉', es: 'Suculentas' },
    'pl.cat.fruit':     { en: 'Fruit & veg', ja: '実もの', es: 'Fruta' },
    'pl.cat.tree':      { en: 'Trees', ja: '樹木', es: 'Árboles' },
    'pl.cat.other':     { en: 'Other', ja: 'その他', es: 'Otras' },

    'pl.data.title':  { en: 'Data', ja: 'データ', es: 'Datos' },
    'pl.data.sync':   { en: 'Sync now', ja: '今すぐ同期', es: 'Sincronizar ahora' },
    'pl.data.export': { en: 'Download a backup', ja: 'バックアップをダウンロード', es: 'Descargar copia de seguridad' },
    'pl.data.import': { en: 'Restore from a backup…', ja: 'バックアップから復元…', es: 'Restaurar desde copia…' },
    'pl.data.lock':   { en: 'Forget passcode on this device', ja: 'この端末のパスコードを削除', es: 'Olvidar el código en este dispositivo' },
    'pl.data.importConfirm': { en: 'Replace all plants with the backup file?', ja: 'すべての植物をバックアップの内容に置き換えますか？', es: '¿Reemplazar todas las plantas con la copia?' },
    'pl.data.importBad':  { en: 'That file could not be read as a plant backup.', ja: 'このファイルは植物のバックアップとして読み込めません。', es: 'No se pudo leer ese archivo como copia de plantas.' },
    'pl.data.imported':   { en: 'Restored {n} plants', ja: '{n} 件を復元しました', es: 'Restauradas {n} plantas' },

    /* Weather advisories, shared with the Tokyo page */
    'adv.frost.title':  { en: 'Frost expected', ja: '霜のおそれ', es: 'Se esperan heladas' },
    'adv.frost.body':   { en: 'Down to {v}°C in the next three days. Move tender pots inside or against the wall.', ja: '今後3日で{v}℃まで下がります。寒さに弱い鉢は室内か壁際へ。', es: 'Hasta {v}°C en tres días. Mete las macetas delicadas o arrímalas a la pared.' },
    'adv.cold.title':   { en: 'Cold nights', ja: '冷え込み', es: 'Noches frías' },
    'adv.cold.body':    { en: 'Lows near {v}°C. Anything tropical will sulk outside.', ja: '最低気温は{v}℃前後。熱帯性の植物は屋外だと弱ります。', es: 'Mínimas de unos {v}°C. Lo tropical sufrirá fuera.' },
    'adv.heat.title':   { en: 'Heat', ja: '高温', es: 'Calor' },
    'adv.heat.body':    { en: 'Up to {v}°C. Water early, and shade small pots through the afternoon.', ja: '最高{v}℃。朝のうちに水やりを。小さな鉢は午後の日差しを避けて。', es: 'Hasta {v}°C. Riega temprano y da sombra a las macetas pequeñas.' },
    'adv.wind.title':   { en: 'Strong wind', ja: '強風', es: 'Viento fuerte' },
    'adv.wind.body':    { en: 'Gusting to {v} km/h. Lay tall pots down or tie them in.', ja: '最大{v}km/hの風。背の高い鉢は倒すか固定を。', es: 'Rachas de {v} km/h. Tumba o ata las macetas altas.' },
    'adv.heavyRain.title': { en: 'Heavy rain', ja: '大雨', es: 'Lluvia fuerte' },
    'adv.heavyRain.body':  { en: '{v}mm expected. Skip watering and check that pots drain.', ja: '{v}mmの雨予報。水やりは控え、鉢の水はけを確認して。', es: 'Se esperan {v} mm. No riegues y comprueba el drenaje.' },
    'adv.uv.title':     { en: 'Strong sun', ja: '強い日差し', es: 'Sol intenso' },
    'adv.uv.body':      { en: 'UV index {v}. Young leaves scorch fast at this level.', ja: 'UV指数{v}。新芽は葉焼けしやすい強さです。', es: 'Índice UV {v}. Las hojas nuevas se queman rápido.' },
    'adv.dry.title':    { en: 'Dry spell', ja: '乾燥', es: 'Racha seca' },
    'adv.dry.body':     { en: 'No rain for three days. Watering intervals have been shortened to match.', ja: '3日間雨の予報がありません。水やり間隔を短めに調整しています。', es: 'Sin lluvia en tres días. Los intervalos de riego se han acortado.' },
    'adv.fine.title':   { en: 'Good balcony weather', ja: 'ベランダ日和', es: 'Buen tiempo de balcón' },
    'adv.fine.body':    { en: 'Nothing to protect against today.', ja: '今日は特に対策の必要はありません。', es: 'Hoy no hay nada de lo que protegerse.' }
  });

  /* ====================================================================== */
  /*  Plant identity + the care schedule                                    */
  /* ====================================================================== */

  /* All scheduling lives in care.js, which is pure and unit-tested. This page
     only supplies the species table and the current weather nudge. */
  var care = Care.create({
    speciesById: speciesById,
    weatherFactor: function () { return weatherFactor(); }
  });
  var CARE_FIELD = Care.CARE_FIELD;

  function speciesOf(plant) {
    return plant.speciesId ? speciesById[plant.speciesId] || null : null;
  }

  function displayName(plant) {
    if (plant.name) return plant.name;
    var sp = speciesOf(plant);
    if (sp) return I18N.pick(sp.name);
    return plant.customSpecies || I18N.t('pl.cat.other');
  }

  function speciesLabel(plant) {
    var sp = speciesOf(plant);
    if (sp) return I18N.pick(sp.name) + (sp.botanical ? ' \u00b7 ' + sp.botanical : '');
    return plant.customSpecies || '';
  }

  function emojiOf(plant) {
    var sp = speciesOf(plant);
    return (sp && sp.emoji) || '\ud83e\udeb4';
  }

  function categoryOf(plant) {
    var sp = speciesOf(plant);
    return (sp && sp.category) || 'other';
  }

  /**
   * How the forecast bends the watering interval. A hot, dry run means pots
   * dry out faster than the species table assumes; a soaking means the
   * balcony has already been watered for us.
   */
  function weatherFactor() {
    if (!forecast || !forecast.advisories) return 1;
    var keys = forecast.advisories.map(function (a) { return a.key; });
    if (keys.indexOf('heavyRain') !== -1) return 1.4;
    if (keys.indexOf('heat') !== -1 || keys.indexOf('dry') !== -1) return 0.7;
    return 1;
  }

  function tasksFor(plant) { return care.tasksFor(plant); }
  function urgency(plant) { return care.urgency(plant); }

  /* ====================================================================== */
  /*  Rendering                                                             */
  /* ====================================================================== */

  function whenLabel(t) {
    if (t.state === 'resting') return I18N.t('pl.when.resting');
    if (t.never) return I18N.t('pl.when.never');
    if (t.days === 0) return I18N.t('pl.when.today');
    if (t.days < 0) {
      var n = Math.abs(t.days);
      return n === 1 ? I18N.t('pl.when.overdue1') : I18N.t('pl.when.overdue', { n: n });
    }
    return I18N.relativeDays(t.days);
  }

  function renderSeasonChip() {
    var s = Shell.tokyoSeason();
    $('season-chip').textContent = I18N.t('pl.season.' + s);
    $('season-chip').className = 'chip chip--green';
  }

  function renderSyncPill() {
    var st = store.status();
    var pill = $('sync-pill');
    var mode = st.syncing ? 'syncing' : st.mode;
    pill.setAttribute('data-mode', st.mode === 'cloud' ? 'cloud' : 'local');
    var text = st.syncing ? I18N.t('pl.sync.syncing')
      : st.mode === 'cloud' ? I18N.t('pl.sync.cloud')
      : I18N.t('pl.sync.local');
    if (!st.syncing && st.pending) text += ' · ' + I18N.t('pl.sync.pending', { n: st.pending });
    $('sync-text').textContent = text;
  }

  function renderAdvisories() {
    var host = $('advisories');
    host.innerHTML = '';
    if (!forecast || !forecast.advisories) return;

    forecast.advisories.slice(0, 3).forEach(function (a) {
      var tone = a.severity === 'high' ? 'notice--danger'
        : a.severity === 'none' ? 'notice--green' : '';
      var icons = { frost: '❄️', cold: '🌡️', heat: '🔥', wind: '💨', heavyRain: '🌧️', uv: '☀️', dry: '🏜️', fine: '🌤️' };
      var div = document.createElement('div');
      div.className = 'notice ' + tone;
      div.innerHTML =
        '<span class="notice__icon">' + (icons[a.key] || '•') + '</span>' +
        '<div><strong>' + esc(I18N.t('adv.' + a.key + '.title')) + '</strong><br>' +
        esc(I18N.t('adv.' + a.key + '.body', { v: a.value })) + '</div>';
      host.appendChild(div);
    });
  }

  function renderStats(plants) {
    var overdue = 0, today = 0, week = 0;
    plants.forEach(function (p) {
      tasksFor(p).forEach(function (t) {
        if (t.days === null) return;
        if (t.days < 0) overdue++;
        else if (t.days === 0) today++;
        else if (t.days <= 7) week++;
      });
    });

    var cells = [
      { label: 'pl.stat.total',   value: plants.length },
      { label: 'pl.stat.overdue', value: overdue, danger: overdue > 0 },
      { label: 'pl.stat.today',   value: today },
      { label: 'pl.stat.week',    value: week }
    ];

    $('stats').innerHTML = cells.map(function (c) {
      return '<div class="stat"><p class="stat__label">' + esc(I18N.t(c.label)) + '</p>' +
        '<p class="stat__value"' + (c.danger ? ' style="color:var(--danger)"' : '') + '>' + c.value + '</p></div>';
    }).join('');
  }

  function renderAttention(plants) {
    var host = $('attention');
    var rows = [];

    plants.forEach(function (p) {
      tasksFor(p).forEach(function (t) {
        if (t.days === null || t.days > 3) return;
        rows.push({ plant: p, task: t });
      });
    });

    rows.sort(function (a, b) { return a.task.days - b.task.days; });

    if (!rows.length) {
      host.innerHTML =
        '<div class="empty-state"><div class="empty-state__icon">🌤️</div>' +
        '<h3>' + esc(I18N.t('pl.attention.none')) + '</h3>' +
        '<p>' + esc(I18N.t('pl.attention.noneBody')) + '</p></div>';
      return;
    }

    host.innerHTML = '';
    rows.forEach(function (row) {
      var div = document.createElement('div');
      div.className = 'task-row';
      div.setAttribute('data-state', row.task.state);
      div.innerHTML =
        '<span class="task-row__emoji">' + emojiOf(row.plant) + '</span>' +
        '<span class="task-row__body">' +
          '<span class="task-row__name">' + esc(displayName(row.plant)) + '</span><br>' +
          '<span class="task-row__what">' + esc(I18N.t('pl.care.' + row.task.type)) +
            (row.plant.location ? ' · ' + esc(row.plant.location) : '') + '</span>' +
        '</span>' +
        '<span class="task-row__when" data-state="' + row.task.state + '">' + esc(whenLabel(row.task)) + '</span>';

      var btn = document.createElement('button');
      btn.className = 'btn btn--sm';
      btn.textContent = I18N.t('pl.mark');
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        logCare(row.plant, row.task.type);
      });
      div.appendChild(btn);

      div.addEventListener('click', function () { openDetail(row.plant.id); });
      host.appendChild(div);
    });
  }

  function renderFilters(plants) {
    var cats = ['all'];
    plants.forEach(function (p) {
      var c = categoryOf(p);
      if (cats.indexOf(c) === -1) cats.push(c);
    });
    if (cats.indexOf(filterCategory) === -1) filterCategory = 'all';

    var host = $('filter-category');
    host.innerHTML = '';
    cats.forEach(function (c) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = I18N.t('pl.cat.' + c);
      btn.setAttribute('aria-pressed', String(c === filterCategory));
      btn.addEventListener('click', function () {
        filterCategory = c;
        render();
      });
      host.appendChild(btn);
    });
    host.hidden = cats.length < 3;
  }

  function renderGrid(plants) {
    var host = $('plant-grid');
    var emptyHost = $('grid-empty');
    host.innerHTML = '';
    emptyHost.innerHTML = '';

    var shown = filterCategory === 'all'
      ? plants
      : plants.filter(function (p) { return categoryOf(p) === filterCategory; });

    if (!shown.length) {
      emptyHost.innerHTML =
        '<div class="empty-state"><div class="empty-state__icon">🪴</div>' +
        '<h3>' + esc(I18N.t('pl.empty.title')) + '</h3>' +
        '<p>' + esc(I18N.t('pl.empty.body')) + '</p></div>';
      return;
    }

    shown.sort(function (a, b) {
      var ua = urgency(a), ub = urgency(b);
      if (ua && !ub) return -1;
      if (ub && !ua) return 1;
      if (ua && ub && ua.days !== ub.days) return ua.days - ub.days;
      return displayName(a).localeCompare(displayName(b), I18N.locale());
    });

    shown.forEach(function (p) {
      var u = urgency(p);
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'plant-card';

      var nextLines = tasksFor(p)
        .filter(function (t) { return t.state !== 'resting'; })
        .slice(0, 3)
        .map(function (t) {
          return '<div><span>' + esc(I18N.t('pl.care.' + t.type)) + '</span>' +
                 '<span' + (t.days !== null && t.days <= 0 ? ' style="color:var(--terracotta);font-weight:600"' : '') + '>' +
                 esc(whenLabel(t)) + '</span></div>';
        }).join('');

      btn.innerHTML =
        (u ? '<span class="plant-card__flag" data-state="' + u.state + '"></span>' : '') +
        '<span class="plant-card__top">' +
          (p.photo
            ? '<img class="plant-card__photo" src="' + p.photo + '" alt="" loading="lazy">'
            : '<span class="plant-card__emoji">' + emojiOf(p) + '</span>') +
          '<span><span class="plant-card__name">' + esc(displayName(p)) + '</span><br>' +
          '<span class="plant-card__species">' + esc(speciesLabel(p)) + '</span></span>' +
        '</span>' +
        (p.location ? '<span class="plant-card__meta"><span class="chip">' + esc(p.location) + '</span></span>' : '') +
        '<span class="plant-card__next">' + nextLines + '</span>';

      btn.addEventListener('click', function () { openDetail(p.id); });
      host.appendChild(btn);
    });
  }

  function render() {
    var plants = store.items();
    renderSeasonChip();
    renderSyncPill();
    renderAdvisories();
    renderStats(plants);
    renderAttention(plants);
    renderFilters(plants);
    renderGrid(plants);
    renderLocations(plants);
  }

  function renderLocations(plants) {
    var seen = [];
    plants.forEach(function (p) {
      if (p.location && seen.indexOf(p.location) === -1) seen.push(p.location);
    });
    $('location-list').innerHTML = seen.map(function (l) {
      return '<option value="' + esc(l) + '">';
    }).join('');
  }

  /* ====================================================================== */
  /*  Actions                                                               */
  /* ====================================================================== */

  function logCare(plant, type, note) {
    var fresh = store.get(plant.id) || plant;
    var care = Object.assign({}, fresh.care || {});
    var stamp = new Date().toISOString();
    care[CARE_FIELD[type]] = stamp;

    var log = (fresh.log || []).slice(0, 200);
    log.unshift({ id: Shell.uid(), at: stamp, type: type, note: note || '' });

    store.put(Object.assign({}, fresh, { care: care, log: log }));
    Shell.toast(I18N.t('pl.did.' + type));
    if ($('detail').open) openDetail(plant.id);
  }

  function openDetail(id) {
    var p = store.get(id);
    if (!p || p.deleted) return;
    var sp = speciesOf(p);
    var body = $('detail-body');

    var facts = [];
    if (sp && sp.sun) facts.push([I18N.t('pl.detail.sun'), I18N.t('pl.sun.' + sp.sun)]);
    if (sp && typeof sp.minTemp === 'number') facts.push([I18N.t('pl.detail.minTemp'), sp.minTemp + '°C']);
    if (p.potSize) facts.push([I18N.t('pl.detail.pot'), p.potSize + ' cm']);
    if (p.acquired) facts.push([I18N.t('pl.detail.arrived'), I18N.formatDate(p.acquired)]);

    var careLines = tasksFor(p).map(function (t) {
      var lastRaw = p.care && p.care[CARE_FIELD[t.type]];
      var last = lastRaw ? I18N.t('pl.when.last', { d: I18N.formatDate(lastRaw) }) : I18N.t('pl.when.never');
      var next = t.state === 'resting' ? I18N.t('pl.when.resting') : whenLabel(t);
      return '<div class="care-line">' +
        '<span class="care-line__label">' + esc(I18N.t('pl.care.' + t.type)) + '</span>' +
        '<span class="care-line__info">' + esc(next) + ' · ' + esc(last) + '</span>' +
        '<button type="button" class="btn btn--sm btn--ghost" data-log="' + t.type + '">' +
          esc(I18N.t('pl.mark')) + '</button>' +
        '</div>';
    }).join('');

    var history = (p.log || []).slice(0, 40).map(function (e) {
      return '<li><time>' + esc(I18N.formatDate(e.at, { day: 'numeric', month: 'short' })) + '</time>' +
        '<span>' + esc(I18N.t('pl.did.' + e.type)) + '</span>' +
        (e.note ? '<span class="log-note">' + esc(e.note) + '</span>' : '') + '</li>';
    }).join('');

    body.innerHTML =
      (p.photo ? '<img class="detail__photo" src="' + p.photo + '" alt="">' : '') +
      '<div class="detail__head">' +
        '<span class="detail__emoji">' + emojiOf(p) + '</span>' +
        '<span class="detail__title"><h2 style="font-size:1.35rem">' + esc(displayName(p)) + '</h2>' +
        '<span class="muted small">' + esc(speciesLabel(p)) + '</span></span>' +
      '</div>' +
      (facts.length
        ? '<div class="flex gap-1 wrap-flex mb-2">' + facts.map(function (f) {
            return '<span class="chip">' + esc(f[0]) + ': ' + esc(f[1]) + '</span>';
          }).join('') + '</div>'
        : '') +
      '<div class="detail__care">' + careLines + '</div>' +
      (sp && sp.tip ? '<div class="tip-box">' + esc(I18N.pick(sp.tip)) + '</div>' : '') +
      (p.notes ? '<p class="small mt-2" style="white-space:pre-wrap">' + esc(p.notes) + '</p>' : '') +
      '<h3 class="mt-2" style="font-size:1rem">' + esc(I18N.t('pl.detail.history')) + '</h3>' +
      (history ? '<ul class="log-list">' + history + '</ul>'
               : '<p class="small muted">' + esc(I18N.t('pl.detail.noHistory')) + '</p>');

    body.querySelectorAll('[data-log]').forEach(function (btn) {
      btn.addEventListener('click', function () { logCare(p, btn.getAttribute('data-log')); });
    });

    $('detail-edit').onclick = function () {
      $('detail').close();
      openEditor(p.id);
    };
    $('detail').showModal();
  }

  function buildSpeciesOptions() {
    var sel = $('f-species');
    var groups = {};
    species.forEach(function (s) {
      (groups[s.category] = groups[s.category] || []).push(s);
    });

    var html = '<option value="">' + esc(I18N.t('pl.f.other')) + '</option>';
    Object.keys(groups).sort().forEach(function (cat) {
      html += '<optgroup label="' + esc(I18N.t('pl.cat.' + cat)) + '">';
      groups[cat]
        .slice()
        .sort(function (a, b) { return I18N.pick(a.name).localeCompare(I18N.pick(b.name), I18N.locale()); })
        .forEach(function (s) {
          html += '<option value="' + esc(s.id) + '">' + s.emoji + ' ' + esc(I18N.pick(s.name)) + '</option>';
        });
      html += '</optgroup>';
    });
    sel.innerHTML = html;
  }

  /* ---------------------------------------------------------- photos --- */

  /* Records live in a 64 KB JSONB row and sync whole, so photos are stored
     as small JPEG data URLs squeezed to fit: downscale, then walk the
     quality down until the string is under budget. Plenty for a thumbnail
     of a plant; originals stay on the phone. */
  var PHOTO_BUDGET = 50000; // data-URL characters (~37 KB of JPEG)
  var editorPhoto;          // undefined = untouched · null = removed · string = new

  function compressPhoto(file, done, fail) {
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(url);
      var dims = [640, 480, 360];
      var quals = [0.72, 0.6, 0.5, 0.4];
      for (var d = 0; d < dims.length; d++) {
        var scale = Math.min(1, dims[d] / Math.max(img.width, img.height));
        var canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        for (var q = 0; q < quals.length; q++) {
          var out = canvas.toDataURL('image/jpeg', quals[q]);
          if (out.length <= PHOTO_BUDGET) return done(out);
        }
      }
      fail();
    };
    img.onerror = function () { URL.revokeObjectURL(url); fail(); };
    img.src = url;
  }

  function currentEditorPhoto() {
    if (editorPhoto !== undefined) return editorPhoto;
    var p = editingId ? store.get(editingId) : null;
    return (p && p.photo) || null;
  }

  function renderPhotoField() {
    var photo = currentEditorPhoto();
    var img = $('f-photo-preview');
    img.hidden = !photo;
    if (photo) img.src = photo;
    else img.removeAttribute('src');
    $('f-photo-label').textContent = I18N.t(photo ? 'pl.f.photoChange' : 'pl.f.photoAdd');
    $('f-photo-remove').hidden = !photo;
  }

  function openEditor(id) {
    editingId = id || null;
    var p = id ? store.get(id) : null;
    editorPhoto = undefined;
    renderPhotoField();

    buildSpeciesOptions();
    $('editor-title').textContent = I18N.t(id ? 'pl.editing' : 'pl.new');
    $('f-species').value = (p && p.speciesId) || '';
    $('f-custom').value = (p && p.customSpecies) || '';
    $('f-name').value = (p && p.name) || '';
    $('f-location').value = (p && p.location) || '';
    $('f-pot').value = (p && p.potSize) || '';
    $('f-acquired').value = p && p.acquired ? Shell.isoDate(p.acquired) : '';
    $('f-water').value = (p && p.waterEvery) || '';
    $('f-notes').value = (p && p.notes) || '';
    $('f-hint').textContent = I18N.t('pl.f.hintAuto');
    $('editor-delete').hidden = !id;
    syncCustomVisibility();
    $('editor').showModal();
  }

  function syncCustomVisibility() {
    $('f-custom-wrap').hidden = !!$('f-species').value;
  }

  function saveEditor() {
    var speciesId = $('f-species').value;
    var custom = $('f-custom').value.trim();
    var name = $('f-name').value.trim();

    if (!speciesId && !custom && !name) {
      Shell.toast(I18N.t('pl.needName'), 'error');
      return false;
    }

    var existing = editingId ? store.get(editingId) : null;
    var record = Object.assign({}, existing || { care: {}, log: [] }, {
      id: editingId || undefined,
      speciesId: speciesId || null,
      customSpecies: speciesId ? null : (custom || null),
      name: name || null,
      location: $('f-location').value.trim() || null,
      potSize: $('f-pot').value ? Number($('f-pot').value) : null,
      acquired: $('f-acquired').value || null,
      waterEvery: $('f-water').value ? Number($('f-water').value) : null,
      notes: $('f-notes').value.trim() || null,
      photo: editorPhoto !== undefined ? editorPhoto : ((existing && existing.photo) || null)
    });

    store.put(record);
    Shell.toast(I18N.t('pl.saved'));
    return true;
  }

  /* ====================================================================== */
  /*  Data menu                                                             */
  /* ====================================================================== */

  function download(filename, text) {
    var blob = new Blob([text], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function wireDataMenu() {
    $('menu-btn').addEventListener('click', function () {
      var st = store.status();
      $('data-status').textContent = st.lastSync
        ? I18N.t('pl.when.last', { d: I18N.formatDate(st.lastSync, { dateStyle: 'medium', timeStyle: 'short' }) })
        : '';
      $('datamenu').showModal();
    });

    $('do-sync').addEventListener('click', function () {
      store.sync().then(function () {
        renderSyncPill();
        Shell.toast(I18N.t('common.saved'));
      });
    });

    $('do-export').addEventListener('click', function () {
      download('balcony-' + Shell.isoDate(new Date()) + '.json', store.exportJSON());
    });

    $('do-import').addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        var parsed;
        try { parsed = JSON.parse(String(reader.result)); } catch (err) { parsed = null; }
        var list = parsed && Array.isArray(parsed.records) ? parsed.records
                 : Array.isArray(parsed) ? parsed : null;
        if (!list) { Shell.toast(I18N.t('pl.data.importBad'), 'error'); return; }
        if (!confirm(I18N.t('pl.data.importConfirm'))) return;
        store.replaceAll(list).then(function () {
          Shell.toast(I18N.t('pl.data.imported', { n: list.length }));
          $('datamenu').close();
        });
      };
      reader.readAsText(file);
      e.target.value = '';
    });

    $('do-lock').addEventListener('click', function () {
      Store.auth.clear();
      location.reload();
    });
  }

  /* ====================================================================== */
  /*  Boot                                                                  */
  /* ====================================================================== */

  function showApp() {
    $('lock').classList.add('hidden');
    $('app').classList.remove('hidden');
    render();
    store.pull().then(render);
    loadWeather();
  }

  function showLock(message) {
    $('app').classList.add('hidden');
    $('lock').classList.remove('hidden');
    if (message) Shell.toast(message, 'error');
  }

  function loadWeather() {
    fetch('/api/weather')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || !data.ok) return;
        forecast = data;
        render();
      })
      .catch(function () { /* scheduling still works without it */ });
  }

  function wireModals() {
    document.querySelectorAll('dialog.modal').forEach(function (dlg) {
      dlg.querySelectorAll('[data-close]').forEach(function (btn) {
        btn.addEventListener('click', function () { dlg.close(); });
      });
      // Click on the backdrop (outside the panel) closes it.
      dlg.addEventListener('click', function (e) {
        if (e.target === dlg) dlg.close();
      });
    });

    $('f-species').addEventListener('change', syncCustomVisibility);

    $('f-photo').addEventListener('change', function () {
      var file = this.files && this.files[0];
      this.value = '';
      if (!file) return;
      compressPhoto(file, function (dataUrl) {
        editorPhoto = dataUrl;
        renderPhotoField();
      }, function () {
        Shell.toast(I18N.t('pl.photoErr'), 'error');
      });
    });

    $('f-photo-remove').addEventListener('click', function () {
      editorPhoto = null;
      renderPhotoField();
    });

    $('editor-form').addEventListener('submit', function (e) {
      if (!saveEditor()) e.preventDefault();
    });

    $('editor-delete').addEventListener('click', function () {
      if (!editingId) return;
      if (!confirm(I18N.t('pl.confirmDelete'))) return;
      store.remove(editingId);
      $('editor').close();
    });

    $('add-plant').addEventListener('click', function () { openEditor(null); });
  }

  function start() {
    wireModals();
    wireDataMenu();

    store.onChange(function () { render(); });
    document.addEventListener('langchange', function () {
      if (!$('app').classList.contains('hidden')) render();
    });

    // Refresh relative dates if the tab is left open across midnight.
    setInterval(function () {
      if (!$('app').classList.contains('hidden')) render();
    }, 30 * 60 * 1000);

    Store.health().then(function (h) {
      if (!h.ok || !h.database || !h.authRequired) {
        // No backend, or no passcode configured: go straight in.
        showApp();
        return;
      }
      if (Store.auth.has()) { showApp(); return; }
      showLock();
    });
  }

  $('lock-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var code = $('lock-input').value;
    if (!code) return;
    Store.auth.set(code);
    store.pull().then(function () {
      var st = store.status();
      if (st.lastError && st.lastError.status === 401) {
        Store.auth.clear();
        showLock(I18N.t('pl.lock.wrong'));
      } else {
        showApp();
      }
    });
  });

  $('lock-offline').addEventListener('click', function (e) {
    e.preventDefault();
    showApp();
  });

  Shell.init('plants');

  fetch('/data/species.json')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      species = data.species || [];
      species.forEach(function (s) { speciesById[s.id] = s; });
      start();
    })
    .catch(function () {
      // The inventory still works without the species table; care defaults
      // simply fall back to a weekly watering rhythm.
      start();
      Shell.toast(I18N.t('common.error'), 'error');
    });

})();
