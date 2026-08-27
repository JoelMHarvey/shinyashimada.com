/* ==========================================================================
   tokyo.js — current conditions, a 24-hour temperature line, a seven-day
   outlook and the headlines, all in whichever of the three languages is on.

   The forecast is read as *balcony* weather: the advisories that matter here
   are frost, heat, wind and rain, because that is what a pot on a fifth floor
   actually has to survive.
   ========================================================================== */

(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var esc = Shell.esc;
  var forecast = null;
  var newsCache = {};

  I18N.extend({
    'tk.title':   { en: 'Tokyo Today — Shinya Shimada', ja: '東京の今日 — 島田 慎也', es: 'Tokio Hoy — Shinya Shimada' },
    'tk.eyebrow': { en: 'Weather & headlines', ja: '天気とニュース', es: 'Clima y titulares' },
    'tk.heading': { en: 'Tokyo Today', ja: '東京の今日', es: 'Tokio Hoy' },
    'tk.lede': {
      en: 'What the balcony is in for, and what the city is talking about.',
      ja: 'ベランダの植物が迎える天気と、街の話題。',
      es: 'Lo que le espera al balcón y de qué habla la ciudad.'
    },

    'tk.now.feels':    { en: 'Feels like', ja: '体感',     es: 'Sensación' },
    'tk.now.humidity': { en: 'Humidity',   ja: '湿度',     es: 'Humedad' },
    'tk.now.wind':     { en: 'Wind',       ja: '風',       es: 'Viento' },
    'tk.now.rain':     { en: 'Rain now',   ja: '降水',     es: 'Lluvia ahora' },

    'tk.hourly.title': { en: 'Next 24 hours', ja: 'この先24時間', es: 'Próximas 24 horas' },
    'tk.hourly.sub':   { en: 'Temperature', ja: '気温', es: 'Temperatura' },
    'tk.hourly.hour':  { en: 'Hour', ja: '時刻', es: 'Hora' },
    'tk.hourly.temp':  { en: 'Temp', ja: '気温', es: 'Temp' },

    'tk.week.title': { en: 'The week ahead', ja: '週間予報', es: 'La semana' },
    'tk.week.note': {
      en: 'Bars span each day’s low to high on one shared scale.',
      ja: '各日の最低〜最高気温を共通のスケールで表示しています。',
      es: 'Las barras van de la mínima a la máxima de cada día en una escala común.'
    },

    'tk.news.title':   { en: 'Headlines', ja: 'ニュース', es: 'Titulares' },
    'tk.news.refresh': { en: 'Refresh', ja: '更新', es: 'Actualizar' },
    'tk.news.source':  { en: 'Sources: {s}', ja: '出典: {s}', es: 'Fuentes: {s}' },
    'tk.news.updated': { en: 'Updated {t}', ja: '{t} 更新', es: 'Actualizado {t}' },
    'tk.news.fallback': {
      en: 'No Spanish-language wire was reachable, so these are the English headlines.',
      ja: 'この言語のフィードが取得できなかったため、英語のニュースを表示しています。',
      es: 'No se pudo acceder a un servicio en español, así que estos son los titulares en inglés.'
    },
    'tk.news.empty':   { en: 'No headlines right now', ja: 'ニュースを取得できません', es: 'Sin titulares ahora mismo' },
    'tk.news.emptyBody': {
      en: 'The news feeds could not be reached. They are public RSS sources, so this is usually temporary.',
      ja: 'ニュースフィードに接続できませんでした。公開RSSのため、通常は一時的なものです。',
      es: 'No se pudo acceder a los canales de noticias. Son fuentes RSS públicas, así que suele ser temporal.'
    },
    'tk.wx.empty':     { en: 'Forecast unavailable', ja: '天気予報を取得できません', es: 'Pronóstico no disponible' },
    'tk.wx.emptyBody': {
      en: 'The weather service could not be reached just now.',
      ja: '現在、気象サービスに接続できません。',
      es: 'No se pudo contactar con el servicio meteorológico.'
    },

    'viz.table': { en: 'Table', ja: '表', es: 'Tabla' },

    /* Advisories are shared with the balcony page. */
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
    'adv.dry.body':     { en: 'No rain for three days. Pots will dry out faster than usual.', ja: '3日間雨の予報がありません。鉢は普段より早く乾きます。', es: 'Sin lluvia en tres días. Las macetas se secarán antes de lo normal.' },
    'adv.fine.title':   { en: 'Good balcony weather', ja: 'ベランダ日和', es: 'Buen tiempo de balcón' },
    'adv.fine.body':    { en: 'Nothing to protect against today.', ja: '今日は特に対策の必要はありません。', es: 'Hoy no hay nada de lo que protegerse.' }
  });

  /* ------------------------------------------------------------ current -- */

  function renderNow() {
    var host = $('now-panel');
    if (!forecast || !forecast.current) {
      host.innerHTML =
        '<div class="empty-state" style="grid-column:1/-1"><div class="empty-state__icon">🌐</div>' +
        '<h3>' + esc(I18N.t('tk.wx.empty')) + '</h3>' +
        '<p>' + esc(I18N.t('tk.wx.emptyBody')) + '</p></div>';
      return;
    }

    var c = forecast.current;
    var facts = [
      ['tk.now.feels',    Math.round(c.apparent_temperature) + '°C'],
      ['tk.now.humidity', Math.round(c.relative_humidity_2m) + '%'],
      ['tk.now.wind',     Math.round(c.wind_speed_10m) + ' km/h'],
      ['tk.now.rain',     (c.precipitation || 0) + ' mm']
    ];

    host.innerHTML =
      '<div class="now-main">' +
        '<span class="now-icon">' + Weather.icon(c.weather_code, c.is_day) + '</span>' +
        '<span><span class="now-temp">' + Math.round(c.temperature_2m) + '°</span>' +
        '<br><span class="now-desc">' + esc(Weather.describe(c.weather_code)) + '</span></span>' +
      '</div>' +
      '<div class="now-facts">' + facts.map(function (f) {
        return '<div class="now-fact"><p class="now-fact__label">' + esc(I18N.t(f[0])) + '</p>' +
               '<p class="now-fact__value">' + esc(f[1]) + '</p></div>';
      }).join('') + '</div>';
  }

  function renderAdvisories() {
    var host = $('advisories');
    host.innerHTML = '';
    if (!forecast || !forecast.advisories) return;
    var icons = { frost: '❄️', cold: '🌡️', heat: '🔥', wind: '💨', heavyRain: '🌧️', uv: '☀️', dry: '🏜️', fine: '🌤️' };

    forecast.advisories.forEach(function (a) {
      var tone = a.severity === 'high' ? 'notice--danger' : a.severity === 'none' ? 'notice--green' : '';
      var div = document.createElement('div');
      div.className = 'notice ' + tone;
      div.innerHTML =
        '<span class="notice__icon">' + (icons[a.key] || '•') + '</span>' +
        '<div><strong>' + esc(I18N.t('adv.' + a.key + '.title')) + '</strong><br>' +
        esc(I18N.t('adv.' + a.key + '.body', { v: a.value })) + '</div>';
      host.appendChild(div);
    });
  }

  /* ------------------------------------------------------------- hourly -- */

  function renderHourly() {
    var host = $('hourly-chart');
    if (!forecast || !forecast.hourly || !forecast.hourly.time) { host.innerHTML = ''; return; }

    var h = forecast.hourly;
    var points = h.time.slice(0, 24).map(function (iso, i) {
      var d = new Date(iso);
      return {
        x: String(d.getHours()).padStart(2, '0'),
        tooltipX: I18N.formatDate(d, { hour: '2-digit', minute: '2-digit' }) +
                  ' · ' + Weather.describe(h.weather_code[i]) +
                  ' · ' + (h.precipitation_probability[i] || 0) + '%',
        value: Math.round(h.temperature_2m[i] * 10) / 10
      };
    });

    Charts.line(host, {
      title: I18N.t('tk.hourly.title'),
      subtitle: I18N.t('tk.hourly.sub'),
      tableLabel: I18N.t('viz.table'),
      tableHeaders: [I18N.t('tk.hourly.hour'), I18N.t('tk.hourly.temp')],
      ariaLabel: I18N.t('tk.hourly.title') + ' — ' + I18N.t('tk.hourly.sub'),
      points: points,
      height: 200,
      format: function (v) { return Math.round(v) + '°'; }
    });
  }

  /* --------------------------------------------------------------- week -- */

  function renderWeek() {
    var host = $('week');
    if (!forecast || !forecast.daily || !forecast.daily.time) { host.innerHTML = ''; return; }
    var d = forecast.daily;

    var lows = d.temperature_2m_min, highs = d.temperature_2m_max;
    var floor = Math.min.apply(null, lows);
    var ceil = Math.max.apply(null, highs);
    var span = (ceil - floor) || 1;

    host.innerHTML = d.time.map(function (iso, i) {
      var date = new Date(iso);
      var name = i === 0
        ? I18N.t('common.today')
        : I18N.formatDate(date, { weekday: 'short' });
      var left = ((lows[i] - floor) / span) * 100;
      var width = Math.max(4, ((highs[i] - lows[i]) / span) * 100);
      var rain = d.precipitation_probability_max ? d.precipitation_probability_max[i] : null;

      return '<div class="day-row">' +
        '<span class="day-row__name">' + esc(name) + '</span>' +
        '<span class="day-row__icon" title="' + esc(Weather.describe(d.weather_code[i])) + '">' +
          Weather.icon(d.weather_code[i], 1) + '</span>' +
        '<span><span class="range"><span class="range__span" style="left:' + left + '%;width:' + width + '%"></span></span>' +
          '<span class="range__labels"><span>' + Math.round(lows[i]) + '°</span>' +
          '<span>' + Math.round(highs[i]) + '°</span></span></span>' +
        '<span class="day-row__rain">' + (rain === null ? '' : rain + '%') + '</span>' +
      '</div>';
    }).join('');
  }

  /* --------------------------------------------------------------- news -- */

  function renderNews(data) {
    var host = $('news');
    var meta = $('news-meta');

    if (!data || !data.ok || !data.items || !data.items.length) {
      meta.textContent = '';
      host.innerHTML =
        '<div class="empty-state"><div class="empty-state__icon">📰</div>' +
        '<h3>' + esc(I18N.t('tk.news.empty')) + '</h3>' +
        '<p>' + esc(I18N.t('tk.news.emptyBody')) + '</p></div>';
      return;
    }

    meta.textContent = I18N.t('tk.news.source', { s: (data.sources || []).join(' · ') }) +
      (data.fetchedAt ? ' · ' + I18N.t('tk.news.updated', {
        t: I18N.formatDate(data.fetchedAt, { hour: '2-digit', minute: '2-digit' })
      }) : '');

    var fallbackNote = data.fallbackFrom
      ? '<div class="notice notice--sky mb-2"><span class="notice__icon">ℹ️</span><div>' +
        esc(I18N.t('tk.news.fallback')) + '</div></div>'
      : '';

    host.innerHTML = fallbackNote + '<ul class="news-list">' + data.items.map(function (item) {
      // Every field here is publisher-controlled text: escape, never inject.
      return '<li><a class="news-item" href="' + esc(item.link) + '" target="_blank" rel="noopener noreferrer">' +
        '<span class="news-item__title">' + esc(item.title) + '</span>' +
        (item.summary ? '<span class="news-item__summary">' + esc(item.summary) + '</span>' : '') +
        '<span class="news-item__meta"><span>' + esc(item.source) + '</span>' +
        (item.publishedAt ? '<span>' + esc(I18N.formatDate(item.publishedAt, {
          month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
        })) + '</span>' : '') +
        '</span></a></li>';
    }).join('') + '</ul>';
  }

  function loadNews(force) {
    var lang = I18N.lang;
    if (!force && newsCache[lang]) { renderNews(newsCache[lang]); return; }

    $('news').innerHTML = '<div class="card card--pad center"><span class="spinner"></span></div>';
    fetch('/api/news?lang=' + encodeURIComponent(lang))
      .then(function (r) { return r.json().catch(function () { return null; }); })
      .then(function (data) {
        if (data && data.ok) newsCache[lang] = data;
        renderNews(data);
      })
      .catch(function () { renderNews(null); });
  }

  function loadWeather() {
    fetch('/api/weather')
      .then(function (r) { return r.json().catch(function () { return null; }); })
      .then(function (data) {
        forecast = data && data.ok ? data : null;
        paintWeather();
      })
      .catch(function () { forecast = null; paintWeather(); });
  }

  function paintWeather() {
    renderNow();
    renderAdvisories();
    renderHourly();
    renderWeek();
  }

  document.addEventListener('langchange', function () {
    paintWeather();
    loadNews(false);
  });

  $('news-refresh').addEventListener('click', function () { loadNews(true); });

  Shell.init('tokyo');
  loadWeather();
  loadNews(false);

})();
