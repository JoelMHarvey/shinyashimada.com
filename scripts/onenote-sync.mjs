#!/usr/bin/env node
/* ==========================================================================
   Pull Shin's OneNote notebooks down as HTML, via Microsoft Graph.

     node scripts/onenote-sync.mjs --list
     node scripts/onenote-sync.mjs --notebook español --out .onenote-export
     node scripts/onenote-sync.mjs --all --out .onenote-export
     node scripts/onenote-sync.mjs --all --resume     # skip pages already saved
     node scripts/onenote-sync.mjs --notebook español --section 2022_目標 --images

   There are two ways to authenticate. Either works; neither involves typing
   a password into this process.

   A. Borrowed Graph Explorer token — no Azure registration (start here)

      Microsoft's own Graph Explorer is already a registered, consented
      application, and it works with personal Microsoft accounts. A personal
      account has no Entra directory behind it, which can make registering
      your own app in the Azure portal impossible, so this is usually the
      only route that works for one.

        1. https://developer.microsoft.com/graph/graph-explorer
        2. Sign in as the account that owns the notebooks.
        3. Modify permissions -> consent to Notes.Read.
        4. Access token tab -> copy.
        5. export ONENOTE_ACCESS_TOKEN='<the token>'

      The token lasts about an hour and cannot be refreshed, so a large sync
      may need a second token — re-run with --resume and pages already on
      disk are left alone.

   B. Your own app registration — device code flow, refreshable

      Better if you will re-sync regularly, but it needs an Entra directory.

        1. https://portal.azure.com -> App registrations -> New registration
             Name:            shinyashimada-onenote-sync
             Account types:   Personal Microsoft accounts only
             Redirect URI:    leave empty
        2. Authentication -> Advanced settings ->
             "Allow public client flows" = Yes
        3. API permissions -> Add -> Microsoft Graph -> Delegated -> Notes.Read
        4. Copy the Application (client) ID into ONENOTE_CLIENT_ID.

      The script then prints a short code, the notebook's owner opens
      microsoft.com/devicelogin on any device and signs in there, and the
      refresh token is cached in .onenote-token.json (gitignored) so later
      syncs need no sign-in until it expires.

   Environment:
     ONENOTE_ACCESS_TOKEN  a Graph access token (route A)
     ONENOTE_CLIENT_ID     Azure application (client) ID (route B)
     ONENOTE_TENANT        'consumers' (default, personal accounts), 'common',
                           or a tenant GUID for a work/school account
   ========================================================================== */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const SCOPES = 'offline_access Notes.Read User.Read';
const TOKEN_CACHE = '.onenote-token.json';
const POLL_CEILING_MS = 15 * 60 * 1000;
const MAX_THROTTLE_RETRIES = 7;
/**
 * How long to wait after a 429. Graph's Retry-After is often an optimistic
 * 10 seconds while the actual cooldown runs to several minutes, so back off
 * geometrically from whichever is larger and cap it.
 */
function throttleWait(res, attempt) {
  const suggested = Number(res.headers.get('retry-after') || 0) * 1000;
  return Math.min(300_000, Math.max(suggested, 15_000) * 2 ** attempt);
}
const IMAGE_PACE_MS = 120;

/* ------------------------------------------------------------------ args */

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
/** Every occurrence of a repeatable flag, each also splittable on commas. */
const values = (name) => {
  const out = [];
  argv.forEach((arg, i) => {
    if (arg !== `--${name}`) return;
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) out.push(...next.split(',').map((s) => s.trim()).filter(Boolean));
  });
  return out;
};

const outDir = value('out', '.onenote-export');
const wantNotebook = value('notebook');
// Section filtering matters because these notebooks are mostly Shin's
// personal and work notes: pulling whole notebooks would copy hundreds of
// pages that have nothing to do with Spanish vocabulary.
const wantSections = values('section');
const listOnly = flag('list');
const syncAll = flag('all');
const resume = flag('resume');
// Page HTML only references its pictures; fetching them is a second request
// each, so it is opt-in.
const withImages = flag('images');

