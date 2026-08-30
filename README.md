# shinyashimada.com

A rebuild of the old WordPress site as a static, trilingual site on Netlify,
with a small serverless backend for the things that need to remember state.

Six sections:

| Section | What it is |
|---|---|
| **The Library** (`/library/`) | The books Shin and Joel own between them — whose each one is, which shelf it sits on, whether anyone has read it. An ISBN or a title is enough to add one: the rest comes from Open Library and Google Books. Shared with joelmharvey.com. |
| **The Balcony** (`/plants/`) | Plant inventory with per-species care schedules — watering that shifts with the Tokyo season and the live forecast, plus pruning and repotting windows. Synced between devices. |
| **Tokyo Today** (`/tokyo/`) | Current conditions, a 24-hour temperature chart and a seven-day outlook, read as *balcony* weather, alongside headlines in the language you are reading in. |
| **Croissant Hunt** (`/croissants/`) | A six-criterion tasting log for Tokyo pain au chocolat that produces a leaderboard. Nothing is pre-rated. |
| **Italian Game** (`/italian/`) | 128 A1 phrases, four question modes, SM-2 spaced repetition. Playable from English, Japanese or Spanish. |
| **Research Library** (`/research/`) | A blank instance of the Research Hub shell from joelmharvey.com — every screen, no content. |

Everything is in **English, 日本語 and Español**, switchable from the header.

---

## Running it locally

No build step. Any static server works for the pages:

```bash
npm run serve          # http://127.0.0.1:8888
```

The three API routes (`/api/weather`, `/api/news`, `/api/store`) are Netlify
Functions, so to exercise those you need the Netlify CLI:

```bash
npm install
npx netlify dev
```

Without a backend the site still works: the weather and news panels show an
honest "could not reach" state, and the plant inventory falls back to
device-only storage.

## Deploying to Netlify

1. **Connect this repository.** Leave **Base directory**, **Build command**,
   **Publish directory** and **Functions directory** empty in the Netlify UI —
   `netlify.toml` supplies all of them (publish `.`, functions in
   `netlify/functions`, `npm install --omit=dev`). Values typed into the UI
   override the file, which gets confusing later.
2. **Set the environment variables** below.
3. **Point the domain.** In Netlify, add `shinyashimada.com` as a custom domain,
   then at your registrar either delegate to Netlify DNS (change the
   nameservers) or, if you keep DNS where it is, add Netlify's `ALIAS`/`ANAME`
   for the apex and a `CNAME` for `www`. Netlify issues the certificate once
   the record resolves.

### Environment variables

| Variable | Needed for | Notes |
|---|---|---|
| `DATABASE_URL` | Plant + tasting sync | Postgres connection string. A free Neon or Supabase database is plenty. The table is created on first use. |
| `SITE_PASSCODE` | Protecting the data | A shared passphrase. Required for **all writes**, for **reading** anything except croissant tastings (so the plant inventory and the library are private while the croissant leaderboard is public), and for the book lookups. Leave it unset and the store is wide open; set it before putting anything real in. |
| `TRELLO_KEY`, `TRELLO_TOKEN` | Trello sync (optional) | Turns overdue balcony jobs into Trello cards. See below. |
| `CAMERA_STREAM_URL`, `CAMERA_LABEL`, `CAMERA_MODE` | Live balcony camera (optional) | The relay's public URL. Served only to passcode holders — see `homelab/`. |
| `ALLOWED_ORIGINS` | Sharing the library (optional) | Comma-separated origins allowed to call the API cross-origin. Defaults to joelmharvey.com and this site; setting it replaces that list entirely. |

Neither is required for the site to deploy. Without `DATABASE_URL` the store
returns `503 no-database` and the plant page quietly runs device-only.

### The API routes

- `GET /api/weather` — Open-Meteo forecast for Tokyo plus derived balcony
  advisories (frost, heat, wind, heavy rain, UV, dry spell). No API key. Cached
  10 minutes in the function and at the CDN edge.
- `GET /api/news?lang=en|ja|es` — public RSS from NHK World, The Japan Times,
  Kyodo (en); NHK and Asahi (ja); NHK World (es). Feeds are fetched in
  parallel, deduped by URL and normalised title, and a dead feed is skipped
  rather than failing the request. Spanish falls back to the English wire and
  says so in the UI.
- `GET|POST /api/store` — the synced collections (`plants`, `tastings`,
  `books`). See `schema.sql`.
