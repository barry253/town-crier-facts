#!/usr/bin/env python3
"""
Kokoro synthesis consumer for editor-created towns, run manually on Pi CC
via scripts/process-pending-kokoro.sh (that wrapper handles the dict-rules
git-pull prerequisite before this runs -- this script assumes dict rules
are already current).

Reads pending-kokoro.jsonl (repo root), diffs by slug against
completed-kokoro.jsonl, and for each new slug: fetches the published fact
JSON fresh from R2 (never a local mirror -- matches kokoro-bench's own
house rule), synthesizes welcome + fact-N clips via kokoro-bench's own
Synthesizer (af_heart voice, Experiment C -16 LUFS normalization baked in
by synth.py -- identical pipeline to DS CC's batch scripts, since this
imports the same synth.py rather than reimplementing it), and uploads to
R2 at facts/{slug}/kokoro-af_heart/{clip}.mp3.

All-or-nothing per slug: a completed-kokoro.jsonl entry is only written
once every clip for that slug has synthesized AND uploaded successfully.
A failure at any point (synthesis or upload) rolls back anything already
uploaded to R2 for that slug and leaves no completed-kokoro.jsonl entry,
so a re-run picks the slug back up from scratch rather than leaving a
half-published town (e.g. welcome.mp3 present, fact-0.mp3 missing).

Does NOT touch kokoro-manifest.json / kokoro-batch-status.json -- those
are DS CC's bookkeeping, regenerated periodically from R2 truth.

"Fact JSON changed since queued" is handled by always using current R2
state (the fetch above) rather than any queue-time snapshot -- pending-
kokoro.jsonl only records {slug, addedAt, addedBy}, no content fingerprint,
so there's nothing to diff against; using current state is simply the only
option, not a choice between two.
"""
import json
import os
import shutil
import sys
import time
from datetime import datetime, timezone

KOKORO_BENCH_DIR = os.path.expanduser("~/kokoro-bench")
sys.path.insert(0, KOKORO_BENCH_DIR)

import requests  # noqa: E402
import boto3  # noqa: E402
from botocore.exceptions import ClientError  # noqa: E402

from synth import Synthesizer, VOICE_PATH_SEGMENT  # noqa: E402

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PENDING_PATH = os.path.join(REPO_ROOT, "pending-kokoro.jsonl")
COMPLETED_PATH = os.path.join(REPO_ROOT, "completed-kokoro.jsonl")
FACTS_BASE = "https://pub-1feff31ff8ec4ecfafa5cf1a7a5146c7.r2.dev/facts"
# Same OUT_ROOT convention as kokoro-bench's own batch_common.py -- already
# gitignored (kokoro-bench/.gitignore excludes output/), scratch-only, wiped
# per slug before and after use.
OUT_ROOT = os.path.join(KOKORO_BENCH_DIR, "output", "facts")
UPLOAD_RETRIES = 3


def read_jsonl(path):
    if not os.path.exists(path):
        return []
    out = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out


def r2_client():
    return boto3.client(
        "s3",
        endpoint_url=os.environ["R2_ENDPOINT_URL"],
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )


def fetch_fact_json(slug):
    r = requests.get(f"{FACTS_BASE}/{slug}.json", timeout=15)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return json.loads(r.content.decode("utf-8"))


def build_clips(data):
    town = data.get("town", "")
    facts = data.get("facts", [])
    clips = [("welcome", f"Now entering {town}")]
    for i, f in enumerate(facts):
        text = f["text"] if isinstance(f, dict) else f
        clips.append((f"fact-{i}", text))
    return clips


def upload_with_retries(client, bucket, local_path, key, retries=UPLOAD_RETRIES):
    last_err = None
    for attempt in range(1, retries + 1):
        try:
            client.upload_file(local_path, bucket, key, ExtraArgs={"ContentType": "audio/mpeg"})
            return True, None
        except ClientError as e:
            last_err = str(e)
            time.sleep(2 * attempt)
    return False, last_err


