/* ==========================================================================
   croissants.js — a tasting log that happens to produce a ranking.

   The important design decision: nothing is pre-rated. The shipped data file
   is a shortlist of real Tokyo bakeries with no scores attached, and every
   number on this page traces back to a tasting somebody actually recorded.
   A bakery with no tasting shows as "to try", never as a low score.
   ========================================================================== */

(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var esc = Shell.esc;

  var criteria = [];
  var bakeries = [];
  var bakeryById = Object.create(null);
  var store = Store.open('tastings');

  var filterStatus = 'all';
  var compare = [];
  var editingId = null;
  var MAX_COMPARE = 3;   // the validated categorical palette is three slots

  I18N.extend({
    'cr.title':   { en: 'Croissant Hunt — Shinya Shimada', ja: 'クロワッサン探し — 島田 慎也', es: 'La Caza del Croissant — Shinya Shimada' },
    'cr.eyebrow': { en: 'Pain au chocolat, Tokyo', ja: '東京のパン・オ・ショコラ', es: 'Pain au chocolat, Tokio' },
    'cr.heading': { en: 'The Croissant Hunt', ja: 'クロワッサン探し', es: 'La Caza del Croissant' },
    'cr.lede': {
      en: 'Six things to judge, one city, and a list that only gets shorter by eating.',
      ja: '6つの基準で採点。食べた分だけリストが減っていきます。',
      es: 'Seis criterios, una ciudad y una lista que solo se acorta comiendo.'
    },

    'cr.honest.title': {
      en: 'Every score here comes from a tasting.',
      ja: 'このページの点数はすべて実際の実食によるものです。',
      es: 'Cada puntuación aquí viene de una degustación.'
    },
    'cr.honest.body': {
      en: 'The bakery list is a starting shortlist — no ratings are pre-filled. A shop stays “to try” until somebody scores it, so the leaderboard only ever reflects croissants that were actually eaten.',
      ja: 'お店の一覧は出発点のリストで、点数は入っていません。誰かが採点するまでは「未訪問」のまま。ランキングには実際に食べたものだけが並びます。',
      es: 'La lista de panaderías es solo un punto de partida, sin valoraciones previas. Una tienda sigue «por probar» hasta que alguien la puntúa.'
    },

    'cr.stat.tasted':  { en: 'Tasted',   ja: '実食',     es: 'Probadas' },
    'cr.stat.toTry':   { en: 'To try',   ja: '未訪問',   es: 'Por probar' },
    'cr.stat.best':    { en: 'Best so far', ja: '現在の1位', es: 'La mejor' },
    'cr.stat.avgPrice':{ en: 'Average price', ja: '平均価格', es: 'Precio medio' },

    'cr.board.title':  { en: 'Leaderboard', ja: 'ランキング', es: 'Clasificación' },
    'cr.board.sub':    { en: 'Weighted score out of 10', ja: '10点満点の加重スコア', es: 'Puntuación ponderada sobre 10' },
    'cr.board.empty':  { en: 'Nothing tasted yet', ja: 'まだ実食がありません', es: 'Aún no hay degustaciones' },
    'cr.board.emptyBody': {
      en: 'Score the first croissant and the ranking starts here.',
      ja: '最初の1つを採点すると、ここにランキングが表示されます。',
      es: 'Puntúa el primer croissant y la clasificación empieza aquí.'
    },
    'cr.board.bakery': { en: 'Bakery', ja: '店', es: 'Panadería' },
    'cr.board.score':  { en: 'Score', ja: 'スコア', es: 'Puntuación' },

    'cr.list.title':   { en: 'The shortlist', ja: 'リスト', es: 'La lista' },
    'cr.add':          { en: '+ Record a tasting', ja: '+ 実食を記録', es: '+ Registrar degustación' },
    'cr.addHere':      { en: 'Record a tasting here', ja: 'この店を採点', es: 'Puntuar esta' },

    'cr.f.all':    { en: 'All', ja: 'すべて', es: 'Todas' },
    'cr.f.tasted': { en: 'Tasted', ja: '実食済み', es: 'Probadas' },
    'cr.f.toTry':  { en: 'To try', ja: '未訪問', es: 'Por probar' },

    'cr.card.toTry':   { en: 'To try', ja: '未訪問', es: 'Por probar' },
    'cr.card.tastings':{ en: '{n} tastings', ja: '{n}回', es: '{n} degustaciones' },
    'cr.card.tastings1':{ en: '1 tasting', ja: '1回', es: '1 degustación' },

    'cr.compare.hint':  { en: 'Compare up to three', ja: '最大3店まで比較', es: 'Compara hasta tres' },
    'cr.compare.count': { en: '{n} selected for comparison', ja: '{n}店を選択中', es: '{n} seleccionadas' },
    'cr.compare.clear': { en: 'Clear', ja: '解除', es: 'Limpiar' },
    'cr.compare.add':   { en: 'Compare', ja: '比較に追加', es: 'Comparar' },
    'cr.compare.remove':{ en: 'Comparing', ja: '比較中', es: 'Comparando' },
    'cr.compare.title': { en: 'Side by side', ja: '比較', es: 'Cara a cara' },
    'cr.compare.sub':   { en: 'Average score per criterion', ja: '基準ごとの平均点', es: 'Puntuación media por criterio' },
    'cr.compare.max':   { en: 'Three is the limit — deselect one first.', ja: '比較は3店までです。', es: 'El límite son tres; quita una primero.' },

    'cr.form.title':        { en: 'Record a tasting', ja: '実食を記録', es: 'Registrar una degustación' },
    'cr.form.edit':         { en: 'Edit tasting', ja: '記録を編集', es: 'Editar degustación' },
    'cr.form.bakery':       { en: 'Bakery', ja: '店', es: 'Panadería' },
    'cr.form.customBakery': { en: 'Bakery name', ja: '店名', es: 'Nombre de la panadería' },
    'cr.form.other':        { en: 'Somewhere else…', ja: 'その他…', es: 'Otro sitio…' },
    'cr.form.date':         { en: 'Date', ja: '日付', es: 'Fecha' },
    'cr.form.price':        { en: 'Price (¥)', ja: '価格（円）', es: 'Precio (¥)' },
    'cr.form.who':          { en: 'Tasted by', ja: '実食者', es: 'Probado por' },
    'cr.form.notes':        { en: 'Notes', ja: 'メモ', es: 'Notas' },
    'cr.form.notesPh':      { en: 'What did it actually taste like?', ja: '味の印象は？', es: '¿A qué sabía realmente?' },
    'cr.form.needBakery':   { en: 'Choose or name a bakery first.', ja: '店を選ぶか、店名を入力してください。', es: 'Elige o escribe una panadería.' },
    'cr.form.saved':        { en: 'Tasting saved', ja: '記録しました', es: 'Degustación guardada' },
    'cr.form.confirmDelete':{ en: 'Delete this tasting?', ja: 'この記録を削除しますか？', es: '¿Eliminar esta degustación?' },
    'cr.who.both':          { en: 'Both of us', ja: 'ふたりで', es: 'Los dos' },
    'cr.who.shin':          { en: 'Shin', ja: 'しん', es: 'Shin' },
    'cr.who.joel':          { en: 'Joel', ja: 'ジョエル', es: 'Joel' },

    'cr.detail.breakdown':  { en: 'By criterion', ja: '基準ごと', es: 'Por criterio' },
    'cr.detail.history':    { en: 'Tastings', ja: '実食の記録', es: 'Degustaciones' },
    'cr.detail.none':       { en: 'Not tasted yet.', ja: 'まだ食べていません。', es: 'Aún sin probar.' },
    'cr.detail.criterion':  { en: 'Criterion', ja: '基準', es: 'Criterio' },
    'cr.detail.score':      { en: 'Score', ja: '点', es: 'Puntos' },

    'cr.locked': {
      en: 'Add the passcode on the Balcony page to record tastings from this device.',
      ja: '記録するには、ベランダのページでパスコードを入力してください。',
      es: 'Introduce el código en la página del Balcón para registrar degustaciones.'
    }
  });

  /* ------------------------------------------------------------- scoring -- */

  /** Weighted mean out of 10; criteria left blank simply do not count. */
  function scoreOf(tasting) {
    var total = 0, weight = 0;
    criteria.forEach(function (c) {
      var v = tasting.scores && tasting.scores[c.id];
      if (typeof v !== 'number' || isNaN(v)) return;
      var w = c.weight || 1;
      total += v * w;
      weight += w;
    });
    return weight ? total / weight : null;
  }

  function tastingsFor(bakeryKey) {
    return store.items().filter(function (t) { return keyOf(t) === bakeryKey; });
  }

  function keyOf(tasting) {
    return tasting.bakeryId || ('custom:' + (tasting.customBakery || '').trim().toLowerCase());
  }

  function nameOfKey(key) {
    if (bakeryById[key]) return bakeryById[key].name;
    var found = store.items().filter(function (t) { return keyOf(t) === key; })[0];
    return (found && found.customBakery) || key.replace(/^custom:/, '');
  }

  /** One aggregated row per bakery that has at least one tasting. */
  function aggregates() {
    var groups = Object.create(null);
    store.items().forEach(function (t) {
      var s = scoreOf(t);
      if (s === null) return;
      var k = keyOf(t);
      (groups[k] = groups[k] || []).push({ tasting: t, score: s });
    });

    return Object.keys(groups).map(function (k) {
      var list = groups[k];
      var mean = list.reduce(function (a, b) { return a + b.score; }, 0) / list.length;
      var prices = list.map(function (x) { return x.tasting.price; }).filter(function (p) { return typeof p === 'number' && p > 0; });
      var perCriterion = {};
      criteria.forEach(function (c) {
        var vals = list.map(function (x) { return x.tasting.scores && x.tasting.scores[c.id]; })
          .filter(function (v) { return typeof v === 'number' && !isNaN(v); });
        perCriterion[c.id] = vals.length ? vals.reduce(function (a, b) { return a + b; }, 0) / vals.length : null;
      });
      return {
        key: k,
        name: nameOfKey(k),
        score: mean,
        count: list.length,
        avgPrice: prices.length ? prices.reduce(function (a, b) { return a + b; }, 0) / prices.length : null,
        perCriterion: perCriterion
      };
    }).sort(function (a, b) { return b.score - a.score; });
  }

  /* ------------------------------------------------------------ rendering -- */

  function fmtScore(v) { return (Math.round(v * 10) / 10).toFixed(1); }

  function renderStats(aggs) {
    var tasted = aggs.length;
    var toTry = bakeries.filter(function (b) { return !tastingsFor(b.id).length; }).length;
    var best = aggs[0];
    var priced = aggs.filter(function (a) { return a.avgPrice; });
    var avgPrice = priced.length
      ? priced.reduce(function (s, a) { return s + a.avgPrice; }, 0) / priced.length
      : null;

    var cells = [
      [I18N.t('cr.stat.tasted'), String(tasted), ''],
      [I18N.t('cr.stat.toTry'), String(toTry), ''],
      [I18N.t('cr.stat.best'), best ? fmtScore(best.score) : '—', best ? best.name : ''],
      [I18N.t('cr.stat.avgPrice'), avgPrice ? '¥' + Math.round(avgPrice) : '—', '']
    ];

    $('stats').innerHTML = cells.map(function (c) {
      return '<div class="stat"><p class="stat__label">' + esc(c[0]) + '</p>' +
        '<p class="stat__value">' + esc(c[1]) + '</p>' +
        (c[2] ? '<p class="stat__note">' + esc(c[2]) + '</p>' : '') + '</div>';
    }).join('');
  }

  function renderLeaderboard(aggs) {
    var host = $('leaderboard');
    if (!aggs.length) {
      host.innerHTML =
        '<div class="empty-state"><div class="empty-state__icon">🥐</div>' +
        '<h3>' + esc(I18N.t('cr.board.empty')) + '</h3>' +
        '<p>' + esc(I18N.t('cr.board.emptyBody')) + '</p></div>';
      return;
    }

    // One series, so one colour for every bar — never a ramp by rank.
    Charts.bars(host, {
      title: I18N.t('cr.board.title'),
      subtitle: I18N.t('cr.board.sub'),
      tableLabel: I18N.t('viz.table'),
      tableHeaders: [I18N.t('cr.board.bakery'), I18N.t('cr.board.score')],
      ariaLabel: I18N.t('cr.board.title'),
      color: 'var(--series-2)',
      max: 10,
      rows: aggs.map(function (a) {
        return {
          label: a.name,
          value: Math.round(a.score * 10) / 10,
          sublabel: a.count === 1 ? I18N.t('cr.card.tastings1') : I18N.t('cr.card.tastings', { n: a.count })
        };
      }),
      format: fmtScore
    });
  }

  function renderCompare(aggs) {
    var card = $('compare-card');
    var picked = compare
      .map(function (k) { return aggs.filter(function (a) { return a.key === k; })[0]; })
      .filter(Boolean);

    if (picked.length < 2) { card.classList.add('hidden'); return; }
    card.classList.remove('hidden');

    Charts.bars($('compare-chart'), {
      title: I18N.t('cr.compare.title'),
      subtitle: I18N.t('cr.compare.sub'),
      tableLabel: I18N.t('viz.table'),
      tableHeaders: [I18N.t('cr.detail.criterion')].concat(picked.map(function (p) { return p.name; })),
      ariaLabel: I18N.t('cr.compare.title'),
      max: 10,
      rows: criteria.map(function (c) { return { label: I18N.pick(c.name) }; }),
      series: picked.map(function (p) {
        return {
          name: p.name,
          values: criteria.map(function (c) { return p.perCriterion[c.id]; })
        };
      }),
      format: function (v) { return (v === null || v === undefined || isNaN(v)) ? '—' : fmtScore(v); }
    });
  }

  function renderCompareBar() {
    var bar = $('compare-bar');
    if (!compare.length) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    $('compare-label').textContent = I18N.t('cr.compare.count', { n: compare.length });
  }

  function renderFilters() {
    var host = $('filter-status');
    var opts = [['all', 'cr.f.all'], ['tasted', 'cr.f.tasted'], ['toTry', 'cr.f.toTry']];
    host.innerHTML = '';
    opts.forEach(function (o) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = I18N.t(o[1]);
      btn.setAttribute('aria-pressed', String(filterStatus === o[0]));
      btn.addEventListener('click', function () { filterStatus = o[0]; render(); });
      host.appendChild(btn);
    });
  }

  function renderGrid(aggs) {
    var host = $('bakery-grid');
    var aggByKey = Object.create(null);
    aggs.forEach(function (a, i) { aggByKey[a.key] = { agg: a, rank: i + 1 }; });

    // Shortlist entries, plus any bakery invented on the spot in a tasting.
    var rows = bakeries.map(function (b) {
      return { key: b.id, name: b.name, area: I18N.pick(b.area), note: I18N.pick(b.note) };
    });
    aggs.forEach(function (a) {
      if (!bakeryById[a.key]) rows.push({ key: a.key, name: a.name, area: '', note: '' });
    });

    rows = rows.filter(function (r) {
      var hit = aggByKey[r.key];
      if (filterStatus === 'tasted') return !!hit;
      if (filterStatus === 'toTry') return !hit;
      return true;
    });

    rows.sort(function (x, y) {
      var ax = aggByKey[x.key], ay = aggByKey[y.key];
      if (ax && ay) return ax.rank - ay.rank;
      if (ax) return -1;
      if (ay) return 1;
      return x.name.localeCompare(y.name, I18N.locale());
    });

    host.innerHTML = '';
    rows.forEach(function (r) {
      var hit = aggByKey[r.key];

      /* The card is a div rather than a button because tasted cards carry
         their own Compare button, and a button inside a button is invalid. */
      var card = document.createElement('div');
      card.className = 'bakery-card';
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      card.setAttribute('data-selected', String(compare.indexOf(r.key) !== -1));

      card.innerHTML =
        (hit && hit.rank <= 3 ? '<span class="rank-medal" data-rank="' + hit.rank + '">' + hit.rank + '</span>' : '') +
        '<span class="bakery-card__head">' +
          '<span><span class="bakery-card__name">' + esc(r.name) + '</span>' +
          (r.area ? '<br><span class="bakery-card__area">' + esc(r.area) + '</span>' : '') + '</span>' +
          (hit
            ? '<span class="score-badge"><b>' + fmtScore(hit.agg.score) + '</b><span>/10</span></span>'
            : '<span class="chip">' + esc(I18N.t('cr.card.toTry')) + '</span>') +
        '</span>' +
        (r.note ? '<span class="bakery-card__note">' + esc(r.note) + '</span>' : '') +
        (hit
          ? '<span class="bakery-card__meta"><span class="chip chip--terracotta">' +
            esc(hit.agg.count === 1 ? I18N.t('cr.card.tastings1') : I18N.t('cr.card.tastings', { n: hit.agg.count })) +
            '</span>' + (hit.agg.avgPrice ? '<span class="chip">\u00a5' + Math.round(hit.agg.avgPrice) + '</span>' : '') + '</span>'
          : '');

      function open() { openBakery(r.key, r.name); }
      card.addEventListener('click', open);
      card.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });

      if (hit) {
        var selected = compare.indexOf(r.key) !== -1;
        var cmp = document.createElement('button');
        cmp.type = 'button';
        cmp.className = 'btn btn--sm ' + (selected ? 'btn--terracotta' : 'btn--ghost');
        cmp.style.marginTop = '.7rem';
        cmp.textContent = I18N.t(selected ? 'cr.compare.remove' : 'cr.compare.add');
        cmp.setAttribute('aria-pressed', String(selected));
        cmp.addEventListener('click', function (e) {
          e.stopPropagation();
          toggleCompare(r.key);
        });
        card.appendChild(cmp);
      }

      host.appendChild(card);
    });
  }

  function toggleCompare(key) {
    var i = compare.indexOf(key);
    if (i !== -1) compare.splice(i, 1);
    else if (compare.length >= MAX_COMPARE) { Shell.toast(I18N.t('cr.compare.max'), 'error'); return; }
    else compare.push(key);
    render();
  }

  function render() {
    var aggs = aggregates();
    renderStats(aggs);
    renderLeaderboard(aggs);
    renderCompare(aggs);
    renderCompareBar();
    renderFilters();
    renderGrid(aggs);
  }

  /* --------------------------------------------------------------- detail -- */

  function openBakery(key, name) {
    var list = tastingsFor(key).slice().sort(function (a, b) {
      return String(b.date || '').localeCompare(String(a.date || ''));
    });
    var agg = aggregates().filter(function (a) { return a.key === key; })[0];

    $('bakery-name').textContent = name;
    var body = $('bakery-body');

    if (!list.length) {
      var b = bakeryById[key];
      body.innerHTML =
        (b ? '<p class="muted">' + esc(I18N.pick(b.area)) + '</p><p>' + esc(I18N.pick(b.note)) + '</p>' : '') +
        '<div class="empty-state"><div class="empty-state__icon">🥐</div><p>' +
        esc(I18N.t('cr.detail.none')) + '</p></div>';
    } else {
      body.innerHTML =
        '<div id="bakery-chart" class="mb-2"></div>' +
        '<h3 style="font-size:1rem">' + esc(I18N.t('cr.detail.history')) + '</h3>' +
        '<ul class="tasting-list">' + list.map(function (t) {
          var s = scoreOf(t);
          return '<li><time>' + esc(t.date ? I18N.formatDate(t.date) : '—') + '</time>' +
            '<span class="t-score">' + (s === null ? '—' : fmtScore(s)) + '</span>' +
            '<span class="t-note">' + esc(t.notes || '') +
            (t.who ? ' <span class="muted tiny">· ' + esc(I18N.t('cr.who.' + t.who)) + '</span>' : '') + '</span>' +
            '<button type="button" class="btn btn--ghost btn--sm" data-edit="' + esc(t.id) + '">' +
            esc(I18N.t('common.edit')) + '</button></li>';
        }).join('') + '</ul>';

      if (agg) {
        Charts.bars(document.getElementById('bakery-chart'), {
          title: I18N.t('cr.detail.breakdown'),
          tableLabel: I18N.t('viz.table'),
          tableHeaders: [I18N.t('cr.detail.criterion'), I18N.t('cr.detail.score')],
          ariaLabel: name + ' — ' + I18N.t('cr.detail.breakdown'),
          max: 10,
          color: 'var(--series-2)',
          rows: criteria.map(function (c) {
            return { label: I18N.pick(c.name), value: agg.perCriterion[c.id] };
          }).filter(function (r) { return r.value !== null; }),
          format: fmtScore
        });
      }

      body.querySelectorAll('[data-edit]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          $('bakery').close();
          openTaster(btn.getAttribute('data-edit'));
        });
      });
    }

    $('bakery-taste').onclick = function () {
      $('bakery').close();
      openTaster(null, bakeryById[key] ? key : null, bakeryById[key] ? null : name);
    };
    $('bakery').showModal();
  }

  /* ---------------------------------------------------------------- form -- */

  function buildScoreRows(values) {
    $('t-scores').innerHTML = criteria.map(function (c) {
      var v = (values && typeof values[c.id] === 'number') ? values[c.id] : 7;
      return '<div class="score-row">' +
        '<div class="score-row__head">' +
          '<label class="score-row__label" for="sc-' + esc(c.id) + '">' + esc(I18N.pick(c.name)) + '</label>' +
          '<span class="score-row__value" id="scv-' + esc(c.id) + '">' + v + '</span>' +
        '</div>' +
        '<p class="score-row__hint">' + esc(I18N.pick(c.hint)) + '</p>' +
        '<input type="range" id="sc-' + esc(c.id) + '" min="1" max="10" step="1" value="' + v + '">' +
      '</div>';
    }).join('');

    criteria.forEach(function (c) {
      var input = document.getElementById('sc-' + c.id);
      var out = document.getElementById('scv-' + c.id);
      input.addEventListener('input', function () { out.textContent = input.value; });
    });
  }

  function buildBakeryOptions(selected) {
    var html = '<option value="">' + esc(I18N.t('cr.form.other')) + '</option>';
    bakeries.slice().sort(function (a, b) { return a.name.localeCompare(b.name, I18N.locale()); })
      .forEach(function (b) {
        html += '<option value="' + esc(b.id) + '">' + esc(b.name) + ' — ' + esc(I18N.pick(b.area)) + '</option>';
      });
    $('t-bakery').innerHTML = html;
    $('t-bakery').value = selected || '';

    $('t-who').innerHTML = ['both', 'shin', 'joel'].map(function (w) {
      return '<option value="' + w + '">' + esc(I18N.t('cr.who.' + w)) + '</option>';
    }).join('');
  }

  function openTaster(id, presetBakery, presetCustom) {
    editingId = id || null;
    var t = id ? store.get(id) : null;

    buildBakeryOptions(t ? t.bakeryId : presetBakery);
    buildScoreRows(t ? t.scores : null);

    document.querySelector('#taster .modal__head h2').textContent = I18N.t(id ? 'cr.form.edit' : 'cr.form.title');
    $('t-custom').value = (t && t.customBakery) || presetCustom || '';
    $('t-date').value = t && t.date ? t.date : Shell.isoDate(new Date());
    $('t-price').value = (t && t.price) || '';
    $('t-who').value = (t && t.who) || 'both';
    $('t-notes').value = (t && t.notes) || '';
    $('t-delete').hidden = !id;
    syncCustom();
    $('taster').showModal();
  }

  function syncCustom() { $('t-custom-wrap').hidden = !!$('t-bakery').value; }

  function saveTasting() {
    var bakeryId = $('t-bakery').value;
    var custom = $('t-custom').value.trim();
    if (!bakeryId && !custom) {
      Shell.toast(I18N.t('cr.form.needBakery'), 'error');
      return false;
    }

    var scores = {};
    criteria.forEach(function (c) {
      var el = document.getElementById('sc-' + c.id);
      if (el) scores[c.id] = Number(el.value);
    });

    store.put(Object.assign({}, editingId ? store.get(editingId) : {}, {
      id: editingId || undefined,
      bakeryId: bakeryId || null,
      customBakery: bakeryId ? null : custom,
      date: $('t-date').value || Shell.isoDate(new Date()),
      price: $('t-price').value ? Number($('t-price').value) : null,
      who: $('t-who').value,
      notes: $('t-notes').value.trim() || null,
      scores: scores
    }));

    Shell.toast(I18N.t('cr.form.saved'));
    return true;
  }

  /* ---------------------------------------------------------------- boot -- */

  function wire() {
    document.querySelectorAll('dialog.modal').forEach(function (dlg) {
      dlg.querySelectorAll('[data-close]').forEach(function (btn) {
        btn.addEventListener('click', function () { dlg.close(); });
      });
      dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
    });

    $('t-bakery').addEventListener('change', syncCustom);
    $('add-tasting').addEventListener('click', function () { openTaster(null); });

    $('taster-form').addEventListener('submit', function (e) {
      if (!saveTasting()) e.preventDefault();
    });

    $('t-delete').addEventListener('click', function () {
      if (!editingId || !confirm(I18N.t('cr.form.confirmDelete'))) return;
      store.remove(editingId);
      $('taster').close();
    });

    $('compare-clear').addEventListener('click', function () { compare = []; render(); });

    store.onChange(render);
    document.addEventListener('langchange', render);
  }

  Shell.init('croissants');

  fetch('/data/croissants.json')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      criteria = data.criteria || [];
      bakeries = data.bakeries || [];
      bakeries.forEach(function (b) { bakeryById[b.id] = b; });
      wire();
      render();
      store.pull().then(render);
    })
    .catch(function () {
      wire();
      render();
      Shell.toast(I18N.t('common.error'), 'error');
    });

})();