- `GET /api/books?isbn=…` or `?q=…` — book metadata. Asks Open Library and
  Google Books at once and folds the two answers into one record, so a title
  one knows the cover for and the other knows the blurb for comes back
  complete. No API key; passcode-gated so it is not left as an open lookup
  proxy. Cached an hour.

`/api/store` and `/api/books` answer cross-origin requests from an allowlist
(`netlify/lib/cors.mjs`), which is how joelmharvey.com shows the same library.
An allowlist rather than `*`, because these endpoints take a passcode header.

## The shared library

One shelf, two front doors. The records live in the `books` collection of this
site's Postgres; `/library/` here and `/library/` on joelmharvey.com are two
views of the same rows, and either can add, edit or delete.

**Getting the inventory in.** `data/library-seed.json` holds 319 books
catalogued from photographs of the shelves — title, author, category, shelf,
and how confident the reading was. When the library is empty the page offers to
import it; importing twice is harmless, because rows already on the shelf by
title and author are skipped.

Nothing else was in that source, so nothing else is claimed: no publisher,
year, page count, ISBN or cover was invented to fill the columns out.

**Filling the gaps.** *Fill in the gaps* asks the catalogues about every book
missing a publisher, year, cover or blurb, one at a time with a progress bar
you can stop. Two rules keep it honest:

- It only ever writes into **blank** fields. Anything already recorded — and
  everything that is ours to say: notes, rating, whose it is, status, shelf —
  is never overwritten.
- Without an ISBN a lookup is only a guess at a title, and some rows are
  misreadings from the shelf photos ("Hedro", "Stella Artois"). A title-only
  answer is dropped unless it recognisably matches the book that was asked
  about, so a bad row stays blank rather than acquiring a confident wrong
  identity.

**Needs checking.** The 57 rows the shelf-photo pass was less than certain
about are marked, counted and filterable, so they can be confirmed by eye
rather than quietly trusted.

**Covers** come from the catalogues as URLs, which cost nothing to store. A
photo taken instead is downscaled and compressed until the record fits the
store's 64 KB budget, exactly as the balcony does for plants.

## Trello sync (optional)

Overdue balcony jobs become cards on a Trello list, and a card ticked off in
Trello is logged back onto the plant. Both halves matter: without the second,
Shin ticks a card, the site still thinks the plant is thirsty, and the card
comes straight back tomorrow.

A task is matched to its card by a hidden marker in the card description
(`[balcony:<plantId>:<taskType>]`), so a daily run never reposts a job that
already has an open card — one card per job, however late it gets.

**Setup**

1. On Trello's Power-Up admin page, create a Power-Up and generate an **API
   key**; from the same page, generate a **token** for your account.
2. The token needs **read and write** scope — cards are created, and completed
   ones are archived. Set an expiry you are comfortable with; when it lapses,
   the panel says so rather than failing silently.
3. Put both in Netlify as `TRELLO_KEY` and `TRELLO_TOKEN`, then **redeploy** —
   environment changes do not reach functions already running.
4. On the site: Balcony → Data → *Trello sync…*, pick the board and list, choose
   the card language, and switch on the morning sync.

**`SITE_PASSCODE` is mandatory here.** `/api/trello` refuses to run without it
and returns 503, even though the rest of the site works happily without one. A
Trello token can see every board the account has, so leaving that endpoint open
would expose far more than this site's own data.

The scheduled function runs at 21:00 UTC — 06:00 in Tokyo, so the cards are
waiting before anyone goes out to the balcony. It does nothing at all until the
sync is switched on and a list chosen, and it is idempotent, so a repeated run
costs nothing.

## Live balcony camera (optional)

A Tapo camera on the home network can appear at the top of the balcony page.
It needs a small always-on relay at home, because a camera's LAN address is
unreachable from the internet and browsers do not play RTSP — two separate
blockers, and fixing one does not fix the other. `homelab/` has the compose
file and the full setup.

The site side is one environment variable, `CAMERA_STREAM_URL`, handed out
only to callers holding the passcode. `/api/camera` refuses to run at all
without `SITE_PASSCODE`, for the same reason `/api/trello` does: it returns a
route into a home network.

Two deliberate behaviours:

- **The stream does not start on its own.** It waits for a click, and stops
  when the tab is hidden. Auto-playing a live feed spends mobile data and
  holds the home tunnel open for someone who opened the page to check
  watering.
