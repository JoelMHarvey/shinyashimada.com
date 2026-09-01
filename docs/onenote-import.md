# Importing Shin's Spanish vocabulary from OneNote

The vocabulary lives in OneNote notebooks on Shin's personal OneDrive. This
document covers getting it out of there and into Postgres, where `/api/vocab`
can serve it to the game.

The pipeline is four steps, deliberately separate so a bad result at any one
of them can be inspected before it reaches the database:

```
OneNote  --(1) onenote-sync--> HTML files
         --(2) parse-vocab---> normalised JSON
         --(3) review by hand-> corrected JSON
         --(4) import-vocab---> Postgres
```

## Authenticating

Two routes. Neither needs a password typed into this machine.

### Route A: borrow a Graph Explorer token (start here)

Shin's account is a **personal Microsoft account**. Personal accounts have no
Entra directory behind them, and the Azure portal's App registrations blade
needs one — trying it without a directory fails with:

```
AADSTS50058: A silent sign-in request was sent but no user is signed in.
```

That error is the portal failing to get a token for the directory resource, not
a problem with your credentials, and signing in again or using a private window
does not fix it.

Graph Explorer sidesteps the whole thing. It is Microsoft's own tool, already
registered and already consented, and it supports personal accounts.

1. Go to <https://developer.microsoft.com/graph/graph-explorer>.
2. Sign in as **the account that owns the notebooks** — Shin's. Graph's
   `/me/onenote` only reaches the signed-in account's own notebooks, so
   signing in as someone the notebook was merely *shared with* returns an
   empty list.
3. **Modify permissions** → find **Notes.Read** → **Consent**.
4. Run `GET https://graph.microsoft.com/v1.0/me/onenote/notebooks` to confirm
   the notebooks come back.
5. Open the **Access token** tab and copy the token.

Then, locally — note the single quotes, and mind that this puts a live
credential in your shell history:

```bash
export ONENOTE_ACCESS_TOKEN='<paste the token>'
```

The token is valid for about an hour and **cannot be refreshed**. The script
reads its expiry and tells you how long is left. If a large sync runs out of
time, grab a fresh token and re-run with `--resume`; pages already on disk are
left alone.

### Route B: register your own app

Worth doing if you will re-sync regularly, since it gives a refreshable token
rather than an hourly copy-paste. It needs an account with an Entra directory,
so a work or school account, or a personal account for which Azure has already
provisioned one.

1. <https://portal.azure.com> → **App registrations** → **New registration**.
   - **Name**: `shinyashimada-onenote-sync`
   - **Supported account types**: *Accounts in any organizational directory
     and personal Microsoft accounts* — this matters, because it lets the app
     live in one directory while Shin signs in with his personal account.
   - **Redirect URI**: leave empty — the device code flow does not use one.
2. **Authentication** → **Advanced settings** → **Allow public client flows**
   = **Yes** → **Save**. Without this the device code flow is refused.
3. **API permissions** → **Add a permission** → **Microsoft Graph** →
   **Delegated permissions** → **Notes.Read** → **Add permissions**.
4. Copy the **Application (client) ID**.

```bash
export ONENOTE_CLIENT_ID=<the application id>
export ONENOTE_TENANT=common   # 'consumers' rejects a multi-tenant app
```

The script then prints a short code for Shin to enter at
microsoft.com/devicelogin on his own device, and caches the refresh token in
`.onenote-token.json` (mode 0600, gitignored).

## 1. Pull the notebooks down

See what is there first:

```bash
node scripts/onenote-sync.mjs --list
```

That prints every notebook, its sections, and a page count per section. Then
pull one notebook, or all of them:

```bash
node scripts/onenote-sync.mjs --notebook español --out .onenote-export
```

Each page is written as HTML under
`.onenote-export/<notebook>/<section>/NNN-<page-title>.html`, alongside a
`manifest.json` listing every page with its image count and how much text it
contains. Both paths are gitignored: the export is a working file, and it may
contain personal notes that have nothing to do with vocabulary.

If the token runs out mid-sync, Graph answers `401` and the script says so.
Copy a fresh token, re-export it, and add `--resume`:

```bash
node scripts/onenote-sync.mjs --all --resume
```

### Pages that are photographs

