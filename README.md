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

The Facts Viewer reads `facts-index.json` first for fast filtering. The index rebuild precomputes:

- `factCount`
- `badCount`
- `warningCount`
- `weakCount`
- `hasIssues`

Because those values are precomputed during `node scripts/build-index.js`, the viewer does not need to load every individual town JSON file on startup.