def main():
    pending = read_jsonl(PENDING_PATH)
    completed = read_jsonl(COMPLETED_PATH)

    # Latest pending entry per slug wins -- a re-synthesize request
    # (addedBy: "editor-resync", see editor's /api/town/resync-kokoro)
    # appended after an earlier entry for the same slug should be the one
    # that's compared against completion state below.
    unique_pending = {}
    for e in pending:
        slug = e["slug"]
        if slug not in unique_pending or e.get("addedAt", "") >= unique_pending[slug].get("addedAt", ""):
            unique_pending[slug] = e

    # Latest completed entry per slug -- a slug can legitimately appear more
    # than once here if it's been re-synthesized before.
    completed_by_slug = {}
    for e in completed:
        completed_by_slug[e["slug"]] = e

    # A slug needs (re-)synthesis if it was never completed, OR if it was
    # queued again (addedAt) after its last completion (completedAt) --
    # e.g. a "Re-synthesize Kokoro" click on a town whose facts changed
    # since it was last synthesized. Without this comparison, a resync
    # request would be silently skipped forever as "already done."
    todo = []
    already_done = []
    for slug, e in unique_pending.items():
        c = completed_by_slug.get(slug)
        if c is None or e.get("addedAt", "") > c.get("completedAt", ""):
            todo.append(e)
        else:
            already_done.append(slug)

    print(f"pending-kokoro.jsonl: {len(pending)} line(s), {len(unique_pending)} unique slug(s)")
    print(f"already completed: {len(already_done)}")
    print(f"to synthesize: {len(todo)}")

    if not todo:
        print("\nNothing new to synthesize.")
        print("\n=== Summary ===")
        print("0 new synthesized")
        print("0 failed")
        print(f"{len(already_done)} already done (skipped)")
        return

    client = r2_client()
    bucket = os.environ["R2_BUCKET_NAME"]

    print("\nLoading Kokoro model (one-time)...")
    synthesizer = Synthesizer()

    new_completed = []
    failures = []

    for entry in todo:
        slug = entry["slug"]
        print(f"\n=== {slug} ===")

        data = fetch_fact_json(slug)
        if data is None:
            print(f"  SKIP: facts/{slug}.json not found on R2 (deleted or reverted since queued)")
            failures.append({"slug": slug, "reason": "fact JSON missing on R2 (404)"})
            continue

        clips = build_clips(data)
        out_dir = os.path.join(OUT_ROOT, slug, VOICE_PATH_SEGMENT)
        if os.path.exists(out_dir):
            shutil.rmtree(out_dir)  # no leftover partial files from a prior failed run

        synth_ok = True
        synth_error = None
        for clip_name, text in clips:
            out_path = os.path.join(out_dir, f"{clip_name}.mp3")
            try:
                synthesizer.synthesize(text, out_path)
                print(f"  synthesized {clip_name}.mp3")
            except Exception as e:
                synth_ok = False
                synth_error = f"{clip_name}: {e}"
                break

        if not synth_ok:
            print(f"  FAIL (synthesis): {synth_error}")
            shutil.rmtree(out_dir, ignore_errors=True)
            failures.append({"slug": slug, "reason": f"synthesis failed: {synth_error}"})
            continue

        uploaded_keys = []
        upload_ok = True
        upload_error = None
        for clip_name, _ in clips:
            local_path = os.path.join(out_dir, f"{clip_name}.mp3")
            key = f"facts/{slug}/{VOICE_PATH_SEGMENT}/{clip_name}.mp3"
            ok, err = upload_with_retries(client, bucket, local_path, key)
            if not ok:
                upload_ok = False
                upload_error = f"{clip_name}: {err}"
                break
            uploaded_keys.append(key)
            print(f"  uploaded {key}")

        if not upload_ok:
            print(f"  FAIL (upload): {upload_error}")
            for key in uploaded_keys:
                try:
                    client.delete_object(Bucket=bucket, Key=key)
                except Exception:
                    pass
            shutil.rmtree(out_dir, ignore_errors=True)
            failures.append({"slug": slug, "reason": f"R2 upload failed: {upload_error}"})
            continue

        shutil.rmtree(out_dir, ignore_errors=True)
        completed_entry = {
            "slug": slug,
            "completedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
            "clipCount": len(clips),
            "addedBy": entry.get("addedBy"),
        }
        new_completed.append(completed_entry)
        print(f"  DONE: {len(clips)} clips")

    if new_completed:
        with open(COMPLETED_PATH, "a", encoding="utf-8") as f:
            for e in new_completed:
                f.write(json.dumps(e) + "\n")

    print("\n=== Summary ===")
    print(f"{len(new_completed)} new synthesized")
    print(f"{len(failures)} failed")
    print(f"{len(already_done)} already done (skipped)")
    if failures:
        for fail in failures:
            print(f"  FAILED {fail['slug']}: {fail['reason']}")

    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
