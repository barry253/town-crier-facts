# Town Crier Facts

Production source of truth for Town Crier fact files.

## Repository layout

- `facts/*.json` — all fact files, flat (no subdirectories)
- `facts-index.json` — generated index; never edit manually
- `neighborhoods/` — city neighborhood centroid files (e.g. `new-york-city.json`), fetched by the app at runtime
- `editor/` — local review UI
- `scripts/build-index.js` — index builder

## Fact file conventions

- One file per place: `facts/<town-slug>-<state-slug>.json`
- Example: `facts/astoria-new-york.json`

## After any change to facts/

```bash
node scripts/build-index.js
git add facts facts-index.json
git commit
git push
```

Always rebuild the index and push — never leave facts and index out of sync.

## R2 mirror

The app fetches at runtime from a Cloudflare R2 bucket, not from GitHub
directly. The `publish-facts.sh` script handles mirroring automatically —
every successful `git push` is followed by an `rclone` sync of `facts/`,
`neighborhoods/`, `landmarks/`, and `landmarks-index.json` to R2. GitHub
remains the source of truth; R2 is the serving layer.

- **Bucket:** `town-crier-facts` (Cloudflare R2, Eastern North America)
- **Public URL:** `https://pub-1feff31ff8ec4ecfafa5cf1a7a5146c7.r2.dev/`
- **Cache-Control:** 24h on content files, 5 minutes on
  `landmarks-index.json` (a stale index hides newly-published landmark
  collections)
- **Credentials:** `~/.config/rclone/rclone.conf` on the Pi (0600, user
  `barry`); never commit
- **Alerting:** failures fire Sentry events from
  `~/.config/town-crier/sentry.env` tagged `source:pi`

If R2 sync fails after a successful `git push`, the publish *as a whole*
is considered failed (script exits non-zero, Sentry fires) but GitHub
remains consistent. Re-running `publish-facts.sh` will retry the R2 sync
— it's idempotent.

`facts-index.json` is intentionally NOT mirrored to R2 — the app builds
fact URLs from slugs directly and never fetches the index at runtime.
The index file exists only for editor and audit tooling.

## Review metadata

Some fact files contain per-fact review metadata. **Never overwrite these files without inspecting them first.** Check for a `reviewed` field (or similar) on individual fact objects before replacing file contents.

Files with any reviewed fact (status: `approved`, `ignore_flag`, `reviewed`, or legacy `reviewed: true`) are automatically protected from rsync overwrite by `publish-facts.sh`. To intentionally overwrite a protected file, manually remove the review fields before syncing.

## Fact editor

Location: `editor/server.js` (Express) + `editor/public/index.html`
(single static page, vanilla JS). Runs as a systemd service, not a
foreground process:

```bash
sudo systemctl restart town-crier-editor   # after ANY editor/ code change — server.js is not hot-reloaded
sudo systemctl status town-crier-editor
journalctl -u town-crier-editor -n 50
```

**Gotcha:** the editor has no per-request logging. `journalctl` only
ever shows systemd start/stop lines, never publish/generate activity —
the SSE stream sent to the browser during Publish/New Town is the
*only* place that activity is visible, and it is not mirrored to
stdout. Don't read journalctl silence as "nothing happened."

Access from Windows via SSH tunnel (in a separate terminal):
```powershell
ssh -L 8787:127.0.0.1:8787 barry@rosenpi.duckdns.org   # remote
ssh -L 8787:127.0.0.1:8787 barry@raspberrypi.local      # local network
```

Then open http://localhost:8787 in your browser.

Features:
- Browse and edit facts by town
- Drag-to-reorder facts within a file
- **+ New Town** — see "New Town workflow" below
- **Publish button** — see "Publish pipeline" below
- The Publish step includes a **"Check protected files"** stage that lists every fact file containing reviewed facts, confirming what will be preserved during any subsequent rsync from `output/`

After committing manually, rebuild the index and push as normal.

### New Town workflow

"+ New Town" opens a modal: enter town name + state, click Check.

- The editor computes the slug and checks it against `facts/`
  (published) and `town-facts-lab/output/` (draft) first — refuses to
  proceed if already published; if a draft already exists it offers a
  non-destructive **"Open draft for editing"** option rather than
  silently overwriting it (Generate/Stub, the alternatives, both
  unconditionally overwrite — a real bug found and fixed 2026-07-15
  after a hand-edited High View draft nearly got wiped by a re-run).
