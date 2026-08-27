/* ==========================================================================
   shell.js — header, footer, theme, toasts, modals and small shared helpers.
   Every page loads i18n.js then shell.js, then its own page script.
   ========================================================================== */

(function (global) {
  'use strict';

  var THEME_KEY = 'ss.theme';

  var NAV = [
    { key: 'nav.home',       href: '/',            id: 'home' },
    { key: 'nav.plants',     href: '/plants/',     id: 'plants' },
    { key: 'nav.tokyo',      href: '/tokyo/',      id: 'tokyo' },
    { key: 'nav.croissants', href: '/croissants/', id: 'croissants' },
    { key: 'nav.italian',    href: '/italian/',    id: 'italian' },
    { key: 'nav.research',   href: '/research/',   id: 'research' }
  ];

  var LEAF_MARK =
    '<svg class="brand__mark" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<path d="M12 21c0-6 2-10 7-13-1 7-3 10-7 13Z" fill="currentColor" opacity=".85"/>' +
      '<path d="M12 21C9 16 5 14 3 9c6 0 9 3 9 9v3Z" fill="currentColor" opacity=".55"/>' +
      '<path d="M12 21v-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
    '</svg>';

  /* ------------------------------------------------------------- theme -- */

  function storedTheme() {
    try { return localStorage.getItem(THEME_KEY); } catch (e) { return null; }
  }

  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') || 'light';
  }

  function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* private mode */ }
    var btn = document.getElementById('theme-toggle');
    if (btn) btn.textContent = theme === 'dark' ? '☀' : '☾';
    document.dispatchEvent(new CustomEvent('themechange', { detail: { theme: theme } }));
  }

  function initTheme() {
    var saved = storedTheme();
    if (saved) {
      document.documentElement.setAttribute('data-theme', saved);
    } else {
      var prefersDark = global.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
    }
    // Follow the OS while the visitor has not made an explicit choice.
    if (!saved && global.matchMedia) {
      matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function (e) {
        if (!storedTheme()) document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light');
      });
    }
  }

  /* ------------------------------------------------------------ header -- */

  function renderHeader(activeId) {
    var host = document.querySelector('[data-shell="header"]');
    if (!host) return;

    var items = NAV.map(function (item) {
      var active = item.id === activeId ? ' aria-current="page"' : '';
      return '<li><a href="' + item.href + '"' + active + ' data-i18n="' + item.key + '"></a></li>';
    }).join('');

    var langButtons = I18N.langs.map(function (code) {
      return '<button type="button" data-lang="' + code + '" aria-pressed="' +
             (I18N.lang === code) + '">' + I18N.label[code] + '</button>';
    }).join('');

    host.className = 'site-header';
    host.innerHTML =
      '<div class="wrap-wide site-header__inner">' +
        '<a class="brand" href="/">' + LEAF_MARK + '<span data-i18n="brand.name"></span></a>' +
        '<nav class="site-nav" id="site-nav" aria-label="Main"><ul>' + items + '</ul></nav>' +
        '<div class="header-tools">' +
          '<div class="lang-switch" role="group" aria-label="' + esc(I18N.t('lang.label')) + '">' + langButtons + '</div>' +
          '<button type="button" class="icon-button" id="theme-toggle" data-i18n-attr="title:theme.toggle,aria-label:theme.toggle"></button>' +
          '<button type="button" class="icon-button nav-toggle" id="nav-toggle" aria-expanded="false" ' +
                  'data-i18n-attr="aria-label:nav.menu">☰</button>' +
        '</div>' +
      '</div>';

    host.querySelectorAll('[data-lang]').forEach(function (btn) {
      btn.addEventListener('click', function () { I18N.set(btn.getAttribute('data-lang')); });
    });

    document.getElementById('theme-toggle').addEventListener('click', function () {
      setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
    });

    var navToggle = document.getElementById('nav-toggle');
    var nav = document.getElementById('site-nav');
    navToggle.addEventListener('click', function () {
      var open = nav.getAttribute('data-open') === 'true';
      nav.setAttribute('data-open', String(!open));
      navToggle.setAttribute('aria-expanded', String(!open));
    });

    document.addEventListener('langchange', function () {
      host.querySelectorAll('[data-lang]').forEach(function (btn) {
        btn.setAttribute('aria-pressed', String(btn.getAttribute('data-lang') === I18N.lang));
      });
    });

    document.getElementById('theme-toggle').textContent = currentTheme() === 'dark' ? '☀' : '☾';
  }

  function renderFooter() {
    var host = document.querySelector('[data-shell="footer"]');
    if (!host) return;
    var year = new Date().getFullYear();
    host.className = 'site-footer';
    host.innerHTML =
      '<div class="wrap-wide site-footer__inner">' +
        '<span>&copy; ' + year + ' <span data-i18n="brand.name"></span></span>' +
        '<span data-i18n="footer.made"></span>' +
      '</div>';
  }

  /* ------------------------------------------------------------ toasts -- */

  function toast(message, type) {
    var host = document.querySelector('.toast-host');
    if (!host) {
      host = document.createElement('div');
      host.className = 'toast-host';
      host.setAttribute('role', 'status');
      host.setAttribute('aria-live', 'polite');
      document.body.appendChild(host);
    }
    var el = document.createElement('div');
    el.className = 'toast' + (type === 'error' ? ' toast--error' : '');
    el.textContent = message;
    host.appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity .3s';
      el.style.opacity = '0';
      setTimeout(function () { el.remove(); }, 320);
    }, type === 'error' ? 5200 : 2800);
  }

  /* ------------------------------------------------------------ helpers -- */

  function esc(str) {
    return String(str === null || str === undefined ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.slice(0, 2) === 'on' && typeof attrs[k] === 'function') {
          node.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
        } else if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) {
          node.setAttribute(k, attrs[k]);
        }
      }
    }
    (children || []).forEach(function (c) {
      if (c === null || c === undefined) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  function debounce(fn, wait) {
    var timer;
    return function () {
      var args = arguments, self = this;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(self, args); }, wait || 200);
    };
  }

  /** Day-granularity difference: whole days from today to `date` (negative = past). */
  function daysUntil(date) {
    if (!date) return null;
    var target = (date instanceof Date) ? new Date(date) : new Date(date);
    if (isNaN(target.getTime())) return null;
    var a = new Date(target.getFullYear(), target.getMonth(), target.getDate());
    var now = new Date();
    var b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((a - b) / 86400000);
  }

  function addDays(date, n) {
    var d = (date instanceof Date) ? new Date(date) : new Date(date);
    d.setDate(d.getDate() + n);
    return d;
  }

  function isoDate(date) {
    var d = (date instanceof Date) ? date : new Date(date || Date.now());
    if (isNaN(d.getTime())) return '';
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  function uid() {
    if (global.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  /** localStorage with a JSON codec that never throws. */
  var local = {
    get: function (key, fallback) {
      try {
        var raw = localStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (e) { return fallback; }
    },
    set: function (key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); return true; }
      catch (e) { return false; }
    },
    remove: function (key) {
      try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
    }
  };

  /* Tokyo's meteorological season — used by both plants and weather. */
  function tokyoSeason(date) {
    var m = (date ? new Date(date) : new Date()).getMonth() + 1;
    if (m >= 3 && m <= 5) return 'spring';
    if (m === 6 || m === 7) return 'rainy';       // 梅雨 / early summer
    if (m === 8 || m === 9) return 'summer';
    if (m >= 10 && m <= 11) return 'autumn';
    return 'winter';
  }

  function init(activeId) {
    initTheme();
    renderHeader(activeId);
    renderFooter();
    I18N.apply();
  }

  global.Shell = {
    init: init,
    setTheme: setTheme,
    currentTheme: currentTheme,
    toast: toast,
    esc: esc,
    el: el,
    debounce: debounce,
    daysUntil: daysUntil,
    addDays: addDays,
    isoDate: isoDate,
    uid: uid,
    local: local,
    tokyoSeason: tokyoSeason
  };

  initTheme();
})(window);
