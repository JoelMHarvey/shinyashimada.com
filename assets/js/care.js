/* ==========================================================================
   care.js — when does a plant next need something?

   Pure scheduling logic with no DOM and no globals, so it can be exercised
   directly in Node. Everything time-dependent arrives through `opts.now`,
   which means the tests can stand in any month of the year.

   Three shapes of schedule:
     interval  — watering: last done + N days, where N varies by season
     seasonal  — feeding: an interval, but only during the growing seasons
     window    — pruning and repotting: a set of months in which the job is
                 done at all. You prune a hydrangea in July or you wait a year.
   ========================================================================== */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Care = factory();
})(typeof globalThis !== 'undefined' ? globalThis
   : typeof self !== 'undefined' ? self
   : this, function () {
  'use strict';

  var SEASONS = ['spring', 'rainy', 'summer', 'autumn', 'winter'];

  /* A pruning counts for this window for 90 days: long enough to cover a
     two-month window, short enough that a spring and an autumn prune of the
     same rosemary are still counted as two separate jobs. */
  var PRUNE_WINDOW_DAYS = 90;
  /* Repotting is a roughly-every-other-year job for most balcony pots. */
  var REPOT_MIN_DAYS = 500;

  var CARE_FIELD = {
    water: 'watered',
    fertilise: 'fertilised',
    prune: 'pruned',
    repot: 'repotted'
  };

  function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  /** Whole days from `now` to `date`; negative means the date has passed. */
  function daysBetween(date, now) {
    var a = startOfDay(date instanceof Date ? date : new Date(date));
    var b = startOfDay(now);
    if (isNaN(a.getTime())) return null;
    return Math.round((a - b) / 86400000);
  }

  function addDays(date, n) {
    var d = new Date(date instanceof Date ? date.getTime() : new Date(date).getTime());
    d.setDate(d.getDate() + n);
    return d;
  }

  /** Tokyo's growing calendar, which is not the same as the meteorological one. */
  function seasonOf(date) {
    var m = date.getMonth() + 1;
    if (m >= 3 && m <= 5) return 'spring';
    if (m === 6 || m === 7) return 'rainy';
    if (m === 8 || m === 9) return 'summer';
    if (m >= 10 && m <= 11) return 'autumn';
    return 'winter';
  }

  /** First day of the next month drawn from `months`, searching from `from`. */
  function nextWindow(months, from) {
    if (!months || !months.length) return null;
    for (var i = 0; i < 24; i++) {
      var probe = new Date(from.getFullYear(), from.getMonth() + i, 1);
      if (months.indexOf(probe.getMonth() + 1) !== -1) return probe;
    }
    return null;
  }

  function create(opts) {
    var options = opts || {};
    var speciesById = options.speciesById || {};
    var nowFn = options.now || function () { return new Date(); };
    var weatherFactorFn = options.weatherFactor || function () { return 1; };

    function now() { return nowFn(); }
    function speciesOf(plant) {
      return plant && plant.speciesId ? speciesById[plant.speciesId] || null : null;
    }

    function daysUntil(date) { return daysBetween(date, now()); }
    function daysSince(date) {
      var d = daysUntil(date);
      return d === null ? null : -d;
    }

    /** Days between waterings, given the season and the current forecast. */
    function waterIntervalDays(plant) {
      if (plant.waterEvery) return plant.waterEvery;
      var sp = speciesOf(plant);
      var base = (sp && sp.water && sp.water[seasonOf(now())]) || 7;
      return Math.max(1, Math.round(base * weatherFactorFn()));
    }

    function task(type, date, extra) {
      var days = daysUntil(date);
      var state = days < 0 ? 'overdue'
        : days === 0 ? 'today'
        : days <= 3 ? 'soon'
        : 'later';
      var t = { type: type, date: date, days: days, state: state };
      if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) t[k] = extra[k];
      return t;
    }

    function waterTask(plant) {
      var last = plant.care && plant.care.watered;
      if (!last) return task('water', now(), { never: true });
      return task('water', addDays(last, waterIntervalDays(plant)));
    }

    function fertiliseTask(plant) {
      var sp = speciesOf(plant);
      var every = plant.fertiliseEvery || (sp && sp.fertiliseDays);
      if (!every) return null;

      var seasons = (sp && sp.fertiliseSeasons) || SEASONS;
      if (seasons.indexOf(seasonOf(now())) === -1) {
        return { type: 'fertilise', resting: true, state: 'resting', days: null, date: null };
      }
      var last = plant.care && plant.care.fertilised;
      if (!last) return task('fertilise', now(), { never: true });
      return task('fertilise', addDays(last, every));
    }

    /**
     * Window jobs. Inside the window and not yet done for it -> due now.
     * Otherwise the answer is the first day of the next window, which may be
     * next year.
     */
    function windowTask(type, months, lastDate, minGapDays) {
      if (!months || !months.length) return null;
      var today = now();
      var inWindow = months.indexOf(today.getMonth() + 1) !== -1;

      if (inWindow) {
        var since = lastDate ? daysSince(lastDate) : null;
        var doneThisWindow = since !== null && since <= minGapDays;
        if (!doneThisWindow) {
          return task(type, today, { never: !lastDate, inWindow: true });
        }
      }

      var next = nextWindow(months, new Date(today.getFullYear(), today.getMonth() + 1, 1));
      return next ? task(type, next) : null;
    }

    function pruneTask(plant) {
      var sp = speciesOf(plant);
      var months = plant.pruneMonths || (sp && sp.pruneMonths) || [];
      return windowTask('prune', months, plant.care && plant.care.pruned, PRUNE_WINDOW_DAYS);
    }

    function repotTask(plant) {
      var sp = speciesOf(plant);
      var months = plant.repotMonths || (sp && sp.repotMonths) || [];
      return windowTask('repot', months, plant.care && plant.care.repotted, REPOT_MIN_DAYS);
    }

    function tasksFor(plant) {
      var all = [waterTask(plant), fertiliseTask(plant), pruneTask(plant), repotTask(plant)];
      return all.filter(function (t) { return !!t; });
    }

    /** The most pressing job that is due now or overdue, else null. */
    function urgency(plant) {
      var live = tasksFor(plant).filter(function (t) {
        return t.days !== null && t.days <= 0;
      });
      if (!live.length) return null;
      live.sort(function (a, b) { return a.days - b.days; });
      return live[0];
    }

    return {
      CARE_FIELD: CARE_FIELD,
      seasonOf: function (d) { return seasonOf(d || now()); },
      speciesOf: speciesOf,
      waterIntervalDays: waterIntervalDays,
      tasksFor: tasksFor,
      urgency: urgency,
      daysUntil: daysUntil,
      daysSince: daysSince
    };
  }

  return {
    create: create,
    SEASONS: SEASONS,
    CARE_FIELD: CARE_FIELD,
    PRUNE_WINDOW_DAYS: PRUNE_WINDOW_DAYS,
    REPOT_MIN_DAYS: REPOT_MIN_DAYS,
    seasonOf: seasonOf,
    addDays: addDays,
    daysBetween: daysBetween
  };
});
