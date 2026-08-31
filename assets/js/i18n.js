/* ==========================================================================
   i18n — tiny trilingual engine (English / 日本語 / Español)
   --------------------------------------------------------------------------
   Strings are stored as  key: { en, ja, es }  so a translation is never
   orphaned from its siblings. Pages call I18N.extend() to add their own
   namespace, then I18N.apply() paints the DOM.

   Markup hooks:
     data-i18n="key"                    -> textContent
     data-i18n-html="key"               -> innerHTML (trusted dictionary only)
     data-i18n-attr="placeholder:key"   -> attribute(s), comma separated
   ========================================================================== */

(function (global) {
  'use strict';

  var LANGS = ['en', 'ja', 'es'];
  var LANG_LABEL = { en: 'EN', ja: '日本語', es: 'ES' };
  var HTML_LANG  = { en: 'en', ja: 'ja', es: 'es' };
  var STORE_KEY  = 'ss.lang';

  var strings = {};
  var current = 'en';

  function detect() {
    var saved;
    try { saved = localStorage.getItem(STORE_KEY); } catch (e) { saved = null; }
    if (saved && LANGS.indexOf(saved) !== -1) return saved;

    var nav = (global.navigator && (navigator.languages || [navigator.language])) || [];
    for (var i = 0; i < nav.length; i++) {
      var tag = String(nav[i] || '').toLowerCase();
      if (tag.indexOf('ja') === 0) return 'ja';
      if (tag.indexOf('es') === 0) return 'es';
      if (tag.indexOf('en') === 0) return 'en';
    }
    return 'en';
  }

  /** Merge a namespace of strings into the dictionary. */
  function extend(dict) {
    for (var k in dict) {
      if (Object.prototype.hasOwnProperty.call(dict, k)) strings[k] = dict[k];
    }
    return API;
  }

  /**
   * Translate a key. Falls back through current -> en -> the key itself, so a
   * missing translation degrades to readable English rather than blank space.
   * Supports {placeholders} via the optional vars object.
   */
  function t(key, vars) {
    var entry = strings[key];
    var out;
    if (!entry) {
      out = key;
    } else if (typeof entry === 'string') {
      out = entry;
    } else {
      out = entry[current];
      if (out === undefined || out === null || out === '') out = entry.en;
      if (out === undefined || out === null) out = key;
    }
    if (vars) {
      out = String(out).replace(/\{(\w+)\}/g, function (m, name) {
        return Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m;
      });
    }
    return out;
  }

  /** Pick the right field from a {en,ja,es} object living in page data. */
  function pick(obj, fallback) {
    if (!obj) return fallback === undefined ? '' : fallback;
    if (typeof obj === 'string') return obj;
    return obj[current] || obj.en || obj.ja || obj.es || (fallback === undefined ? '' : fallback);
  }

  function apply(root) {
    var scope = root || document;

    scope.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = t(el.getAttribute('data-i18n'));
    });

    scope.querySelectorAll('[data-i18n-html]').forEach(function (el) {
      el.innerHTML = t(el.getAttribute('data-i18n-html'));
    });

    scope.querySelectorAll('[data-i18n-attr]').forEach(function (el) {
      el.getAttribute('data-i18n-attr').split(',').forEach(function (pairRaw) {
        var pair = pairRaw.trim();
        if (!pair) return;
        var idx = pair.indexOf(':');
        if (idx < 0) return;
        el.setAttribute(pair.slice(0, idx).trim(), t(pair.slice(idx + 1).trim()));
      });
    });

    if (scope === document) {
      document.documentElement.lang = HTML_LANG[current];
      var titleKey = document.documentElement.getAttribute('data-title-key');
      if (titleKey) document.title = t(titleKey);
    }
  }

  function set(lang) {
    if (LANGS.indexOf(lang) === -1 || lang === current) return;
    current = lang;
    try { localStorage.setItem(STORE_KEY, lang); } catch (e) { /* private mode */ }
    apply();
    document.dispatchEvent(new CustomEvent('langchange', { detail: { lang: lang } }));
  }

  /* --- locale-aware formatting helpers ---------------------------------- */

  var LOCALE = { en: 'en-GB', ja: 'ja-JP', es: 'es-ES' };

  function locale() { return LOCALE[current] || 'en-GB'; }

  function formatDate(value, opts) {
    var d = (value instanceof Date) ? value : new Date(value);
    if (isNaN(d.getTime())) return '—';
    return new Intl.DateTimeFormat(locale(), opts || { day: 'numeric', month: 'short', year: 'numeric' }).format(d);
  }

  function formatNumber(n, opts) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return new Intl.NumberFormat(locale(), opts).format(n);
  }

  /** "in 3 days" / "2 days ago", localised. */
  function relativeDays(days) {
    if (days === null || days === undefined || isNaN(days)) return '—';
    var rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
    return rtf.format(Math.round(days), 'day');
  }

  var API = {
    langs: LANGS,
    label: LANG_LABEL,
    extend: extend,
    t: t,
    pick: pick,
    apply: apply,
    set: set,
    get lang() { return current; },
    locale: locale,
    formatDate: formatDate,
    formatNumber: formatNumber,
    relativeDays: relativeDays
  };

  current = detect();
  document.documentElement.lang = HTML_LANG[current];

  global.I18N = API;

  /* --- strings shared by every page ------------------------------------- */

  extend({
    'brand.name':      { en: 'Shinya Shimada',  ja: '島田 慎也',        es: 'Shinya Shimada' },

    'nav.home':        { en: 'Home',            ja: 'ホーム',           es: 'Inicio' },
    'nav.plants':      { en: 'Balcony',         ja: 'ベランダ',         es: 'Balcón' },
    'nav.library':     { en: 'Library',         ja: '書庫',             es: 'Biblioteca' },
    'nav.tokyo':       { en: 'Tokyo Today',     ja: '東京の今日',       es: 'Tokio Hoy' },
    'nav.croissants':  { en: 'Croissants',      ja: 'クロワッサン',     es: 'Croissants' },
    'nav.forza':       { en: 'Forza!',          ja: 'フォルツァ！',     es: '¡Forza!' },
    'nav.research':    { en: 'Research',        ja: 'リサーチ',         es: 'Investigación' },
    'nav.menu':        { en: 'Menu',            ja: 'メニュー',         es: 'Menú' },
    'nav.skip':        { en: 'Skip to content', ja: '本文へスキップ',   es: 'Saltar al contenido' },

    'theme.toggle':    { en: 'Toggle dark mode', ja: 'ダークモード切替', es: 'Cambiar modo oscuro' },
    'lang.label':      { en: 'Language',        ja: '言語',             es: 'Idioma' },

    'common.save':     { en: 'Save',            ja: '保存',             es: 'Guardar' },
    'common.cancel':   { en: 'Cancel',          ja: 'キャンセル',       es: 'Cancelar' },
    'common.delete':   { en: 'Delete',          ja: '削除',             es: 'Eliminar' },
    'common.edit':     { en: 'Edit',            ja: '編集',             es: 'Editar' },
    'common.add':      { en: 'Add',             ja: '追加',             es: 'Añadir' },
    'common.close':    { en: 'Close',           ja: '閉じる',           es: 'Cerrar' },
    'common.search':   { en: 'Search',          ja: '検索',             es: 'Buscar' },
    'common.loading':  { en: 'Loading…',        ja: '読み込み中…',      es: 'Cargando…' },
    'common.error':    { en: 'Something went wrong.', ja: 'エラーが発生しました。', es: 'Algo salió mal.' },
    'common.retry':    { en: 'Try again',       ja: '再試行',           es: 'Reintentar' },
    'common.all':      { en: 'All',             ja: 'すべて',           es: 'Todos' },
    'common.none':     { en: 'None',            ja: 'なし',             es: 'Ninguno' },
    'common.back':     { en: 'Back',            ja: '戻る',             es: 'Volver' },
    'common.today':    { en: 'Today',           ja: '今日',             es: 'Hoy' },
    'common.notes':    { en: 'Notes',           ja: 'メモ',             es: 'Notas' },
    'common.done':     { en: 'Done',            ja: '完了',             es: 'Hecho' },
    'common.saving':   { en: 'Saving…',         ja: '保存中…',          es: 'Guardando…' },
    'common.saved':    { en: 'Saved',           ja: '保存しました',     es: 'Guardado' },
    'common.offline':  { en: 'Offline — showing the last saved copy.', ja: 'オフライン — 最後に保存したデータを表示しています。', es: 'Sin conexión — mostrando la última copia guardada.' },

    'footer.made':     { en: 'Made with care in Tokyo.', ja: '東京で心をこめて。', es: 'Hecho con cariño en Tokio.' },
    'footer.source':   { en: 'Source',          ja: 'ソース',           es: 'Código' }
  });

})(window);
