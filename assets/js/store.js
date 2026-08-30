/* ==========================================================================
   store.js — offline-first synced collections.

   Every record is a plain object carrying { id, updatedAt, deleted }. The
   local copy in localStorage is the source of truth for rendering, so the
   balcony works with no signal; the Netlify `store` function (Postgres) is
   the source of truth for sharing between devices.

   Conflict rule: last write wins on `updatedAt`. For a two-person plant diary
   that is both correct enough and easy to reason about.
   ========================================================================== */

(function (global) {
  'use strict';

  var API_URL     = '/api/store';
  var PASS_KEY    = 'ss.passcode';
  var CACHE_KEY   = function (name) { return 'ss.cache.' + name; };
  var DIRTY_KEY   = function (name) { return 'ss.dirty.' + name; };
  var SYNCED_KEY  = function (name) { return 'ss.synced.' + name; };

  var L = Shell.local;

  /* The store caps a single write, so a large backlog goes up in batches
     rather than one oversized request that would be refused whole. */
  var PUSH_BATCH = 400;

  /* -------------------------------------------------------------- auth -- */

  /* Bumped whenever the stored passcode changes, so a collection that was
     rejected with a 401 knows to try again rather than staying local forever. */
  var authEpoch = 0;

  var auth = {
    get: function () { return L.get(PASS_KEY, ''); },
    set: function (code) { L.set(PASS_KEY, code || ''); authEpoch++; },
    has: function () { return !!auth.get(); },
    clear: function () { L.remove(PASS_KEY); authEpoch++; }
  };

  /* ------------------------------------------------------------ helpers -- */

  function now() { return new Date().toISOString(); }

  function byId(list) {
    var map = Object.create(null);
    list.forEach(function (r) { map[r.id] = r; });
    return map;
  }

  function newer(a, b) {
    // Returns true when `a` should win over `b`.
    if (!b) return true;
    if (!a) return false;
    return String(a.updatedAt || '') > String(b.updatedAt || '');
  }

  /* ----------------------------------------------------------- request -- */

  function request(method, body, query) {
    var url = API_URL + (query || '');
    var headers = { 'Content-Type': 'application/json' };
    var code = auth.get();
    if (code) headers['X-Store-Passcode'] = code;

    return fetch(url, {
      method: method,
      headers: headers,
      body: body ? JSON.stringify(body) : undefined
    }).then(function (res) {
      return res.text().then(function (text) {
        var payload = null;
        try { payload = text ? JSON.parse(text) : null; } catch (e) { payload = null; }
        if (!res.ok) {
          var err = new Error((payload && payload.error) || ('HTTP ' + res.status));
          err.status = res.status;
          err.code = payload && payload.code;
          throw err;
        }
        return payload || {};
      });
    });
  }

  /* -------------------------------------------------------- collection -- */

  /* One live instance per collection. Handing out a second object for the
     same name would give it its own dirty list and its own back-off state,
     so the two copies would double-push and disagree about what still needs
     syncing. */
  var instances = Object.create(null);

  function open(name) {
    if (instances[name]) return instances[name];

    var records = L.get(CACHE_KEY(name), []);
    var dirty   = L.get(DIRTY_KEY(name), []);
    var listeners = [];
    var state = {
      mode: 'unknown',      // 'cloud' | 'local' | 'unknown'
      syncing: false,
      lastSync: L.get(SYNCED_KEY(name), null),
      lastError: null,
      unauthorisedAt: null  // authEpoch at which the server last returned 401
    };

    if (!Array.isArray(records)) records = [];
    if (!Array.isArray(dirty)) dirty = [];

    function persist() {
      L.set(CACHE_KEY(name), records);
      L.set(DIRTY_KEY(name), dirty);
    }

    function emit() {
      listeners.forEach(function (fn) {
        try { fn(api.items(), api.status()); } catch (e) { console.error(e); }
      });
    }

    function markDirty(id) {
      if (dirty.indexOf(id) === -1) dirty.push(id);
    }

    var api = {
      name: name,

      /** Live records, tombstones removed. */
      items: function () {
        return records.filter(function (r) { return !r.deleted; });
      },

      raw: function () { return records.slice(); },

      get: function (id) {
        for (var i = 0; i < records.length; i++) if (records[i].id === id) return records[i];
        return null;
      },

      /** Insert or update. Returns the stored record. */
      put: function (obj) {
        var rec = Object.assign({}, obj);
        if (!rec.id) rec.id = Shell.uid();
        rec.updatedAt = now();
        rec.deleted = false;

        var idx = -1;
        for (var i = 0; i < records.length; i++) if (records[i].id === rec.id) { idx = i; break; }
        if (idx === -1) {
          rec.createdAt = rec.createdAt || rec.updatedAt;
          records.push(rec);
        } else {
          rec.createdAt = records[idx].createdAt || rec.updatedAt;
          records[idx] = rec;
        }

        markDirty(rec.id);
        persist();
        emit();
        api.push();
        return rec;
      },

      /**
       * Insert or update many records in one go. `put` pushes after every
       * write, which is right for a single edit and badly wrong for an
       * import: 300 books would mean 300 requests. This writes them all
       * locally, then pushes once.
       */
      putMany: function (list) {
        var stamp = now();
        (list || []).forEach(function (obj) {
          var rec = Object.assign({}, obj);
          if (!rec.id) rec.id = Shell.uid();
          rec.updatedAt = stamp;
          rec.deleted = false;

          var idx = -1;
          for (var i = 0; i < records.length; i++) if (records[i].id === rec.id) { idx = i; break; }
          if (idx === -1) {
            rec.createdAt = rec.createdAt || stamp;
            records.push(rec);
          } else {
            rec.createdAt = records[idx].createdAt || stamp;
            records[idx] = rec;
          }
          markDirty(rec.id);
        });
        persist();
        emit();
        return api.push();
      },

      /** Tombstone a record so the deletion propagates to other devices. */
      remove: function (id) {
        for (var i = 0; i < records.length; i++) {
          if (records[i].id === id) {
            records[i] = { id: id, deleted: true, updatedAt: now(), createdAt: records[i].createdAt };
            markDirty(id);
            persist();
            emit();
            api.push();
            return true;
          }
        }
        return false;
      },

      /** Replace the whole collection locally (used by import). */
      replaceAll: function (list) {
        var stamp = now();
        records = list.map(function (r) {
          var rec = Object.assign({}, r);
          if (!rec.id) rec.id = Shell.uid();
          rec.updatedAt = stamp;
          rec.deleted = !!rec.deleted;
          return rec;
        });
        dirty = records.map(function (r) { return r.id; });
        persist();
        emit();
        return api.push();
      },

      onChange: function (fn) {
        listeners.push(fn);
        return function () {
          var i = listeners.indexOf(fn);
          if (i !== -1) listeners.splice(i, 1);
        };
      },

      status: function () {
        return {
          mode: state.mode,
          syncing: state.syncing,
          pending: dirty.length,
          lastSync: state.lastSync,
          lastError: state.lastError,
          authed: auth.has()
        };
      },

      /** Send dirty records upstream. Silently no-ops when there is nothing to do. */
      push: function () {
        if (!dirty.length) return Promise.resolve(false);

        /* Whether a passcode is needed is the server's call, not ours: with
           SITE_PASSCODE unset the store accepts anonymous writes, and an
           earlier version refused to send them, so nothing ever synced.
           Try the write; only stand down once the server has actually said
           401, and try again as soon as the passcode changes. */
        if (state.unauthorisedAt === authEpoch) {
          state.mode = 'local';
          emit();
          return Promise.resolve(false);
        }

        var pending = dirty.slice();
        var sent = [];

        state.syncing = true;
        emit();

        /* One batch at a time, remembering what landed: if the fourth request
           fails, the first three are still saved and only the rest stay
           dirty. */
        function sendFrom(i) {
          if (i >= pending.length) return Promise.resolve(true);
          var ids = pending.slice(i, i + PUSH_BATCH);
          var payload = ids
            .map(function (id) { return api.get(id); })
            .filter(Boolean);
          if (!payload.length) {
            sent = sent.concat(ids);
            return sendFrom(i + PUSH_BATCH);
          }
          return request('POST', { collection: name, records: payload }).then(function () {
            sent = sent.concat(ids);
            return sendFrom(i + PUSH_BATCH);
          });
        }

        return sendFrom(0)
          .then(function () {
            // Drop only the ids we actually sent; anything edited meanwhile stays dirty.
            dirty = dirty.filter(function (id) { return sent.indexOf(id) === -1; });
            state.mode = 'cloud';
            state.lastError = null;
            state.unauthorisedAt = null;
            persist();
            return true;
          })
          .catch(function (err) {
            // Whatever did land is not sent twice.
            if (sent.length) {
              dirty = dirty.filter(function (id) { return sent.indexOf(id) === -1; });
              persist();
            }
            state.lastError = err;
            if (err.status === 401) state.unauthorisedAt = authEpoch;
            if (err.status === 401 || err.status === 503 || err.code === 'no-database') state.mode = 'local';
            return false;
          })
          .then(function (ok) {
            state.syncing = false;
            emit();
            return ok;
          });
      },

      /** Fetch remote records and merge them in. */
      pull: function () {
        state.syncing = true;
        emit();

        return request('GET', null, '?collection=' + encodeURIComponent(name))
          .then(function (payload) {
            var remote = (payload && payload.records) || [];
            var localMap = byId(records);
            var changed = false;

            remote.forEach(function (r) {
              if (!r || !r.id) return;
              var mine = localMap[r.id];
              // A record we have not yet pushed must not be clobbered by a stale copy.
              if (dirty.indexOf(r.id) !== -1 && !newer(r, mine)) return;
              if (newer(r, mine)) {
                if (mine) {
                  records[records.indexOf(mine)] = r;
                } else {
                  records.push(r);
                }
                changed = true;
              }
            });

            state.mode = 'cloud';
            state.lastError = null;
            state.lastSync = now();
            L.set(SYNCED_KEY(name), state.lastSync);
            if (changed) persist();
            return changed;
          })
          .catch(function (err) {
            state.lastError = err;
            if (err.status === 401) state.unauthorisedAt = authEpoch;
            if (err.status === 401 || err.status === 503 || err.code === 'no-database') state.mode = 'local';
            return false;
          })
          .then(function (changed) {
            state.syncing = false;
            emit();
            return changed;
          });
      },

      /** Push local edits, then pull remote ones. */
      sync: function () {
        return api.push().then(function () { return api.pull(); });
      },

      /** Everything as portable JSON, for backups. */
      exportJSON: function () {
        return JSON.stringify({
          collection: name,
          exportedAt: now(),
          records: api.items()
        }, null, 2);
      }
    };

    instances[name] = api;
    return api;
  }

  /** Probe the backend so the UI can say whether cloud sync is live. */
  function health() {
    return request('GET', null, '?health=1')
      .then(function (p) { return { ok: true, database: !!(p && p.database), authRequired: !!(p && p.authRequired) }; })
      .catch(function (err) { return { ok: false, database: false, error: err }; });
  }

  global.Store = { open: open, auth: auth, health: health };

})(window);
