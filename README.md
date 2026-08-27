# shinyashimada.com

A rebuild of the old WordPress site as a static, trilingual site on Netlify,
with a small serverless backend for the things that need to remember state.

Five sections:

| Section | What it is |
|---|---|
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
| `SITE_PASSCODE` | Protecting the data | A shared passphrase. Required for **all writes**, and for **reading** anything except croissant tastings — so the plant inventory is private while the croissant leaderboard is public. Leave it unset and the store is wide open; set it before putting anything real in. |

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
- `GET|POST /api/store` — the synced collections. See `schema.sql`.

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

## Tests

```bash
npm test              # pure logic: care scheduling, SRS, RSS parsing (102 assertions)
npm run serve &       # browser tests need the site served
npm run test:browser  # page smoke, mobile overflow, and the three app flows
```

`npm test` needs nothing but Node. The browser suite needs Playwright
(`npm install`) and a server on port 8899 — start one with
`npx http-server -p 8899 -c-1 .`.

## Things worth knowing

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
├── plants/ tokyo/ croissants/ italian/ research/
├── assets/
│   ├── css/    site.css (design system) + one file per page
│   └── js/     i18n · shell · store · care · srs · charts · weather + page scripts
├── data/       species.json · croissants.json · italian.json
├── netlify/functions/   weather.mjs · news.mjs · store.mjs
├── tests/
├── schema.sql
└── netlify.toml
```

`assets/js/care.js` (watering and pruning schedules) and `assets/js/srs.js`
(spaced repetition and answer checking) are pure modules with no DOM
dependency, which is why they are the parts under unit test.