const clientId = process.env.ONENOTE_CLIENT_ID;
const tenant = process.env.ONENOTE_TENANT || 'consumers';

// A personal Microsoft account has no Entra directory, so registering an app
// in the Azure portal can be impossible for it. The escape hatch is to borrow
// a token from Graph Explorer, which is already registered and consented:
// paste it into ONENOTE_ACCESS_TOKEN and no client id is needed.
//
// Never pass the token as a command-line argument — argv is visible to every
// process on the machine via `ps`. Environment variable or token file only.
const pastedToken = (process.env.ONENOTE_ACCESS_TOKEN || '').trim();

if (!clientId && !pastedToken) {
  console.error('Set ONENOTE_ACCESS_TOKEN (from Graph Explorer) or ONENOTE_CLIENT_ID (from an Azure app registration).');
  console.error('See docs/onenote-import.md.');
  process.exit(1);
}
if (!listOnly && !syncAll && !wantNotebook && !wantSections.length) {
  console.error('Nothing to do. Pass --list, --all, --notebook <name>, or --section <name>.');
  process.exit(1);
}

/* ------------------------------------------------------------------ auth */

const AUTH = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`;

async function form(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body)
  });
  return { ok: res.ok, status: res.status, data: await res.json() };
}

async function cachedToken() {
  try {
    const raw = JSON.parse(await readFile(TOKEN_CACHE, 'utf8'));
    if (!raw.refresh_token) return null;
    const res = await form(`${AUTH}/token`, {
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: raw.refresh_token,
      scope: SCOPES
    });
    if (!res.ok) return null;
    await writeFile(TOKEN_CACHE, JSON.stringify(res.data, null, 2), { mode: 0o600 });
    return res.data.access_token;
  } catch {
    return null;
  }
}

async function deviceCodeToken() {
  const start = await form(`${AUTH}/devicecode`, { client_id: clientId, scope: SCOPES });
  if (!start.ok) {
    console.error('Could not start device sign-in:', start.data.error_description || start.data.error);
    process.exit(1);
  }

  const { device_code: deviceCode, user_code: userCode, verification_uri: uri, interval } = start.data;

  console.log('\n  ┌─────────────────────────────────────────────┐');
  console.log('  │  Sign in to grant read access to OneNote     │');
  console.log('  └─────────────────────────────────────────────┘\n');
  console.log(`   1. Open   ${uri}`);
  console.log(`   2. Enter  ${userCode}`);
  console.log('   3. Sign in as the account that owns the notebooks.\n');
  console.log('   Waiting…');

  const deadline = Date.now() + POLL_CEILING_MS;
  let waitMs = (interval || 5) * 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, waitMs));
    const res = await form(`${AUTH}/token`, {
      client_id: clientId,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode
    });
    if (res.ok) {
      await writeFile(TOKEN_CACHE, JSON.stringify(res.data, null, 2), { mode: 0o600 });
      console.log('   Signed in.\n');
      return res.data.access_token;
    }
    const err = res.data.error;
    if (err === 'authorization_pending') continue;
    // The server asks us to back off rather than treating this as fatal.
    if (err === 'slow_down') {
      waitMs += 5000;
      continue;
    }
    console.error('\nSign-in failed:', res.data.error_description || err);
    process.exit(1);
  }

  console.error('\nSign-in timed out.');
  process.exit(1);
}

/** Seconds left on a JWT, or null when it cannot be read. */
function expiresIn(jwt) {
  try {
    const claims = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
    return claims.exp ? claims.exp - Math.floor(Date.now() / 1000) : null;
  } catch {
    return null;
  }
}

let token;
if (pastedToken) {
  const left = expiresIn(pastedToken);
  if (left !== null && left <= 0) {
    console.error('That access token has already expired. Copy a fresh one from Graph Explorer.');
    process.exit(1);
  }
  if (left !== null) {
    console.log(`Using the pasted access token — about ${Math.floor(left / 60)} minutes left on it.`);
    if (left < 300) console.log('That is not much; if the sync dies part way through, grab a new token and re-run.');
  } else {
    console.log('Using the pasted access token.');
  }
  token = pastedToken;
} else {
  token = (await cachedToken()) || (await deviceCodeToken());
}

/* ----------------------------------------------------------------- graph */

async function graph(url, asText = false, attempt = 0) {
  const full = url.startsWith('http') ? url : GRAPH + url;
  const res = await fetch(full, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 429) {
    // Graph throttles hard on bulk reads; honour its own backoff, but give
    // up eventually. Retrying forever looks identical to a hung script, and
    // a throttle this persistent is telling us to come back later.
    if (attempt >= MAX_THROTTLE_RETRIES) {
      console.error(`\nGraph is still throttling after ${MAX_THROTTLE_RETRIES} attempts.`);
      console.error('Leave it 15-30 minutes and re-run with --resume; nothing already on disk is refetched.');
      process.exit(1);
    }
    const wait = throttleWait(res, attempt);
    console.log(`   throttled, waiting ${Math.round(wait / 1000)}s… (${attempt + 1}/${MAX_THROTTLE_RETRIES})`);
    await new Promise((r) => setTimeout(r, wait));
    return graph(url, asText, attempt + 1);
  }
  // 502/503/504 from Graph are transient — big OneNote pages routinely time
  // out on the first ask and come back fine a few seconds later.
  if (res.status >= 500 && res.status < 600 && attempt < 3) {
    const wait = 2000 * 2 ** attempt;
    console.log(`   ${res.status} on ${full.slice(-24)}, retrying in ${wait / 1000}s…`);
    await new Promise((r) => setTimeout(r, wait));
    return graph(url, asText, attempt + 1);
  }
  if (res.status === 401) {
    // With a pasted Graph Explorer token this is the expected end of the hour.
    console.error('\nGraph rejected the token (401). It has most likely expired.');
    if (pastedToken) {
      console.error('Copy a fresh one from Graph Explorer, re-export ONENOTE_ACCESS_TOKEN,');
      console.error('and re-run with --resume to pick up where this left off.');
    }
    process.exit(1);
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${full}`);
  return asText ? res.text() : res.json();
}