- **The card hides itself entirely** when no camera is configured or the
  device is not unlocked, rather than showing an error box on every visit.

`homelab/README.md` is honest about the limit: gating the URL narrows who
learns it, but anyone who does learn it can open the stream directly. That is
a reasonable trade for a fixed shot of some pots and would not be for a camera
indoors.

## Editing the content

The three data files are meant to be edited directly — no code changes needed:

- `data/species.json` — 34 balcony plants with trilingual names, seasonal
  watering intervals, pruning/repotting months and a care tip.
- `data/croissants.json` — the six judging criteria (with weights) and the
  bakery shortlist.
- `data/italian.json` — the 128-phrase A1 deck across 12 topics.

## How the syncing works

Each record carries `{ id, updatedAt, deleted }`. The browser keeps the whole
collection in `localStorage` and renders from that, so the balcony works with
no signal; edits are pushed to Postgres when possible and merged back
last-write-wins on `updatedAt`. Deletions are tombstones so they propagate
instead of resurrecting. The Balcony page can export and re-import the whole
collection as JSON for backups.

Whether a write needs a passcode is the **server's** decision, not the
client's: with `SITE_PASSCODE` unset the store accepts anonymous writes and
the browser sends them. The client only stops trying once the server has
actually answered `401`, and it tries again as soon as a passcode is entered,
so nothing queued is ever lost. `tests/browser-sync.mjs` covers both setups.

## Tests

```bash
npm test              # pure logic: care scheduling, SRS, RSS parsing, Trello sync, camera, book metadata + CORS (216 assertions)
npm run serve &       # browser tests need the site served
npm run test:browser  # page smoke, mobile overflow, sync behaviour, and the app flows
```

`npm test` needs nothing but Node. The browser suite needs Playwright
(`npm install`) and a server on port 8899 — start one with
`npx http-server -p 8899 -c-1 .`.

`tests/lockfile.test.mjs` guards the lockfile itself. It exists because a
Playwright symlink into `node_modules`, added locally so the browser tests
could resolve it, was swept up by `npm install` and recorded as a linked
package pointing at an absolute path on that machine. It installed cleanly
there — the path existed — and broke the deploy where it did not. If you ever
link a package into `node_modules` by hand, regenerate the lockfile with
`npm install --package-lock-only` from a clean `node_modules`, and let that
test tell you whether it is safe to commit.

## Things worth knowing

- **The book catalogues were never reachable from the machine this was built
  on.** Open Library is blocked by that sandbox's egress proxy and Google Books
  was over its daily quota there, so `/api/books` has only ever been exercised
  against recorded responses and stubs. The parsing, the merge, the passcode
  gate, the CORS allowlist and every UI path are covered by tests; the live
  round trip to the two catalogues is the one thing that wants checking on the
  deployed site.

- **The bakery shortlist is a starting point, not a verified guide.** It lists
  real Tokyo bakeries known for viennoiserie, but opening days change and not
  every one of them has pain au chocolat on the counter every day. Check before
  travelling, and edit `data/croissants.json` freely. No scores are pre-filled:
  a shop stays "to try" until somebody actually tastes it.
- **Watering intervals are a guide, not a rule.** They shift with the Tokyo
  season and shorten in a heatwave or a dry spell, but a finger in the soil
  beats the schedule. Any plant can override the interval.
- **The news feeds are public RSS.** Publishers change feed URLs occasionally;
  if a source goes quiet, the others carry the page and the URL is one line to
  fix in `netlify/functions/news.mjs`.

## Layout

```
shinyashimada.com/
├── index.html, 404.html
├── plants/ library/ tokyo/ croissants/ italian/ research/
├── assets/
│   ├── css/    site.css (design system) + one file per page
│   └── js/     i18n · shell · store · care · srs · charts · weather + page scripts
├── data/       species.json · croissants.json · italian.json · library-seed.json
├── netlify/functions/   weather.mjs · news.mjs · store.mjs · books.mjs · …
├── netlify/lib/         db · records · books · cors · trello · balcony
├── tests/
├── schema.sql
└── netlify.toml
```

`assets/js/care.js` (watering and pruning schedules) and `assets/js/srs.js`
(spaced repetition and answer checking) are pure modules with no DOM
dependency, which is why they are the parts under unit test. The same holds
for `netlify/lib/books.mjs`: all the catalogue parsing lives there, so it can
be tested against recorded responses with no network.