The sync run ends by listing pages that hold images but almost no text. In the
November 2023 backup of this notebook, a lot of the Spanish content was exactly
that — photographed textbook pages, for instance `Lección 12 (comida)` as
twelve PNGs. Those cannot be parsed, only OCR'd, and OCR of a printed
vocabulary table makes mistakes that a learner will not spot once they are
being quizzed on them. Treat OCR output as a draft for Shin to proofread, never
as import-ready data.

### Bringing the pictures over

The page HTML only *references* its images; fetching each one is a second
Graph request, so it is opt-in:

```bash
node scripts/onenote-sync.mjs --notebook español --section 2022_目標 --images
```

They land in `.onenote-export/images/`, named by the resource id that appears
in the page markup, which is how the parser matches a picture to the row it
sat on. 218 of the 3,463 entries reference one.

Uploading them is a separate step, after the words are already in Postgres —
see **5. Attach the pictures** below.

## 2. Parse into normalised JSON

```bash
node scripts/parse-vocab.mjs .onenote-export --out data/spanish-vocab.json
```

## 3. Review

Read the JSON before importing. `--dry-run` reports what would be written,
including a per-topic count, without touching the database:

```bash
node --env-file=.env scripts/import-vocab.mjs --dry-run data/spanish-vocab.json
```

## 4. Import

```bash
node --env-file=.env scripts/import-vocab.mjs data/spanish-vocab.json
```

Writes are upserts keyed on `(language, topic_id, lower(term))`, so running the
whole pipeline again after Shin adds vocabulary updates existing rows instead
of duplicating them. Nothing is deleted unless you pass `--prune`, which
removes entries the import no longer mentions — and only within the topics that
import actually covers.

## 5. Attach the pictures

The blob store only exists inside Netlify, so images are uploaded *through*
the deployed site rather than written directly:

```bash
SITE_PASSCODE=… node --env-file=.env scripts/import-images.mjs data/spanish-vocab.json
```

Add `--dry-run` to see what it would do, or `--base http://localhost:8899` to
push into a local run instead of production. Re-running is safe: the key is a
hash of the bytes, so the same picture never becomes two objects.

## Adding vocabulary without OneNote

Shin does not need any of the above to keep studying. `/vamos/` has an
**Añadir** tab with a form for a single word and a paste box that accepts the
rows he already writes — `término — definición`, an `=` or `:`, or a tab.
Everything he adds is cleaned and masked by the same code that handled the
import, so a card he types behaves like one that came out of the notebook.

The **Lista** tab is the same vocabulary without the quiz: searchable,
filterable by unit, and where a picture gets attached to a word that lacks
one.

## Marking written sentences

The Escribir tab's third mode asks Claude to mark a sentence. Check it is
wired up without spending anything:

```bash
curl -s "https://shinyashimada.com/api/vocab-review?health=1"
```

That reports whether the key and workspace are set, which model is in use,
the ceilings, and what has been used this hour and today.

## Environment

| Variable | Where | Purpose |
|---|---|---|
| `ONENOTE_ACCESS_TOKEN` | your shell | Graph access token copied from Graph Explorer (route A) |
| `ONENOTE_CLIENT_ID` | your shell | Azure application ID (route B) |
| `ONENOTE_TENANT` | your shell | Defaults to `consumers`; set to `common` or a tenant GUID for a work account |
| `DATABASE_URL` | `.env` locally, Netlify env in production | Neon connection string |
| `SITE_PASSCODE` | Netlify env | Required for reads, and always required for writes, image uploads and reviews |
| `ANTHROPIC_API_KEY` | Netlify env | Marks the sentences written in the Escribir tab. Without it that one mode is unavailable; the rest of the site is unaffected |
| `ANTHROPIC_WORKSPACE_ID` | Netlify env | Only for an identity-linked key, which rejects requests that do not name a workspace (`wrkspc_…`). Leave unset for a standard key, which rejects the header |
| `VOCAB_REVIEW_MODEL` | Netlify env | Defaults to `claude-sonnet-5` |
| `VOCAB_REVIEW_PER_HOUR` / `_PER_DAY` | Netlify env | Spend ceilings, default 40 and 200. Attempts count, not successes |
| `VOCAB_API_BASE` | your shell | Where `import-images.mjs` uploads; defaults to the live site |
| `VOCAB_IMAGE_DIR` | your shell | Local directory standing in for Netlify Blobs off-platform |
