#!/usr/bin/env bash
# Manual Kokoro synthesis dispatch for editor-created towns. Run from the
# Pi (SSH in, cd ~/town-crier-facts, ./scripts/process-pending-kokoro.sh).
#
# Hard prerequisite: kokoro-bench's pronunciation-overrides.json must be
# current before any synthesis happens, or Kokoro clips diverge from the
# rest of the corpus in pronunciation quality. This script always pulls
# kokoro-bench first and ABORTS (no synthesis) if the pull fails -- never
# falls back to silently using whatever dict rules happen to already be on
# disk.
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KOKORO_BENCH_DIR="$HOME/kokoro-bench"
KOKORO_ENV_PY="$HOME/kokoro-env/bin/python3"
R2_ENV_FILE="$HOME/.config/town-crier/r2-kokoro.env"

echo "=== Dict rules sync ==="

if [[ ! -d "$KOKORO_BENCH_DIR/.git" ]]; then
  echo "ERROR: $KOKORO_BENCH_DIR is not a git clone of kokoro-bench."
  echo "Run: git clone https://github.com/barry253/kokoro-bench.git $KOKORO_BENCH_DIR"
  exit 1
fi

cd "$KOKORO_BENCH_DIR"
BEFORE=$(git rev-parse --short HEAD)
if ! git pull --ff-only origin main; then
  echo ""
  echo "ERROR: git pull failed for kokoro-bench (network, credentials, or a"
  echo "non-fast-forward local change). ABORTING -- refusing to synthesize"
  echo "with possibly-stale pronunciation-overrides.json."
  exit 1
fi
AFTER=$(git rev-parse --short HEAD)

if [[ "$BEFORE" == "$AFTER" ]]; then
  RULES_CHANGED="up to date"
else
  RULES_CHANGED=$("$KOKORO_ENV_PY" - "$BEFORE" "$AFTER" <<'PYEOF'
import json, subprocess, sys
before, after = sys.argv[1], sys.argv[2]
def load(rev):
    try:
        out = subprocess.run(["git", "show", f"{rev}:data/pronunciation-overrides.json"],
                              capture_output=True, text=True, check=True).stdout
        return json.loads(out)
    except Exception:
        return {}
b, a = load(before), load(after)
changed = sum(1 for k in a if b.get(k) != a.get(k)) + sum(1 for k in b if k not in a)
print(changed)
PYEOF
)
fi

echo "Local commit before sync: $BEFORE"
echo "Local commit after sync:  $AFTER"
echo "Rules changed: $RULES_CHANGED"
echo ""

if [[ ! -r "$R2_ENV_FILE" ]]; then
  echo "ERROR: R2 credentials file not found: $R2_ENV_FILE"
  exit 1
fi
# shellcheck disable=SC1090
set -a
source "$R2_ENV_FILE"
set +a

echo "=== Synthesis ==="
cd "$REPO_ROOT"
set +e
"$KOKORO_ENV_PY" "$REPO_ROOT/scripts/kokoro_consume.py"
SYNTH_EXIT=$?
set -e

# Commit + push completed-kokoro.jsonl if this run added anything, so the
# ledger stays in sync across machines/sessions. Best-effort: a commit/push
# failure here doesn't undo the synthesis or R2 uploads that already
# succeeded, just means the ledger update needs a manual push later.
cd "$REPO_ROOT"
if ! git diff --quiet -- completed-kokoro.jsonl 2>/dev/null || [[ -n "$(git status --porcelain -- completed-kokoro.jsonl)" ]]; then
  echo ""
  echo "=== Recording completed-kokoro.jsonl ==="
  git add completed-kokoro.jsonl
  if ! git diff --cached --quiet -- completed-kokoro.jsonl; then
    git commit -m "Record Kokoro synthesis completions"
    git push origin main
  fi
fi

exit "$SYNTH_EXIT"
