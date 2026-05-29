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

## Local editor

```bash
node editor/server.js
# UI available at http://localhost:8787
```

## Generation worker (Pi systemd service)

The queue worker runs as a systemd service (`town-facts-worker`) on the Pi and
starts automatically on boot.

```bash
# Check status
sudo systemctl status town-facts-worker

# View live logs
tail -f ~/town-facts-lab/worker.log

# Restart after a config change or manual stop
sudo systemctl restart town-facts-worker

# Stop / start manually
sudo systemctl stop town-facts-worker
sudo systemctl start town-facts-worker
```

Queue file: `~/town-facts-lab/queue/towns.queue.jsonl`
Queue status: `cd ~/town-facts-lab && npx tsx scripts/queueStatus.ts`

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

## Generation workflow (Pi)

- Working directory for generation: `~/town-facts-lab`
- Sync generated output into this repo:
  ```bash
  rsync -av ~/town-facts-lab/output/ /path/to/town-crier-facts/facts/
  ```
- After every sync: rebuild index and push (see above).

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