/**
 * An image resource, with the same bounded backoff as the rest. Returns null
 * when it cannot be had, so one unreachable picture does not stop the run.
 */
async function fetchImage(src, attempt = 0) {
  const res = await fetch(src, { headers: { Authorization: `Bearer ${token}` } });

  if (res.status === 429) {
    // Unlike the page listing, a throttled picture is not worth waiting out:
    // it is optional, `--resume` will collect it next time, and stalling the
    // whole run for one image then aborting loses the pages that did work.
    // One short retry, then defer.
    if (attempt < 1) {
      const wait = Math.min(30_000, Math.max(Number(res.headers.get('retry-after') || 0) * 1000, 10_000));
      await new Promise((r) => setTimeout(r, wait));
      return fetchImage(src, attempt + 1);
    }
    throttledInARow++;
    return null;
  }

  throttledInARow = 0;
  if (!res.ok) return null;
  return res.arrayBuffer();
}

/** Follow @odata.nextLink until the collection is exhausted. */
async function graphAll(url) {
  const out = [];
  let next = url;
  while (next) {
    const page = await graph(next);
    out.push(...(page.value || []));
    next = page['@odata.nextLink'] || null;
  }
  return out;
}

/* ------------------------------------------------------------------ sync */

/**
 * A filesystem-safe name that keeps non-Latin scripts.
 *
 * Stripping everything outside [a-z0-9] would turn every Japanese section
 * name into the same string, so notebooks like 奨学金 and 図書館 would collide
 * in one directory and overwrite each other. Keep any Unicode letter or
 * digit; replace only what a filesystem objects to. Latin accents are still
 * folded (Español -> espanol) so English-keyboard matching works.
 */
