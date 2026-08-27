/* ==========================================================================
   srs.js — SM-2-lite scheduling plus answer checking for the Italian game.

   Pure and dependency-free so it can be tested in Node. The scheduler is the
   classic SuperMemo-2 recurrence with a floor on the ease factor; the answer
   checker is deliberately forgiving about the things that are not the point
   at A1 level (accents, articles, punctuation, case).
   ========================================================================== */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SRS = factory();
})(typeof globalThis !== 'undefined' ? globalThis
   : typeof self !== 'undefined' ? self
   : this, function () {
  'use strict';

  var MIN_EASE = 1.3;
  var START_EASE = 2.5;

  /* Grades the game reports, mapped onto SuperMemo's 0–5 quality scale. */
  var GRADE = { wrong: 0, hard: 3, good: 4, easy: 5 };

  function freshState() {
    return { reps: 0, lapses: 0, ease: START_EASE, interval: 0, due: null, seen: 0 };
  }

  function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  function addDays(date, n) {
    var d = new Date(date.getTime());
    d.setDate(d.getDate() + n);
    return d;
  }

  /**
   * Advance one item's schedule. `grade` is a key of GRADE.
   * A wrong answer resets the repetition count but keeps (and penalises) the
   * ease, so a persistently hard word keeps coming back sooner.
   */
  function schedule(prev, grade, now) {
    var state = prev ? Object.assign({}, prev) : freshState();
    var today = now ? new Date(now) : new Date();
    var q = GRADE[grade];
    if (q === undefined) q = GRADE.good;

    state.seen = (state.seen || 0) + 1;

    if (q < 3) {
      state.reps = 0;
      state.lapses = (state.lapses || 0) + 1;
      state.interval = 1;
    } else {
      state.reps = (state.reps || 0) + 1;
      if (state.reps === 1) state.interval = 1;
      else if (state.reps === 2) state.interval = 6;
      else state.interval = Math.round((state.interval || 1) * state.ease);
    }

    // SM-2 ease update, floored so nothing spirals to daily forever.
    var ease = state.ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
    state.ease = Math.max(MIN_EASE, Math.round(ease * 1000) / 1000);

    state.due = addDays(startOfDay(today), state.interval).toISOString();
    state.last = today.toISOString();
    return state;
  }

  function isDue(state, now) {
    if (!state || !state.due) return true;            // never studied = due
    var today = startOfDay(now ? new Date(now) : new Date());
    return new Date(state.due) <= today;
  }

  /** An item counts as "known" once it survives a week between reviews. */
  function isLearned(state) {
    return !!state && state.interval >= 7;
  }

  /**
   * Build a study session: everything overdue first (most overdue first),
   * then unseen items, then — only if still short — the items closest to
   * falling due, so a session is never padded with things just answered.
   */
  function buildSession(items, states, size, now) {
    var today = now ? new Date(now) : new Date();
    var due = [], fresh = [], rest = [];

    items.forEach(function (item) {
      var st = states[item.id];
      if (!st || !st.due) { fresh.push(item); return; }
      if (isDue(st, today)) due.push(item);
      else rest.push(item);
    });

    due.sort(function (a, b) {
      return new Date(states[a.id].due) - new Date(states[b.id].due);
    });
    rest.sort(function (a, b) {
      return new Date(states[a.id].due) - new Date(states[b.id].due);
    });

    var out = due.slice(0, size);
    for (var i = 0; out.length < size && i < fresh.length; i++) out.push(fresh[i]);
    for (var j = 0; out.length < size && j < rest.length; j++) out.push(rest[j]);
    return out;
  }

  /* ------------------------------------------------------ answer check -- */

  var ARTICLES = ['il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'uno', 'una', "l'", "un'"];

  /**
   * Normalise a typed answer: strip accents, case, punctuation and any
   * leading article, so "L'acqua", "acqua" and "l acqua" all match.
   */
  function normalise(text) {
    var s = String(text || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')   // drop accents
      .toLowerCase()
      .replace(/[.,!?;:¿¡"“”]/g, ' ')
      .replace(/[’`]/g, "'")
      .replace(/\s+/g, ' ')
      .trim();

    // A leading article carries no information at this level.
    for (var i = 0; i < ARTICLES.length; i++) {
      var a = ARTICLES[i];
      if (a.slice(-1) === "'") {
        if (s.indexOf(a) === 0) { s = s.slice(a.length).trim(); break; }
      } else if (s.indexOf(a + ' ') === 0) {
        s = s.slice(a.length + 1).trim();
        break;
      }
    }
    return s.replace(/\s+/g, ' ').trim();
  }

  /** Levenshtein distance, used only to tell "typo" from "wrong". */
  function distance(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    var prev = [], cur = [], i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur[0] = i;
      for (j = 1; j <= b.length; j++) {
        cur[j] = Math.min(
          prev[j] + 1,
          cur[j - 1] + 1,
          prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
        );
      }
      for (j = 0; j <= b.length; j++) prev[j] = cur[j];
    }
    return prev[b.length];
  }

  /**
   * Returns 'correct', 'typo' (right word, one slip) or 'wrong'.
   * A slash in the expected answer means either half will do.
   */
  function check(given, expected) {
    var got = normalise(given);
    if (!got) return 'wrong';

    var options = String(expected).split('/').map(normalise).filter(Boolean);
    for (var i = 0; i < options.length; i++) {
      if (got === options[i]) return 'correct';
    }
    for (var k = 0; k < options.length; k++) {
      var tolerance = options[k].length <= 4 ? 1 : 2;
      if (distance(got, options[k]) <= tolerance) return 'typo';
    }
    return 'wrong';
  }

  return {
    GRADE: GRADE,
    MIN_EASE: MIN_EASE,
    freshState: freshState,
    schedule: schedule,
    isDue: isDue,
    isLearned: isLearned,
    buildSession: buildSession,
    normalise: normalise,
    check: check
  };
});
