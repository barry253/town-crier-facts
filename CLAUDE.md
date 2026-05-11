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