const slug = (s) =>
  String(s)
    .normalize('NFD')
    // Latin combining marks only. \p{Diacritic} would also strip the
    // Japanese dakuten and handakuten, turning ペ into ヘ.
    .replace(/[̀-ͯ]/g, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64) || 'untitled';

const notebooks = await graphAll('/me/onenote/notebooks?$select=id,displayName');

if (listOnly) {
  console.log(`\n${notebooks.length} notebook(s):\n`);
  for (const nb of notebooks) {
    const sections = await graphAll(`/me/onenote/notebooks/${nb.id}/sections?$select=id,displayName`);
    console.log(`  ${nb.displayName}`);
    for (const s of sections) {
      const pages = await graphAll(
        `/me/onenote/sections/${s.id}/pages?$select=id&$top=100`
      );
      console.log(`     ${s.displayName.padEnd(36)} ${String(pages.length).padStart(4)} pages`);
    }
  }
  process.exit(0);
}

// With --section but no notebook named, look through every notebook: a
// section name is specific enough to find on its own.
const targets = (syncAll || (!wantNotebook && wantSections.length))
  ? notebooks
  : notebooks.filter((nb) => slug(nb.displayName) === slug(wantNotebook));

if (!targets.length) {
  console.error(`No notebook matched ${JSON.stringify(wantNotebook)}. Run --list to see the names.`);
  process.exit(1);
}

/**
 * Match a section by name. Exact (slug-folded) match, or a containment test
 * on the raw name for convenience.
 *
 * Deliberately not the symmetric "either contains the other" test: these
 * notebooks hold Shin's private notes, and an over-eager match downloads
 * personal material we have no reason to copy. When in doubt, match nothing
 * and let the operator name the section exactly.
 */
const sectionWanted = (name) => {
  if (!wantSections.length) return true;
  const gotSlug = slug(name);
  const gotRaw = String(name).normalize('NFC').toLowerCase();
  return wantSections.some((w) => {
    const wantSlug = slug(w);
    const wantRaw = String(w).normalize('NFC').toLowerCase();
    if (gotSlug === wantSlug) return true;
    // Substrings only for terms long enough to be meaningful — "1" must not
    // match every section whose name happens to end in a digit.
    return wantRaw.length >= 3 && gotRaw.includes(wantRaw);
  });
};

const manifest = [];
let skippedExisting = 0;
let imagesSaved = 0;
let imageFailures = 0;
let imagesDeferred = 0;
let throttledInARow = 0;
// Once Graph is throttling steadily there is no point asking for the rest;
// the run finishes with what it has and `--resume` collects them later.
const GIVE_UP_IMAGES_AFTER = 3;
let stopFetchingImages = false;

let matchedSections = 0;

