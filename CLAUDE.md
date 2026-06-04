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

## Fact editor

Start the editor server:
```bash
cd ~/town-crier-facts
node editor/server.js
```

Access from Windows via SSH tunnel (in a separate terminal):
```powershell
ssh -L 8787:127.0.0.1:8787 barry@rosenpi.duckdns.org   # remote
ssh -L 8787:127.0.0.1:8787 barry@raspberrypi.local      # local network
```

Then open http://localhost:8787 in your browser.

After committing, rebuild the index and push as normal.

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