- Attempts Wikipedia resolution via `town-facts-lab/scripts/resolveWikipedia.ts`
  (invoked as a subprocess — the editor is a separate repo/process
  from the TS pipeline, so it can't import `wikipediaResolve.ts`
  directly; see that repo's `GLOSSARY.md`).
  - **Resolved**: runs `generateFacts.ts` for the matched article
    (SSE-streamed), writes `town-facts-lab/output/<slug>.json` tagged
    `createdVia: "editor-resolved"`.
  - **Rejected** (no matching article — e.g. a hamlet with only a
    one-line mention in a neighboring town's article, no standalone
    page): offers **"Create empty JSON stub"**, writing an empty
    `{slug, place, sources: [], facts: []}` draft tagged
    `createdVia: "editor-manual"` so facts can be entered by hand in
    the normal fact-review UI.
- Facts and an optional image URL override can then be edited like any
  other draft. Drafts live in `town-facts-lab/output/` until published
  — the same staging area the generation pipeline already uses.

### Publish pipeline

Corrected step order (fixed 2026-07-16, commit `c64fc43f`,
[PR #2](https://github.com/barry253/town-crier-facts/pull/2)):

1. **Sync to R2** — invokes `town-facts-lab/scripts/publish-facts.sh`,
   which rsyncs `output/` → `facts/` (new towns only —
   `--ignore-existing`, see `town-facts-lab/CLAUDE.md`'s Historical
   Lessons), rebuilds indexes, commits, pushes, and mirrors to R2.
   Runs first and unconditionally.
2. **Record pending Kokoro entries** — only for files newly present in
   `facts/` this run whose `createdVia` is `"editor-manual"` or
   `"editor-resolved"` (see "Kokoro synthesis" below). Pipeline-
   generated towns have no `createdVia` field and are never added here.
3. Rebuild indexes (the editor's own copy — catches anything
   `publish-facts.sh`'s internal commit didn't, e.g. `neighborhoods/`)
4. Stage changes
5. Check for changes — short-circuits cleanly here if there's nothing
   left to stage
6. Commit
7. Push to `origin/main`

**Why step 1 runs first:** it used to run last, after stage/commit/
push. A brand-new town living only in `output/` meant step 4's
`git add facts` found nothing (the town hadn't been rsynced in yet),
so the flow hit the step-5 short-circuit and returned "success"
without `publish-facts.sh` ever running — silently dropping the new
town. Confirmed via a real failed High View, NY publish attempt on
2026-07-16. Running the rsync first is safe for edit-only publishes
too: `publish-facts.sh`'s `--ignore-existing` rsync is a no-op when
there's no new-town draft pending.

**Existing-town edits** (image URL override, fact text changes) never
touch `output/` — they're made directly against files already in
`facts/`, so they flow straight through steps 3–7 with step 1 a no-op.

**Gotcha:** this pipeline only ever creates a `pending-kokoro.jsonl`
entry for a genuinely *new* town — never for an edit to an
already-published one. Editing High View's facts after its Kokoro
clips are synthesized, for example, does not re-queue it for a fresh
synthesis pass.

## Kokoro synthesis (Pi-driven, manual dispatch)

Editor-created towns (New Town workflow above) need Kokoro TTS clips
synthesized and published to R2 before the app plays them instead of
falling back to on-device TTS. This is separate from DS CC's bulk
state-batch synthesis (`kokoro-bench` scripts run from the Windows
machine) — this is the on-demand, per-town path for editor-created
towns, run from the Pi (always on and otherwise idle, unlike DS CC's
laptop which is often off during work hours).

```bash
cd ~/town-crier-facts
./scripts/process-pending-kokoro.sh
```

What it does (`scripts/process-pending-kokoro.sh` +
`scripts/kokoro_consume.py`, shipped 2026-07-16, commit `f4d6c4a6`):

1. **Dict rules sync** — `git pull --ff-only origin main` in
   `~/kokoro-bench` (clone of `barry253/kokoro-bench`). **Hard-fails
   the whole run** if the pull fails — never synthesizes against
   possibly-stale `data/pronunciation-overrides.json` (flat JSON,
   `{word: IPA phoneme string}`, currently ~1,159 entries). Reports
   the before/after commit and how many dict entries actually changed.
2. Loads R2 write credentials from `~/.config/town-crier/r2-kokoro.env`
   (0600) — reused from the same Cloudflare R2 API token as
   `~/.config/rclone/rclone.conf`'s `[r2]` remote (verified working
   for both read and write via `boto3` before adopting it, rather than
   provisioning a second credential).
3. Diffs `pending-kokoro.jsonl` against `completed-kokoro.jsonl` (both
   at the repo root) by slug.
4. For each new slug: fetches `facts/<slug>.json` fresh from R2 (never
   a local mirror — matches `kokoro-bench`'s own house rule), synthesizes
   `welcome.mp3` + `fact-0.mp3`...`fact-N.mp3` via `kokoro-bench`'s own
   `Synthesizer` class (`af_heart` voice, Experiment C -16 LUFS
   normalization — the identical pipeline DS CC's batch scripts use,
   imported directly rather than reimplemented), uploads to
   `facts/<slug>/kokoro-af_heart/*.mp3`.
5. All-or-nothing per slug — a `completed-kokoro.jsonl` entry is only
   written once every clip for that slug has synthesized *and*
   uploaded. A failure anywhere rolls back any clips already uploaded
   to R2 for that slug and writes nothing to `completed-kokoro.jsonl`,
   so a re-run picks the slug back up from scratch rather than leaving
   a half-published town. Uploads retry 3x before counting as failed.
6. Idempotent — safe to re-run; already-completed slugs are skipped
   without reloading the model.
7. Does **not** touch `kokoro-manifest.json` or `kokoro-batch-status.json`
   — those are DS CC's own coverage-dashboard bookkeeping, regenerated
   periodically from R2 truth by `kokoro-bench/scripts/build-kokoro-manifest.ts`.

### pending-kokoro.jsonl / completed-kokoro.jsonl

Both live at the `town-crier-facts` repo root.

`pending-kokoro.jsonl` — written by the editor's Publish pipeline
(step 2 above), one line per new editor-created town:
```json
{"slug": "high-view-new-york", "addedAt": "2026-07-16T14:22:31.288Z", "addedBy": "editor-manual"}
```
`addedBy` is always the file's `createdVia` value (`"editor-manual"`
or `"editor-resolved"`).

`completed-kokoro.jsonl` — appended by `process-pending-kokoro.sh` on
success:
```json
{"slug": "high-view-new-york", "completedAt": "2026-07-16T14:51:58.000Z", "clipCount": 2, "addedBy": "editor-manual"}
```
`addedBy` is carried over from the matching `pending-kokoro.jsonl`
entry, so it's possible to audit which synthesis path (editor vs. any
future automated consumer) produced a given completion.

## Generating a single fact file

To regenerate or create a single town's fact file:
```bash
cd ~/town-facts-lab
npx tsx scripts/generateFacts.ts "Town Name, State"
# Check output
cat output/<slug>.json | jq '{place, slug, factCount: (.facts | length)}'
```
Then copy to production, rebuild index, and push (see Syncing section).

## Queue system

Queue source files live under `~/town-facts-lab/queues/`:
- US states: `queues/us/<state>.json`
- International: `queues/intl/<region>.json`
- Neighborhoods: `queues/neighborhoods/neighborhoods-<city>.json`
- Census gap fills: `queues/us/gap-<state>.json`

To build and start a queue (overwrites the active queue — never run while worker is active):
```bash
cd ~/town-facts-lab
npx tsx scripts/buildMultiQueue.ts queues/us/maryland.json queues/intl/israel.json ...
sudo systemctl start town-facts-worker
npx tsx scripts/queueStatus.ts
```

To append a single town to a running queue without interrupting it:
```bash
now=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
echo "{\"id\":\"north-brunswick-new-jersey\",\"label\":\"North Brunswick, New Jersey\",\"sourceFile\":\"queues/us/nj-missing.json\",\"region\":\"New Jersey\",\"status\":\"pending\",\"attempts\":0,\"createdAt\":\"${now}\"}" >> queue/towns.queue.jsonl
```

Worker commands:
```bash
sudo systemctl start town-facts-worker
sudo systemctl stop town-facts-worker
sudo systemctl status town-facts-worker
npx tsx scripts/queueStatus.ts
```

After a queue completes, reset completion state for next run:
```bash
jq '.lastCompletionNotified = "false" | .lastNearlyDoneNotified = "false"' .queue-email-state.json > .queue-email-state.json.tmp && mv .queue-email-state.json.tmp .queue-email-state.json
```

If a job is stuck in `"status":"running"` with no worker process running,
change it to `"status":"pending"` and increment `attempts` by 1.

## Known generator issues

### Slug truncation bug (fixed 2026-05-11)

`cleanDisplayTown()` in `~/town-facts-lab/scripts/generateFacts.ts` previously
stripped trailing `City`, `Village`, `Town`, `Borough`, and `CDP` from town
names, corrupting slugs for places where those words are part of the name.

**Manually corrected files from the affected batch:**

| Wrong file | Correct file |
|---|---|
| `grant-new-york.json` | `grant-city-new-york.json` |
| `heartland-new-york.json` | `heartland-village-new-york.json` |
| `middle-new-york.json` | `middle-village-new-york.json` |

**If a truncated slug is discovered:**
1. Check content to identify the correct full name
2. `git mv facts/<wrong>.json facts/<correct>.json`
3. Update `place`, `town`, and `slug` fields inside the file with `jq`
4. Rebuild index and push

- **Task 6 person-photo heuristic caused 2,223 false positives (Aug 2026).** The filename-based `FirstName LastName` pattern for detecting person photos was far too aggressive — it cleared legitimate town photos like `File:Absarokee_Montana.JPG` and `File:Stone_Bridge_Acushnet.jpg`. The correct approach to detecting person photos is to validate the Wikipedia *article* (check that the source article's extract mentions the town's state), not the image filename. Task 6 is now disabled in `runNightlyPipeline.ts`. Wrong-article detection belongs in the fact generation pipeline, not the image pipeline.

**35 pending NYC neighborhoods** still in queue that would have been affected
(now safe — fix deployed before generation):
Brighton Beach, Manhattan Beach, Marine Park, Bergen Beach, Ocean Hill,
Hunts Point, Marble Hill, University Heights, Morris Heights, Fordham Heights,
Bedford Park, Co-op City, City Island, Morris Park, Pelham Gardens, Castle Hill,
Clason Point, Harding Park, Westchester Square, Washington Heights,
Morningside Heights, Hamilton Heights, Carnegie Hill, Lenox Hill, Murray Hill,
West Village, Greenwich Village, Battery Park City, Civic Center, East Village,
Alphabet City, Stuyvesant Town, Peter Cooper Village, Roosevelt Island,
Randalls Island.

## Syncing to production

> **WARNING:** rsync will overwrite manually edited fact files unless they contain reviewed facts. Before syncing, any fact you want to protect should have a review object with status `approved`, `ignore_flag`, or `reviewed` on at least one fact entry. Files with reviewed facts are automatically excluded from rsync overwrite.

Before syncing, prune 0-fact output files (fast method):
```bash
cd ~/town-facts-lab
grep -rL '"text"' output/*.json | xargs -r rm
echo "Remaining: $(ls output/*.json | wc -l)"
```

Then sync, rebuild index, and push:
```bash
rsync -av output/ ~/town-crier-facts/facts/
cd ~/town-crier-facts
node scripts/build-index.js
git add facts facts-index.json
git commit -m "Add generated facts and rebuild index"
git push origin main
```

## Email notifications

The monitor runs every 5 minutes via cron. To disable:
```bash
crontab -e
# Comment out the queueEmailMonitor line:
# */5 * * * * /home/barry/town-facts-lab/scripts/queueEmailMonitor.sh ...
```

To re-enable, uncomment the line. To force an immediate email:
```bash
cd ~/town-facts-lab
jq '.lastHourly = 0' .queue-email-state.json > .queue-email-state.json.tmp && mv .queue-email-state.json.tmp .queue-email-state.json
bash scripts/queueEmailMonitor.sh
```

If alerts fire on stale state after a queue rebuild, reset:
```bash
cd ~/town-facts-lab
cp queue/towns.failed.jsonl queue/towns.failed.jsonl.bak
> queue/towns.failed.jsonl
> worker.log
jq '.lastFailed = 0 | .lastErrorHash = ""' .queue-email-state.json > .queue-email-state.json.tmp && mv .queue-email-state.json.tmp .queue-email-state.json
```

---

## Landmark Collections (NEW — May 2026)

Landmark collections are pre-generated county-by-county
and stored alongside facts.

### Layout

```
landmarks/us/ny/nassau-county.json
landmarks/us/nj/hudson-county.json
landmarks-index.json  (never edit manually)
```

### After any change to landmarks/

```bash
node scripts/build-landmarks-index.js
git add landmarks landmarks-index.json && git commit && git push
```

### Landmark schema (v1)

`schemaVersion: 1, type: "landmarkCollection"`

Each landmark has: `id`, `name`, `landmarkType`, `geometry` (point),
`radiusMeters`, `commentaryTemplate`, `sources`, `image`, `review`.

`image` is null or has: `url`, `thumbUrl`, `caption`,
`licenseShortName`, `licenseUrl`, `authorName`, `authorUrl`, `filePageUrl`.

`review.status` is `"draft"` (auto-generated) or `"approved"`
(real-world validated).

### Commentary rules

- Starts with `{{side}}` — app replaces with "On your left", "On your right", or "Ahead"
- 15–25 words total
- One specific fact: year, named person, record, or event
- Never describes location
- Natural spoken audio cadence

### Generation

Run on Pi from `~/town-facts-lab`:

```bash
npx tsx scripts/generateCounty.ts "Nassau County" "NY"
npx tsx scripts/generateCountyBatch.ts
```

Never edit `landmarks-index.json` manually.
The local editor at http://localhost:8787 includes a Landmarks tab for browsing and editing.
