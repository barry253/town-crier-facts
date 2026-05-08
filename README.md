# Town Crier Facts

Static fact library used by the Town Crier app and Facts Viewer.

## Add generated fact files and rebuild the viewer index

Run this from the Raspberry Pi / machine that has the generated JSON output and the `town-crier-facts` repo checked out.

```bash
cd ~/town-crier-facts
git pull origin main

# Copy newly generated fact JSON files into this repo if needed.
# Example, when generated files are in ~/town-facts-lab/output:
rsync -av --include='*.json' --exclude='*' "$HOME/town-facts-lab/output/" "$HOME/town-crier-facts/facts/"

# Rebuild facts-index.json so the Facts Viewer has current town metadata,
# fact counts, date fields, and precomputed QA warning counts.
node scripts/build-index.js

git status
git add facts facts-index.json
git commit -m "Add generated fact files and rebuild facts index"
git push origin main
```

If there are no new fact files and only the index needs rebuilding, this is enough:

```bash
cd ~/town-crier-facts
git pull origin main
node scripts/build-index.js
git add facts-index.json
git commit -m "Rebuild facts index"
git push origin main
```

If `git commit` says `nothing to commit, working tree clean`, the repo already has the latest generated output/index.

## Facts Viewer QA filters

The public Facts Viewer reads `facts-index.json` first for fast filtering. The index rebuild precomputes:

- `factCount`
- `reviewedCount`
- `badCount`
- `warningCount`
- `weakCount`
- `hasIssues`

Because those values are precomputed during `node scripts/build-index.js`, the viewer does not need to load every individual town JSON file on startup.

## Local facts editor

The repo also includes a local-only editor for reviewing and editing fact JSON files directly.

Use this for private/admin work only. Keep the public GitHub Pages viewer read-only.

### What the editor does

The local editor can:

- show a Problem Queue of flagged facts
- browse all towns and all facts
- search by town, state, slug, fact text, source URL, and source label
- edit fact text
- edit source URL and source labels
- mark facts as approved/reviewed
- mark flags as ignored
- mark facts as needs fix
- delete bad facts
- add new facts
- rebuild `facts-index.json` automatically after edits
- show local Git status

Edits are written directly to files in:

```text
facts/*.json
```

The editor runs from:

```text
editor/server.js
```

and serves the UI from:

```text
editor/public/index.html
```

### First-time setup on the Pi

Run this in the local repo checkout:

```bash
cd ~/town-crier-facts
git pull origin main
npm install
```

If `npm install` creates or updates dependency files, commit them:

```bash
git status
git add package.json package-lock.json
git commit -m "Add local editor Node dependencies"
git push origin main
```

### Run the editor locally on the Pi

```bash
cd ~/town-crier-facts
git pull origin main
node editor/server.js
```

Expected output:

```text
Town Crier local facts editor running at http://127.0.0.1:8787
Local-only by default. Use SSH tunneling for remote access.
```

Open this on the Pi:

```text
http://127.0.0.1:8787
```

The editor is intentionally bound to `127.0.0.1` by default, not `0.0.0.0`, so it is not exposed publicly.

### Access the editor remotely from another computer

Keep the editor running on the Pi.

From the remote computer, open a terminal and create an SSH tunnel:

```bash
ssh -L 8787:127.0.0.1:8787 barry@rosenpi.duckdns.org
```

Then open this on the remote computer:

```text
http://127.0.0.1:8787
```

The browser talks to your local tunnel, and the tunnel forwards traffic to the editor running privately on the Pi.

### Basic editor workflow

1. Start the local editor.
2. Open the editor in the browser.
3. Use **Problem Queue** to review only flagged facts.
4. Use **All Towns** to browse or edit any town, even if it has no warnings.
5. Edit a fact, approve it, ignore a false-positive flag, mark it as needs fix, delete it, or add a new fact.
6. The editor saves the JSON file and rebuilds `facts-index.json` automatically.
7. Use **Check Git Status** in the editor or run `git status` in the terminal.
8. Review, commit, and push the changes manually.

### Commit edited facts

After using the editor:

```bash
cd ~/town-crier-facts
git status
git diff -- facts facts-index.json

git add facts facts-index.json
git commit -m "Review and edit flagged facts"
git push origin main
```

If you also changed editor code or dependency files, include those files in the commit as appropriate.

### Review metadata

The editor can suppress false-positive QA flags by adding review metadata to an individual fact.

Approved example:

```json
{
  "id": 1,
  "text": "The village incorporated in 1927.",
  "source": "https://en.wikipedia.org/wiki/Example",
  "review": {
    "status": "approved",
    "reviewedAt": "2026-05-08",
    "reviewedBy": "Barry"
  }
}
```

Ignored false-positive example:

```json
{
  "review": {
    "status": "ignore_flag",
    "reviewedAt": "2026-05-08",
    "reviewedBy": "Barry",
    "notes": "Short but acceptable for audio."
  }
}
```

Supported statuses that suppress auto-flags:

- `approved`
- `ignore_flag`
- `reviewed`

Also supported:

```json
"reviewed": true
```

A fact marked as `needs_fix` remains visible as a problem and does not suppress flags.

### Safety notes

- Do not expose the local editor directly to the public internet.
- Prefer SSH tunneling for remote use.
- Keep Git commit/push manual at first, so you can review diffs before publishing.
- The Town Crier app reads fact files from GitHub raw URLs, so pushed JSON edits become available to the app without an Expo update.
- The public Facts Viewer reads `facts-index.json`, so always keep the index rebuilt and pushed after edits.
