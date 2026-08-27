/* ==========================================================================
   weather.js — WMO weather-code vocabulary, shared by the home strip and the
   Tokyo page so the two never describe the same sky differently.
   ========================================================================== */

(function (global) {
  'use strict';

  /* WMO 4677 codes, collapsed into the handful of states worth naming. */
  var CODE = {
    0: 'clear',
    1: 'mainlyClear', 2: 'partlyCloudy', 3: 'overcast',
    45: 'fog', 48: 'fog',
    51: 'drizzle', 53: 'drizzle', 55: 'drizzle', 56: 'drizzle', 57: 'drizzle',
    61: 'rain', 63: 'rain', 65: 'heavyRain', 66: 'rain', 67: 'heavyRain',
    71: 'snow', 73: 'snow', 75: 'heavySnow', 77: 'snow',
    80: 'showers', 81: 'showers', 82: 'heavyRain',
    85: 'snow', 86: 'heavySnow',
    95: 'thunder', 96: 'thunder', 99: 'thunder'
  };

  var ICON = {
    clear: '☀️', mainlyClear: '🌤️', partlyCloudy: '⛅', overcast: '☁️',
    fog: '🌫️', drizzle: '🌦️', rain: '🌧️', heavyRain: '🌧️',
    showers: '🌦️', snow: '🌨️', heavySnow: '❄️', thunder: '⛈️', unknown: '·'
  };

  I18N.extend({
    'wx.clear':        { en: 'Clear',          ja: '快晴',           es: 'Despejado' },
    'wx.mainlyClear':  { en: 'Mostly clear',   ja: '晴れ',           es: 'Mayormente despejado' },
    'wx.partlyCloudy': { en: 'Partly cloudy',  ja: '晴れ時々くもり', es: 'Parcialmente nublado' },
    'wx.overcast':     { en: 'Overcast',       ja: 'くもり',         es: 'Nublado' },
    'wx.fog':          { en: 'Fog',            ja: '霧',             es: 'Niebla' },
    'wx.drizzle':      { en: 'Drizzle',        ja: '霧雨',           es: 'Llovizna' },
    'wx.rain':         { en: 'Rain',           ja: '雨',             es: 'Lluvia' },
    'wx.heavyRain':    { en: 'Heavy rain',     ja: '大雨',           es: 'Lluvia fuerte' },
    'wx.showers':      { en: 'Showers',        ja: 'にわか雨',       es: 'Chubascos' },
    'wx.snow':         { en: 'Snow',           ja: '雪',             es: 'Nieve' },
    'wx.heavySnow':    { en: 'Heavy snow',     ja: '大雪',           es: 'Nieve intensa' },
    'wx.thunder':      { en: 'Thunderstorm',   ja: '雷雨',           es: 'Tormenta' },
    'wx.unknown':      { en: '—',              ja: '—',              es: '—' }
  });

  function key(code) { return CODE[code] || 'unknown'; }

  global.Weather = {
    key: key,
    describe: function (code) { return I18N.t('wx.' + key(code)); },
    icon: function (code, isDay) {
      var k = key(code);
      if (k === 'clear' && isDay === 0) return '🌙';
      return ICON[k] || ICON.unknown;
    }
  };

})(window);