for (const nb of targets) {
  const all = await graphAll(`/me/onenote/notebooks/${nb.id}/sections?$select=id,displayName`);
  const sections = all.filter((s) => sectionWanted(s.displayName));
  if (!sections.length) continue;
  matchedSections += sections.length;
  console.log(
    `\n${nb.displayName} — ${sections.length} section(s)` +
      (sections.length === all.length ? '' : ` of ${all.length} (rest skipped)`)
  );

  for (const section of sections) {
    const pages = await graphAll(
      `/me/onenote/sections/${section.id}/pages?$select=id,title,createdDateTime,lastModifiedDateTime&$top=100`
    );
    const dir = path.join(outDir, slug(nb.displayName), slug(section.displayName));
    await mkdir(dir, { recursive: true });
    console.log(`  ${section.displayName} — ${pages.length} page(s)`);

    for (const [i, page] of pages.entries()) {
      const name = `${String(i + 1).padStart(3, '0')}-${slug(page.title || 'untitled')}.html`;
      const dest = path.join(dir, name);

      let html;
      // --resume exists because a Graph Explorer token lasts about an hour,
      // which may not cover a large notebook in one go.
      if (resume) {
        try {
          html = await readFile(dest, 'utf8');
        } catch {
          html = null;
        }
      }

      if (html === null || html === undefined) {
        try {
          html = await graph(`/me/onenote/pages/${page.id}/content?includeIDs=true`, true);
        } catch (err) {
          console.log(`    ! ${page.title}: ${err.message}`);
          continue;
        }
        await writeFile(dest, html, 'utf8');
      } else {
        skippedExisting++;
      }

      // Pull the pictures down too, keyed by the resource id in their URL so
      // the parser can match a row to the file on disk. Graph serves these
      // only to an authenticated caller, which is why they cannot simply be
      // hot-linked from the page later.
      if (withImages) {
        const dir = path.join(outDir, 'images');
        await mkdir(dir, { recursive: true });
        for (const m of html.matchAll(/<img\b[^>]*?\ssrc="([^"]+)"[^>]*>/gi)) {
          const src = m[1].replace(/&amp;/g, '&');
          const id = /resources\/([^/]+)\//.exec(src);
          if (!id) continue;
          const safe = id[1].replace(/[^A-Za-z0-9!._-]/g, '_').slice(0, 120);
          const typeAttr = /data-src-type="image\/(\w+)"/.exec(m[0]);
          const dest = path.join(dir, `${safe}.${(typeAttr?.[1] || 'jpg').replace('jpeg', 'jpg')}`);
          if (resume) {
            try { await readFile(dest); continue; } catch { /* not fetched yet */ }
          }
          if (stopFetchingImages) { imagesDeferred++; continue; }
          try {
            // A section can reference over a thousand pictures. Asking for
            // them flat out is what earns the throttling in the first place,
            // so go at a deliberate pace.
            await new Promise((r) => setTimeout(r, IMAGE_PACE_MS));
            const bytes = await fetchImage(src);
            if (!bytes) {
              if (throttledInARow >= GIVE_UP_IMAGES_AFTER) {
                stopFetchingImages = true;
                console.log('   still throttled — leaving the rest of the images for a later --resume');
                imagesDeferred++;
              } else {
                imageFailures++;
              }
              continue;
            }
            await writeFile(dest, Buffer.from(bytes));
            imagesSaved++;
          } catch {
            imageFailures++;
          }
        }
      }

      // Counting images here means the parser can flag photo-only pages
      // without re-reading every file.
      const images = (html.match(/<img\b/gi) || []).length;
      const text = html
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      manifest.push({
        notebook: nb.displayName,
        section: section.displayName,
        title: page.title,
        file: dest,
        images,
        textLength: text.length,
        modified: page.lastModifiedDateTime
      });
    }
  }
}

if (!matchedSections) {
  console.error(`\nNo section matched ${JSON.stringify(wantSections)}. Run --list to see the names.`);
  process.exit(1);
}

await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

if (withImages) {
  console.log(`${imagesSaved} image(s) saved to ${outDir}/images/` +
    (imageFailures ? `, ${imageFailures} could not be fetched` : '') +
    (imagesDeferred ? `, ${imagesDeferred} left for later` : ''));
  if (imagesDeferred) {
    console.log('Re-run the same command once the throttle clears to collect the rest.');
  }
}

const photoOnly = manifest.filter((p) => p.images > 0 && p.textLength < 120);
console.log(`\n${manifest.length} pages in ${outDir}/` + (skippedExisting ? ` (${skippedExisting} already present, left alone)` : ''));
console.log(`${photoOnly.length} look like image-only pages (will need OCR):`);
for (const p of photoOnly.slice(0, 20)) {
  console.log(`   ${p.section} / ${p.title}  (${p.images} images, ${p.textLength} chars of text)`);
}
if (photoOnly.length > 20) console.log(`   … and ${photoOnly.length - 20} more`);
