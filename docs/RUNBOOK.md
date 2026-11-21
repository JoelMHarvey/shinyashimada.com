# Runbook: shinyashimada.com on apps-01

What to do when the site is down, how to get the data back, and how to change
the passcode and each key. The README says what the site is and how it is
built; this file is for the day something is wrong.

No secret, connection string or server address belongs in this file. Each
setting is named, with where it lives.

Some facts can only be read on the server. They were not checked when this
was written (21 November 2026) and are marked **not verified**. Correct them
here the first time you are on the server.

## Where things are

| What | Where |
|---|---|
| The app | One Docker container on `apps-01`, built from this repository's `Dockerfile`: `server/server.mjs` on port 8000, serving the pages, the functions and the daily Trello sync |
| Its folder on the server | `/srv/shinyashimada` (named in the projects repo, `infra/README.md`). Whether it is a git checkout of this repository, and whether it holds a compose file, is **not verified**. This repository has no compose file |
| Its settings | `/etc/shinyashimada` (named in `infra/apps/_postgres/settings.list`, so it is in the nightly settings backup). The name of the file inside it is **not verified** |
| The container's name and image tag | **not verified**. The `Dockerfile`'s own example tags the image `shinyashimada-app`. `docker ps` on the server shows the real ones |
| The front door | The shared Caddy at `/srv/edge`, one file per site in `/srv/edge/sites/`. It holds the certificate, sends `www` to the apex and passes requests to the app on the `edge` network. This site's file name is **not verified** |
| The database | `shinyashimada`, in the shared Postgres 17 cluster at `/srv/db`, reached as `postgres:5432` on the `data` network. Tables: `store_records`, `vocab_topics`, `vocab_entries` |
| The pictures | A private bucket in Hetzner Object Storage, `nbg1`, named `rol-shinyashimada-images` in the backup kit's list. Prefixes: `vocab-images/` (the vocabulary cards' pictures), `passcode-failures/` and `vocab-usage/` (short-lived counters) |
| DNS | Cloudflare holds the zone; the domain is registered at GoDaddy. Both names point straight at `apps-01`, with Cloudflare's proxy off |
| Logs | The container's own output (`docker logs`). Server errors also go to GlitchTip once `SENTRY_DSN` is set in `/etc/shinyashimada`. Until then the container's log is the only place. Nothing watches the site from outside yet |
| Deploys | By hand (Joel's ruling, 21 November 2026). No workflow builds or deploys this site. Steps: README, "Updating the server's copy" |

The backup kit, the Caddy kit and the server's own notes are in the projects
repo under `infra/` (`apps/_postgres/README.md`, `apps/_edge/README.md`,
`PROVIDER-EXIT.md`).

## It is down

Work down the list and stop when something is wrong.

1. **Ask from outside.**

   ```bash
   curl -sS -o /dev/null -w '%{http_code}\n' https://shinyashimada.com/
   curl -sS https://shinyashimada.com/api/health/live
   curl -sS 'https://shinyashimada.com/api/store?health=1'
   ```

   - `/api/health/live` answers 200 `{"ok":true}` whenever the Node process
     is up. It does not touch the database.
   - `/api/store?health=1` answers 200 with `"ok": true` even when the
     database is down. Read the `database` field: `true` is healthy.
   - No answer at all, or a certificate error: the server or Caddy (step 5).
   - A 502 from Caddy: the container is stopped or unhealthy (step 2).
   - Pages load but the balcony or the library says it cannot sync:
     `database` is `false` (step 4).
   - Everything answers 401 with the right passcode: that address has used
     up its ten wrong passcodes. It clears by itself after 15 minutes.

2. **Look at the container.** On `apps-01`:

   ```bash
   docker ps -a | grep -i shinya          # is it there, is it "healthy"?
   docker logs --tail 200 <container>
   ```

   The image checks itself on `/api/health/live` every 30 seconds. A good
   start prints `[server] <n> functions, listening on ...` and a `[cron]` line
   with the next run of `balcony-trello-sync`. Function failures are written
   with `console.error`, for example `[store] health check failed`.

3. **Restart it.** `docker restart <container>`. The process closes cleanly
   on `SIGTERM`. A Trello sync due during the restart is missed, not caught
   up; *Sync now* in the balcony's Trello panel covers that day.

   A restart does not read a changed settings file if the container was
   started with `docker run --env-file`: the container has to be made again
   (README, "Updating the server's copy"). How this container was started is
   **not verified**.

4. **The database.** If `database` is `false`:

   ```bash
   cd /srv/db && docker compose ps        # is postgres up?
   docker logs --tail 100 <container>     # the app's own error
   ```

   If Postgres is down every app on the server is affected: follow
   `infra/apps/_postgres/README.md` in the projects repo. If Postgres is up,
   check `DATABASE_URL` in `/etc/shinyashimada` names `postgres:5432` and the
   `shinyashimada` database, and that the container is on the `data` network
   (`docker inspect <container>`). Without `DATABASE_URL` the site still
   serves its pages and runs device-only: nothing is lost on Shin's devices,
   and they sync when the database is back.

5. **Caddy and the server.** If nothing answers:

   ```bash
   cd /srv/edge && docker compose ps
   docker compose logs --tail 100
   ```

   Other sites on `apps-01` being down too points at Caddy or the server,
   not this app. `dig +short shinyashimada.com` should return the address of
   `apps-01`; if it does not, look at the zone in Cloudflare. The certificate
   is Let's Encrypt's and Caddy renews it by itself.

6. **Roll back.** If it broke after an update, build the commit that was
   running before and start that instead:

   ```bash
   cd /srv/shinyashimada
   git log --oneline -5                   # find the last good commit
   git checkout <commit>
   ```

   then build and start as in the README's "Updating the server's copy".
   Go back to `main` once it is fixed. Tagging the running image before each
   update (`docker tag <image> <image>:previous`) makes this a restart rather
   than a build. Whether a previous image is kept today is **not verified**.

7. **The pictures do not load** but everything else does: the bucket or its
   key. The log shows the S3 error. Check the five `S3_*` settings and the
   bucket in the Hetzner console. See "Restore the pictures" below.

8. **The Trello cards stopped.** The log has one line a day at 21:00 UTC:
   `[cron] balcony-trello-sync ran: 200`, or `[cron] job failed`. A lapsed
   token shows in the balcony's Trello panel. See `TRELLO_TOKEN` below.
   Mission Control shows the same thing as `shinyashimada-balcony-trello-sync`
   going late: a good run checks in there, a failed one does not (README,
   "The schedule"). A `[heartbeat]` line in the log means the sync ran but
   the check-in did not get through.

## Restore the database

The `shinyashimada` database is in the shared cluster, so the cluster's
backups cover it: continuous WAL and a full backup daily (any moment in the
last 14 days), and a `pg_dump` of this database alone every night at 02:45
UTC, kept 15 days (57 for Sunday's). All are encrypted with
`BACKUP_CIPHER_PASS`, which is in the password manager, and copied to
Cloudflare R2 each night. The details are in the projects repo,
`infra/apps/_postgres/README.md`.

No restore of this database is on record. Whether last night's dump of it is
in the bucket is **not verified**. To prove both without touching the live
data, on `apps-01`:

```bash
cd /srv/db && sudo bin/dump-restore-test shinyashimada
```

It restores the newest dump into a scratch database, compares every table's
row count with the live one and drops the scratch copy. Write the date in the
fleet's status file when it has been run.

**This database alone** (a bad import, rows deleted by mistake). The other
apps lose nothing.

1. Tell Shin not to use the site, or accept that writes made after the dump
   are lost. His devices keep their own copy of the plants and the books and
   push anything newer when they next sync, so the balcony and the library
   mostly heal themselves. The vocabulary is only in the database.
2. In `/srv/db`, list the dumps (`docker compose exec backup backup.sh
   info`) and take the newest
   `shinyashimada-<UTC time>.dump.enc` from before the mistake, in
   `apps-01/dumps/daily/`.
3. Decrypt it. It asks for `BACKUP_CIPHER_PASS`:

   ```bash
   openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in shinyashimada.dump.enc -out shinyashimada.dump
   ```

4. Restore into a fresh database beside the live one: `./new-db.sh
   shinyashimada_restored`, then `pg_restore --no-owner -d` that database.
5. Check it: row counts of `store_records`, `vocab_topics` and
   `vocab_entries`, and the newest `updated_at` in `store_records`.
6. Point the app at it: change the database name in `DATABASE_URL` in
   `/etc/shinyashimada`, make the container again, and check
   `/api/store?health=1` says `"database": true`. Then open the balcony, the
   library and a vocabulary deck.
7. Send the changed settings file to the backup at once:
   `sudo systemctl start db-backup-settings`. Delete the decrypted dump.

**A moment in time, or the whole cluster** (a lost disk): `./restore.sh` in
`/srv/db`, as its README says. Every app on the server is without its
database until it finishes, so this is not the tool for one app's mistake.

**The tables are missing altogether.** `store_records` is created by the
functions on first use (`schema.sql`). The vocabulary tables come from
`schema-vocab.sql`, applied by `scripts/migrate-vocab.mjs`, and the cards can
be imported again from OneNote (`docs/onenote-import.md`), though that is the
long way round.

## Restore the pictures

Only `vocab-images/` matters. The two counter prefixes cover a day at most
and rebuild themselves.

- **The bucket is in the nightly offsite copy.** `rol-shinyashimada-images`
  is in `OFFSITE_FILES_BUCKETS` (`infra/apps/_postgres/bin/offsite-sync`), so
  each night at 04:30 UTC it is mirrored, encrypted through rclone crypt, to
  the R2 bucket `rol-offsite` under `files/`. Whether the last run included
  it is **not verified**; `bin/backup-check` in `/srv/db` reports the last
  complete offsite run.
- **A picture deleted or overwritten by mistake** is kept at R2 under
  `removed/<date>/` for 30 days.
- **To bring pictures back**, follow the projects repo's
  `infra/PROVIDER-EXIT.md`, section 7.6: it builds the rclone crypt remote
  from the two passphrases in the password manager (`OFFSITE_CRYPT_PASS`,
  `OFFSITE_CRYPT_SALT`) and copies a bucket's files back. Copy into
  `rol-shinyashimada-images`, or into a new bucket and change `S3_BUCKET`.
  Each picture is keyed by a hash of its bytes, and the cards hold those
  keys, so the keys must come back unchanged.
- **If the offsite copy is not there either**, the pictures were first put in
  by `scripts/import-images.mjs` from the OneNote export
  (`docs/onenote-import.md`), and can be put in again the same way: it
  uploads through `/api/vocab-image` and is safe to run twice. Whether the
  export is still on Joel's Mac is **not verified**.

## Change the passcode and each key

The same four steps for every setting on the server:

1. Edit the value in `/etc/shinyashimada` (as root; keep the file's mode).
2. Make the container again so it reads the file (a plain restart is enough
   only if it was started in a way that re-reads the file; **not verified**).
3. Check `/api/health/live`, then the thing the key is for.
4. `sudo systemctl start db-backup-settings`, so the settings backup has the
   new value tonight rather than the old one.

The image holds no setting: `.dockerignore` keeps `.env` out, so no rebuild
is needed for a key change.

| Setting | Issued by | Changing it breaks or signs out | Then check |
|---|---|---|---|
| `SITE_PASSCODE` | Joel chooses it. A shared passphrase, not a generated key | Every device. Shin and Joel type the new one on each phone and laptop, here and on joelmharvey.com's library, which sends the same passcode to this site. Until then a device gets 401 and keeps its unsent edits; they are pushed once the new passcode is entered. A device still sending the old one counts as one wrong passcode, not ten, so it does not lock the household out. Also update it wherever `scripts/import-images.mjs` is run from | A gated route with the new passcode answers 200 and with the old one 401 |
| `DATABASE_URL` | The role's password is set in Postgres. The kit's `new-db.sh` made the role and wrote the URL to `/etc/postgres/apps/shinyashimada.url` (**not verified** that this database was made that way, nor the role's name) | Nothing for visitors if the three places change together: `ALTER ROLE ... PASSWORD` in the cluster, the URL in `/etc/shinyashimada`, and the kit's `.url` file. Between the first and the restart, the store, the library and the vocabulary fail and the pages run device-only | `/api/store?health=1` says `"database": true` |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Hetzner console, the Object Storage project that holds the app-files buckets: make a new key, set it, restart, then delete the old key | Pictures, the passcode-guess counters and the review counters fail between deleting the old key and the restart, so set the new one first. The nightly offsite copy reads its own key from `/etc/app-files.env`; whether that is this same key is **not verified**. If it is, change it there too or the offsite run fails | A vocabulary picture loads; the log has no S3 error |
| `SENTRY_DSN` | GlitchTip, the project's settings. Joel makes the project and gives the DSN | Nothing for visitors. Without it no error is sent anywhere | Nothing to see until an error happens. The container starts as before |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_FORCE_PATH_STYLE` | Not secrets. They change only if the bucket moves | | |
| `ANTHROPIC_API_KEY` (and the optional `ANTHROPIC_WORKSPACE_ID`) | Anthropic Console, API keys: create the new key, set it, restart, then delete the old one | Only `/api/vocab-review` (marking a sentence in ¡Vamos, Español!). With no key it answers 503 `no_api_key`; nothing else on the site uses it | Mark one sentence in the writing pad |
| `TRELLO_KEY`, `TRELLO_TOKEN` | Trello's Power-Up admin page: the API key, and a token for the account with read and write scope. The token has an expiry chosen when it is made; the current one's date is not recorded anywhere, so write the new date in the fleet's status file | The morning sync and the Trello panel. A lapsed or revoked token shows in the panel as unauthorised, and the 21:00 UTC run logs a failure. The board and list chosen in the panel are kept in the database, not in the token, so they survive. Revoke the old token on Trello afterwards | Balcony, Data, *Trello sync*, *Sync now* |
| `HEARTBEAT_TOKEN` (with `HEARTBEAT_URL`, not a secret) | Mission Control, at ops.joelmharvey.com. Where its token is kept there is **not verified** from this repository | Nothing on the site. Until the new one is set and the container made again, check-ins are refused and Mission Control shows the sync as late | The next 21:00 UTC run shows in Mission Control; the log has no `[heartbeat]` line |
| `CAMERA_STREAM_URL` | Not issued: it is the public hostname of the Cloudflare tunnel in front of the relay at home (`homelab/README.md`). The secrets behind it (`CAMERA_USER`, `CAMERA_PASS`, `TUNNEL_TOKEN`) live in `homelab/.env` on the machine at home, never on `apps-01` | Anyone who learnt the old address can still open the stream until the tunnel's hostname is changed in Cloudflare Zero Trust. To cut it off: change the hostname there, then set the new URL here. Changing the camera's own password means editing `homelab/.env` and restarting the relay | The camera card on the balcony page plays |

Not secrets, and not rotated: `CAMERA_LABEL`, `CAMERA_MODE`,
`ALLOWED_ORIGINS`, `SITE_URL`, `PORT`, `HOST`, `TRUST_PROXY`,
`SCHEDULED_FUNCTIONS`, `VOCAB_IMAGE_DIR`, `VOCAB_REVIEW_MODEL`,
`VOCAB_REVIEW_PER_HOUR`, `VOCAB_REVIEW_PER_DAY`.

Which of the optional settings are actually set on the server (Trello, the
camera, the Anthropic key) is **not verified**.

**Keys that are never on the server.** They are used from Joel's Mac by one
script each:

- `NETLIFY_SITE_ID`, `NETLIFY_AUTH_TOKEN`: `scripts/copy-blobs-to-s3.mjs`,
  the one-off copy of pictures out of Netlify Blobs. A personal access token
  from Netlify's user settings. Once the Netlify site is deleted the script
  has nothing to read: revoke the token there.
- `ONENOTE_ACCESS_TOKEN`, or `ONENOTE_CLIENT_ID` with `ONENOTE_TENANT`:
  `scripts/onenote-sync.mjs`. Short-lived Microsoft Graph tokens;
  `docs/onenote-import.md` says how to get one. `.onenote-token.json` is in
  `.gitignore`.

**Keys that belong to the server, not this app:** `BACKUP_CIPHER_PASS`, the
backup bucket's key, the offsite passphrases and Caddy's settings. They are
in the projects repo's `infra/` notes and are changed there, for every app at
once.

## Still open

- Nothing outside the server asks the health paths, so a stopped container
  is found by Shin. The site is due to go on the private watch.
- Server errors go only to the container's log.
- No fire drill and no restore of this database is on record.
- Whether the old Netlify site and the Neon database in Singapore have been
  deleted is **not verified**. If Netlify still has `TRELLO_KEY` and
  `TRELLO_TOKEN` set, its sync and the server's both run at 21:00 UTC and
  post duplicate cards (README, the moving checklist, step 8).
