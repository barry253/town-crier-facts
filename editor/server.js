#!/usr/bin/env node
const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const readline = require('readline');

const repoRoot = path.resolve(__dirname, '..');
const factsDir = path.join(repoRoot, 'facts');
const indexPath = path.join(repoRoot, 'facts-index.json');
const landmarksDir = path.join(repoRoot, 'landmarks');
const landmarksIndexPath = path.join(repoRoot, 'landmarks-index.json');
const publicDir = path.join(__dirname, 'public');
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '127.0.0.1';
const homeDir = process.env.HOME || '/home/barry';
const bridgesDir = path.join(homeDir, 'town-facts-lab', 'queues', 'bridges');
const labRoot = path.join(homeDir, 'town-facts-lab');
const labOutputDir = path.join(labRoot, 'output');
const pendingKokoroPath = path.join(repoRoot, 'pending-kokoro.jsonl');
const completedKokoroPath = path.join(repoRoot, 'completed-kokoro.jsonl');

let publishInProgress = false;
let townActionInProgress = false;

// Image metadata cache for /api/images/list (avoids reading ~28k files per request)
let imageMetaCache = null; // Map<file, {hasImage, imageSource, imageUrl, imageFocus}>
let imageCacheBuiltAt = 0;
const IMAGE_CACHE_TTL_MS = 60_000;

const DONE_LOG = path.join(labRoot, 'image-pipeline', 'town-images.done.jsonl');
const GAPS_LOG = path.join(labRoot, 'image-pipeline', 'town-images.gaps.jsonl');
let processStateCache = null;
let processStateCacheBuiltAt = 0;
function buildProcessStateCache() {
  const map = new Map();
  for (const logPath of [DONE_LOG, GAPS_LOG]) {
    try {
      const txt = fs.readFileSync(logPath, 'utf8');
      for (const line of txt.split('\n')) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line);
          if (rec && rec.slug) map.set(rec.slug, rec.status || 'unknown');
        } catch {}
      }
    } catch {}
  }
  processStateCache = map;
  processStateCacheBuiltAt = Date.now();
  return map;
}
function getProcessState(refresh) {
  if (refresh || !processStateCache || (Date.now() - processStateCacheBuiltAt) > 15000) {
    return buildProcessStateCache();
  }
  return processStateCache;
}

// Type A slugify — THE ONLY APPROVED SLUG ALGORITHM. See town-facts-lab/GLOSSARY.md.
// Must stay byte-identical to wikipediaResolve.ts's slugify() / generateFacts.ts's
// parsePlaceMetadata() output, since /api/town/generate hands its slug to
// generateFacts.ts and expects the same filename back.
function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Mirrors parsePlaceMetadata()'s two-part "Town, State" branch in
// town-facts-lab/scripts/wikipediaResolve.ts for a recognized US state name.
const US_STATE_ABBR = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA',
  Colorado: 'CO', Connecticut: 'CT', Delaware: 'DE', Florida: 'FL', Georgia: 'GA',
  Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL', Indiana: 'IN', Iowa: 'IA',
  Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA', Maine: 'ME', Maryland: 'MD',
  Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN', Mississippi: 'MS',
  Missouri: 'MO', Montana: 'MT', Nebraska: 'NE', Nevada: 'NV',
  'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY',
  'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH', Oklahoma: 'OK',
  Oregon: 'OR', Pennsylvania: 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC',
  'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT', Vermont: 'VT',
  Virginia: 'VA', Washington: 'WA', 'West Virginia': 'WV', Wisconsin: 'WI',
  Wyoming: 'WY', 'District of Columbia': 'DC',
};

// Runs a subprocess to completion, streaming stdout lines via onLine if given.
// Shared by /api/publish and the town-creation endpoints below.
function runStep(name, cmd, args, cwd, onLine) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { cwd, env: process.env });
    let out = '';
    if (onLine) {
      const rl = readline.createInterface({ input: proc.stdout });
      rl.on('line', (line) => { out += line + '\n'; onLine(line); });
    } else {
      proc.stdout.on('data', (d) => { out += d; });
    }
    proc.stderr.on('data', (d) => { out += d; });
    proc.on('close', (code) => resolve({ name, status: code === 0 ? 'ok' : 'error', output: out.trim(), code }));
  });
}

const REVIEWED_STATUSES = new Set(['approved', 'ignore_flag', 'reviewed']);
const BAD_PATTERNS = [/main article:/i, /see also/i, /external links/i, /references/i, /wikimedia commons/i, /coordinates:/i, /retrieved/i, /isbn/i];
const CONTEXT_STARTERS = ['it ', 'this ', 'that ', 'these ', 'those ', 'he ', 'she ', 'they ', 'there ', 'the name ', 'the park ', 'the building ', 'the area '];
const GENERIC_STARTERS = ['located in ', 'known for ', 'home to ', 'the town is ', 'the city is '];
const END_PUNCTUATION = /[.!?。！？…\"'”’)]$/;

function cleanText(value) {
  return String(value || '').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
}

function isReviewedFact(fact) {
  const status = String(fact?.review?.status || fact?.qa?.status || '').toLowerCase();
  return REVIEWED_STATUSES.has(status) || fact?.reviewed === true;
}

function getFactFlags(text, fact, json) {
  if (isReviewedFact(fact)) return [];
  const raw = String(fact.text || fact.fact || '');
  const cleaned = cleanText(text);
  const lower = cleaned.toLowerCase();
  const flags = [];
  if (BAD_PATTERNS.some((pattern) => pattern.test(cleaned))) flags.push({ severity: 'bad', label: 'Wikipedia artifact' });
  if (!fact.source) flags.push({ severity: 'bad', label: 'Missing source' });
  if (fact.source && Array.isArray(json.sources) && !json.sources.some((source) => source.url === fact.source)) flags.push({ severity: 'warning', label: 'Source not in sources list' });
  if (CONTEXT_STARTERS.some((starter) => lower.startsWith(starter))) flags.push({ severity: 'warning', label: 'May be missing context' });
  if (cleaned.length < 60) flags.push({ severity: 'warning', label: 'Very short' });
  if (cleaned.length > 280) flags.push({ severity: 'warning', label: 'Long for audio' });
  if (cleaned && !END_PUNCTUATION.test(cleaned)) flags.push({ severity: 'warning', label: 'No ending punctuation' });
  if (/\n/.test(raw) || /\s{2,}/.test(raw) || /�/.test(raw)) flags.push({ severity: 'warning', label: 'Formatting issue' });
  if (GENERIC_STARTERS.some((starter) => lower.startsWith(starter))) flags.push({ severity: 'weak', label: 'Generic opening' });
  return flags;
}

function safeLandmarkFile(stateCode, file) {
  if (!stateCode || !/^[a-zA-Z]{2}$/.test(stateCode)) throw new Error('Invalid state code');
  if (!file || typeof file !== 'string') throw new Error('Missing file');
  if (!file.endsWith('.json')) throw new Error('Only JSON landmark files are allowed');
  if (file.includes('/') || file.includes('\\') || file.includes('..')) throw new Error('Invalid file path');
  return path.join(landmarksDir, 'us', stateCode.toLowerCase(), file);
}

function rebuildLandmarksIndex() {
  const result = spawnSync('node', ['scripts/build-landmarks-index.js'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'Landmarks index rebuild failed').trim());
  }
  return result.stdout.trim();
}

function validateFactFileName(file) {
  if (!file || typeof file !== 'string') throw new Error('Missing file');
  if (!file.endsWith('.json')) throw new Error('Only JSON fact files are allowed');
  if (file.includes('/') || file.includes('\\') || file.includes('..')) throw new Error('Invalid file path');
}

function safeFactFile(file) {
  validateFactFileName(file);
  return path.join(factsDir, file);
}

// Published towns live in facts/ (this repo); draft towns created via the
// editor's New Town flow but not yet published only exist in town-facts-lab's
// output/ until a Publish rsyncs them in. Reads/writes check facts/ first
// (the common case) and fall back to output/ so drafts are editable in place.
function resolveFactFilePath(file) {
  validateFactFileName(file);
  const factsPath = path.join(factsDir, file);
  if (fs.existsSync(factsPath)) return factsPath;
  const draftPath = path.join(labOutputDir, file);
  if (fs.existsSync(draftPath)) return draftPath;
  return factsPath;
}

function readFactFile(file) {
  const fullPath = resolveFactFilePath(file);
  return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
}

function writeFactFile(file, json) {
  const fullPath = resolveFactFilePath(file);
  fs.writeFileSync(fullPath, JSON.stringify(json, null, 2) + '\n');
}

function rebuildIndex() {
  const result = spawnSync('node', ['scripts/build-index.js'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'Index rebuild failed').trim());
  }
  return result.stdout.trim();
}

function loadIndex() {
  return JSON.parse(fs.readFileSync(indexPath, 'utf8'));
}

function buildImageMetaCache() {
  const cache = new Map();
  try {
    const files = fs.readdirSync(factsDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const json = JSON.parse(fs.readFileSync(path.join(factsDir, file), 'utf8'));
        let wikipediaUrl = null;
        if (Array.isArray(json.sources)) {
          const wikiSrc = json.sources.find(s => s && /wikipedia/i.test(s.label || ''));
          if (wikiSrc && wikiSrc.url) wikipediaUrl = wikiSrc.url;
          else {
            const anyWiki = json.sources.find(s => s && /en\.wikipedia\.org\/wiki\//.test(s.url || ''));
            if (anyWiki) wikipediaUrl = anyWiki.url;
          }
        }
        cache.set(file, {
          hasImage: !!json.imageUrl,
          imageSource: json.imageSource || null,
          imageUrl: json.imageUrl || null,
          imageFocus: json.imageFocus || null,
          wikipediaUrl,
        });
      } catch { /* skip unreadable files */ }
    }
  } catch { /* skip if dir unreadable */ }
  imageMetaCache = cache;
  imageCacheBuiltAt = Date.now();
}

function getImageMetaCache(refresh) {
  if (!imageMetaCache || refresh || Date.now() - imageCacheBuiltAt > IMAGE_CACHE_TTL_MS) {
    buildImageMetaCache();
  }
  return imageMetaCache;
}

function invalidateImageMeta(file, meta) {
  if (imageMetaCache && meta) {
    const existing = imageMetaCache.get(file) || {};
    imageMetaCache.set(file, { ...existing, ...meta, hasImage: !!(meta.imageUrl ?? existing.imageUrl) });
  }
}

function summarizeFacts(file, town, json) {
  return (Array.isArray(json.facts) ? json.facts : []).map((fact, index) => {
    const text = fact.text || fact.fact || '';
    const flags = getFactFlags(text, fact, json);
    return {
      file,
      place: json.place || town?.place || '',
      town: json.town || town?.town || '',
      state: json.state || json.region || town?.state || '',
      slug: json.slug || town?.slug || file.replace(/\.json$/, ''),
      factIndex: index,
      factNumber: index + 1,
      text,
      source: fact.source || '',
      sourceLabels: fact.sourceLabels || [],
      review: fact.review || null,
      reviewed: isReviewedFact(fact),
      flags,
      worst: flags.some((flag) => flag.severity === 'bad') ? 'bad' : flags.some((flag) => flag.severity === 'warning') ? 'warning' : flags.some((flag) => flag.severity === 'weak') ? 'weak' : '',
    };
  });
}

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(publicDir));

app.get('/api/index', (req, res) => {
  res.json(loadIndex());
});

app.get('/api/town/:file', (req, res) => {
  const file = req.params.file;
  const town = loadIndex().find((item) => item.file === file) || null;
  const json = readFactFile(file);
  res.json({ town, json, facts: summarizeFacts(file, town, json) });
});

app.get('/api/problem-facts', (req, res) => {
  const index = loadIndex();
  const out = [];
  for (const town of index) {
    if (!(town.badCount || town.warningCount || town.weakCount || town.factCount < 6)) continue;
    try {
      const json = readFactFile(town.file);
      for (const fact of summarizeFacts(town.file, town, json)) {
        if (fact.flags.length || town.factCount < 6) out.push(fact);
      }
    } catch (error) {
      out.push({ file: town.file, place: town.place, town: town.town, state: town.state, factIndex: -1, factNumber: 0, text: `Unable to read file: ${error.message}`, flags: [{ severity: 'bad', label: 'Read error' }], worst: 'bad' });
    }
  }
  res.json(out);
});

app.post('/api/fact/save', (req, res) => {
  const { file, factIndex, text, source, sourceLabels, review } = req.body || {};
  const json = readFactFile(file);
  if (!Array.isArray(json.facts)) json.facts = [];
  if (!Number.isInteger(factIndex) || factIndex < 0 || factIndex >= json.facts.length) throw new Error('Invalid fact index');
  json.facts[factIndex].text = String(text || '').trim();
  json.facts[factIndex].source = String(source || '').trim();
  json.facts[factIndex].sourceLabels = Array.isArray(sourceLabels) ? sourceLabels.map(String).filter(Boolean) : [];
  if (review && typeof review === 'object') json.facts[factIndex].review = review;
  writeFactFile(file, json);
  const rebuild = rebuildIndex();
  res.json({ ok: true, rebuild });
});

app.post('/api/fact/review', (req, res) => {
  const { file, factIndex, status = 'approved', notes = '' } = req.body || {};
  const json = readFactFile(file);
  if (!Array.isArray(json.facts)) json.facts = [];
  if (!Number.isInteger(factIndex) || factIndex < 0 || factIndex >= json.facts.length) throw new Error('Invalid fact index');
  json.facts[factIndex].review = {
    status,
    reviewedAt: new Date().toISOString().slice(0, 10),
    reviewedBy: 'Barry',
    ...(notes ? { notes } : {}),
  };
  writeFactFile(file, json);
  const rebuild = rebuildIndex();
  res.json({ ok: true, rebuild });
});

app.post('/api/fact/delete', (req, res) => {
  const { file, factIndex } = req.body || {};
  const json = readFactFile(file);
  if (!Array.isArray(json.facts)) json.facts = [];
  if (!Number.isInteger(factIndex) || factIndex < 0 || factIndex >= json.facts.length) throw new Error('Invalid fact index');
  json.facts.splice(factIndex, 1);
  json.facts.forEach((fact, index) => { fact.id = index + 1; });
  writeFactFile(file, json);
  const rebuild = rebuildIndex();
  res.json({ ok: true, rebuild });
});

app.post('/api/fact/reorder', (req, res) => {
  const { file, order } = req.body || {};
  const json = readFactFile(file);
  if (!Array.isArray(json.facts)) json.facts = [];
  if (!Array.isArray(order) || order.length !== json.facts.length) throw new Error('Invalid order array');
  if (!order.every(i => Number.isInteger(i) && i >= 0 && i < json.facts.length)) throw new Error('Order contains out-of-range indices');
  if (new Set(order).size !== json.facts.length) throw new Error('Order must be a permutation of fact indices');
  json.facts = order.map(i => json.facts[i]);
  writeFactFile(file, json);
  const rebuild = rebuildIndex();
  res.json({ ok: true, rebuild });
});

app.post('/api/fact/add', (req, res) => {
  const { file, text = '', source = '', sourceLabels = [] } = req.body || {};
  const json = readFactFile(file);
  if (!Array.isArray(json.facts)) json.facts = [];
  json.facts.push({
    id: json.facts.length + 1,
    text: String(text || '').trim(),
    source: String(source || '').trim(),
    sourceLabels: Array.isArray(sourceLabels) ? sourceLabels.map(String).filter(Boolean) : [],
    review: { status: 'approved', reviewedAt: new Date().toISOString().slice(0, 10), reviewedBy: 'Barry' },
  });
  writeFactFile(file, json);
  const rebuild = rebuildIndex();
  res.json({ ok: true, rebuild });
});

// Runs the full publish flow (rsync new towns in from town-facts-lab/output/,
// track pending Kokoro entries, rebuild indexes, stage, commit, push) and
// streams SSE step events via `send`. Shared by /api/publish and
// /api/publish-and-synthesize so the two routes can't drift out of sync.
// Deliberately does NOT send a terminal 'done' event or touch
// publishInProgress/res — the caller does that, since
// /api/publish-and-synthesize has a Kokoro-synthesis step to run afterward
// and isn't ready to finish the response when this returns.
async function runPublishFlow(send) {
  const step = (name, cmd, args, onLine) => runStep(name, cmd, args, repoRoot, onLine);

  // Snapshot which output/ files are not yet in facts/ BEFORE anything runs —
  // publish-facts.sh's rsync (invoked below, in the "Sync to R2" step) is what
  // actually copies new town files from town-facts-lab/output/ into facts/.
  // This lets the pending-kokoro step know which slugs were genuinely new to
  // this publish, since after the rsync they'd exist in both directories.
  let newSlugFiles = [];
  try {
    const outputFiles = fs.existsSync(labOutputDir) ? fs.readdirSync(labOutputDir).filter(f => f.endsWith('.json')) : [];
    newSlugFiles = outputFiles.filter(f => !fs.existsSync(path.join(factsDir, f)));
  } catch { /* best-effort; a failure here just skips the pending-kokoro step */ }

  const steps = [];
  try {
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);

    // Runs first and unconditionally: this is what actually copies any new
    // town drafts from town-facts-lab/output/ into facts/ (via publish-facts.
    // sh's rsync). Staging/committing facts/ before this ran was the bug —
    // a brand-new town living only in output/ meant "git add facts" found
    // nothing, so the flow short-circuited on noChanges before ever reaching
    // this step. Safe to always run first: publish-facts.sh's rsync uses
    // --ignore-existing, so an edit-only publish (no new towns pending) is a
    // no-op here, and the flow still short-circuits correctly at the 'check'
    // step below once there's genuinely nothing left to stage.
    send({ type: 'step-start', name: 'Sync to R2' });
    const s5 = await step('Sync to R2', 'bash', [`${homeDir}/town-facts-lab/scripts/publish-facts.sh`],
      (line) => send({ type: 'step-output', name: 'Sync to R2', line }));
    steps.push(s5); send({ type: 'step-done', ...s5 });
    if (s5.status === 'error') return { success: false, steps };

    // Track brand-new editor-created towns for downstream Kokoro synthesis.
    // The Sync to R2 step above is what actually copies these from output/
    // into facts/, so this only runs once that step has succeeded. Only
    // editor-created towns are tracked — pipeline-generated towns (no
    // createdVia field) are already covered by DS CC's regular full-corpus
    // Kokoro batches.
    if (newSlugFiles.length > 0) {
      send({ type: 'step-start', name: 'Record pending Kokoro entries' });
      const nowIso = new Date().toISOString();
      const lines = [];
      for (const f of newSlugFiles) {
        try {
          const published = JSON.parse(fs.readFileSync(path.join(factsDir, f), 'utf8'));
          if (published.createdVia === 'editor-manual' || published.createdVia === 'editor-resolved') {
            lines.push(JSON.stringify({ slug: f.replace(/\.json$/, ''), addedAt: nowIso, addedBy: published.createdVia }));
          }
        } catch { /* file didn't land (rsync skipped it) or isn't readable — skip */ }
      }
      if (lines.length) {
        fs.appendFileSync(pendingKokoroPath, lines.join('\n') + '\n');
        await step('pending-add', 'git', ['add', 'pending-kokoro.jsonl']);
        const pendingCheck = await step('pending-check', 'git', ['diff', '--cached', '--quiet']);
        if (pendingCheck.code !== 0) {
          await step('pending-commit', 'git', ['commit', '-m', `Track ${lines.length} new town(s) for Kokoro synthesis`]);
          await step('pending-push', 'git', ['push', 'origin', 'main']);
        }
        const sPending = { name: 'Record pending Kokoro entries', status: 'ok', output: `${lines.length} entr${lines.length === 1 ? 'y' : 'ies'} appended to pending-kokoro.jsonl.`, code: 0 };
        steps.push(sPending); send({ type: 'step-done', ...sPending });
      } else {
        const sPending = { name: 'Record pending Kokoro entries', status: 'ok', output: 'No editor-created towns in this publish.', code: 0 };
        steps.push(sPending); send({ type: 'step-done', ...sPending });
      }
    }

    send({ type: 'step-start', name: 'Rebuild index' });
    const s1 = await step('Rebuild index', 'node', ['scripts/build-index.js']);
    steps.push(s1); send({ type: 'step-done', ...s1 });
    if (s1.status === 'error') return { success: false, steps };

    send({ type: 'step-start', name: 'Check protected files' });
    const protectedFiles = [];
    try {
      const factFiles = fs.readdirSync(factsDir).filter(f => f.endsWith('.json'));
      for (const file of factFiles) {
        try {
          const json = JSON.parse(fs.readFileSync(path.join(factsDir, file), 'utf8'));
          if (Array.isArray(json.facts) && json.facts.some(isReviewedFact)) {
            protectedFiles.push(file);
          }
        } catch { /* skip unreadable files */ }
      }
    } catch { /* skip if dir unreadable */ }
    const protectOutput = protectedFiles.length > 0
      ? protectedFiles.map(f => `PROTECTED: ${f} contains reviewed facts`).join('\n')
      : 'No reviewed facts found in facts/.';
    const sProtect = { name: 'Check protected files', status: 'ok', output: protectOutput, code: 0 };
    steps.push(sProtect); send({ type: 'step-done', ...sProtect });

    send({ type: 'step-start', name: 'Stage changes' });
    const s2 = await step('Stage changes', 'git', ['add', 'facts', 'facts-index.json', 'landmarks', 'landmarks-index.json', 'neighborhoods']);
    steps.push(s2); send({ type: 'step-done', ...s2 });
    if (s2.status === 'error') return { success: false, steps };

    const check = await step('check', 'git', ['diff', '--cached', '--quiet']);
    if (check.code === 0) {
      return { success: true, noChanges: true, steps };
    }

    send({ type: 'step-start', name: 'Commit' });
    const s3 = await step('Commit', 'git', ['commit', '-m', `Editor publish: ${timestamp}`]);
    steps.push(s3); send({ type: 'step-done', ...s3 });
    if (s3.status === 'error') return { success: false, steps };

    send({ type: 'step-start', name: 'Push to GitHub' });
    const s4 = await step('Push to GitHub', 'git', ['push', 'origin', 'main']);
    steps.push(s4); send({ type: 'step-done', ...s4 });
    if (s4.status === 'error') return { success: false, steps };

    return { success: true, steps };
  } catch (err) {
    return { success: false, error: err.message, steps };
  }
}

app.post('/api/publish', async (req, res) => {
  if (publishInProgress) {
    return res.status(409).json({ ok: false, error: 'A publish is already in progress.' });
  }
  publishInProgress = true;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  try {
    const result = await runPublishFlow(send);
    send({ type: 'done', ...result });
  } finally {
    publishInProgress = false;
    res.end();
  }
});

// Publish, then immediately drain the Kokoro synthesis queue (pending-kokoro.
// jsonl) in the same SSE stream. Deliberately a separate button from Publish,
// not folded into it — a plain publish is ~2min, Kokoro synthesis adds
// 5-10min for a typical new town, and a fast content-only push should stay
// fast. Runs the Kokoro step even when the publish stage itself was a
// no-op (noChanges) — this is also how a per-town "Re-synthesize Kokoro"
// request (see /api/town/resync-kokoro, which only appends to pending-
// kokoro.jsonl and doesn't publish anything) actually gets processed.
app.post('/api/publish-and-synthesize', async (req, res) => {
  if (publishInProgress) {
    return res.status(409).json({ ok: false, error: 'A publish is already in progress.' });
  }
  publishInProgress = true;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  try {
    const publishResult = await runPublishFlow(send);
    if (!publishResult.success) {
      send({ type: 'done', success: false, stage: 'publish', steps: publishResult.steps });
      return;
    }

    // Publish stage succeeded (possibly a noChanges no-op) — the town, if
    // new, is now fully published (committed, pushed, R2-synced) regardless
    // of what happens below. A Kokoro failure here is real (no audio yet)
    // but is never a reason to roll back the publish, which already landed.
    send({ type: 'step-start', name: 'Kokoro synthesis' });
    const kokoroStep = await runStep(
      'Kokoro synthesis', 'bash', [path.join(repoRoot, 'scripts', 'process-pending-kokoro.sh')],
      repoRoot, (line) => send({ type: 'step-output', name: 'Kokoro synthesis', line })
    );
    send({ type: 'step-done', ...kokoroStep });

    send({
      type: 'done',
      success: true,
      publishNoChanges: !!publishResult.noChanges,
      kokoroSuccess: kokoroStep.status === 'ok',
      steps: [...publishResult.steps, kokoroStep],
    });
  } catch (err) {
    send({ type: 'done', success: false, error: err.message });
  } finally {
    publishInProgress = false;
    res.end();
  }
});

// Queues an already-published town for a fresh Kokoro synthesis pass —
// e.g. after editing its facts — without triggering synthesis itself.
// Draining the queue happens via process-pending-kokoro.sh (manual SSH
// dispatch) or the "Publish and Synthesize" button above. Deduplicates
// against any existing pending-kokoro.jsonl entry for the same slug
// (from a New Town publish or an earlier un-drained resync request) so
// repeated clicks don't pile up redundant lines.
app.post('/api/town/resync-kokoro', (req, res) => {
  try {
    const file = req.body?.file;
    if (!file || typeof file !== 'string' || !/^[a-z0-9-]+\.json$/.test(file)) {
      return res.status(400).json({ ok: false, error: 'Invalid file' });
    }
    const slug = file.replace(/\.json$/, '');
    if (!fs.existsSync(path.join(factsDir, file))) {
      return res.status(400).json({ ok: false, error: 'Town is not published yet — publish it first.' });
    }

    const readJsonl = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean) : [])
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);

    // "Already pending" means a queued entry exists that hasn't been
    // drained yet — not merely "this slug appears somewhere in the file."
    // A town that was already synthesized (has a completed-kokoro.jsonl
    // entry) and hasn't been re-queued since is NOT a duplicate — that's
    // exactly the resync case this endpoint exists for. Only block when
    // the latest pending entry for this slug is newer than its latest
    // completion (or there's no completion at all yet).
    const latestPendingAt = readJsonl(pendingKokoroPath)
      .filter(e => e.slug === slug).map(e => e.addedAt || '').sort().pop() || null;
    const latestCompletedAt = readJsonl(completedKokoroPath)
      .filter(e => e.slug === slug).map(e => e.completedAt || '').sort().pop() || null;
    const alreadyPending = latestPendingAt !== null && (latestCompletedAt === null || latestPendingAt > latestCompletedAt);
    if (alreadyPending) {
      return res.json({ ok: true, alreadyPending: true });
    }

    const entry = { slug, addedAt: new Date().toISOString(), addedBy: 'editor-resync' };
    fs.appendFileSync(pendingKokoroPath, JSON.stringify(entry) + '\n');

    // Commit + push immediately, mirroring the New Town publish flow's own
    // pending-kokoro tracking — otherwise pending-kokoro.jsonl is left
    // modified-but-uncommitted until some unrelated future publish happens
    // to touch it. Best-effort: the append to disk is what actually makes
    // the resync request work (process-pending-kokoro.sh reads the local
    // file directly), so a git failure here doesn't undo that.
    let gitSynced = true;
    try {
      spawnSync('git', ['add', 'pending-kokoro.jsonl'], { cwd: repoRoot });
      const diff = spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: repoRoot });
      if (diff.status !== 0) {
        const commit = spawnSync('git', ['commit', '-m', `Queue ${slug} for Kokoro re-synthesis`], { cwd: repoRoot });
        const push = spawnSync('git', ['push', 'origin', 'main'], { cwd: repoRoot });
        gitSynced = commit.status === 0 && push.status === 0;
      }
    } catch { gitSynced = false; }

    res.json({ ok: true, alreadyPending: false, gitSynced });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── New Town creation ──────────────────────────────────────────────────────
// Draft files are written to town-facts-lab's output/ (not facts/ here) —
// the same staging area generateFacts.ts and the batch pipelines already use.
// A normal Publish rsyncs them in via publish-facts.sh, unchanged.

function computeTownSlug(townName, state) {
  return slugify(`${String(townName || '')}, ${String(state || '')}`);
}

app.post('/api/town/new', (req, res) => {
  const { townName, state } = req.body || {};
  if (!townName || !state) throw new Error('townName and state are required');
  const slug = computeTownSlug(townName, state);
  const file = `${slug}.json`;
  const existsInFacts = fs.existsSync(path.join(factsDir, file));
  const existsInOutput = fs.existsSync(path.join(labOutputDir, file));

  if (existsInFacts) {
    return res.json({ slug, existsInFacts: true, existsInOutput, articleResolved: false, articleTitle: null, rejectReason: null });
  }

  const place = `${townName}, ${state}`;
  const result = spawnSync('npx', ['tsx', 'scripts/resolveWikipedia.ts', place], { cwd: labRoot, encoding: 'utf8', timeout: 120000 });
  let resolution = { ok: false, reason: 'Wikipedia resolution failed to run (subprocess error or timeout).' };
  try {
    resolution = JSON.parse((result.stdout || '').trim());
  } catch { /* keep the default failure above */ }

  res.json({
    slug,
    existsInFacts: false,
    existsInOutput,
    articleResolved: !!resolution.ok,
    articleTitle: resolution.ok ? resolution.title : null,
    rejectReason: resolution.ok ? null : resolution.reason,
  });
});

app.post('/api/town/generate', async (req, res) => {
  const { townName, state } = req.body || {};
  if (!townName || !state) throw new Error('townName and state are required');
  if (townActionInProgress) {
    return res.status(409).json({ ok: false, error: 'Another town-creation action is already in progress.' });
  }
  const slug = computeTownSlug(townName, state);
  const file = `${slug}.json`;
  if (fs.existsSync(path.join(factsDir, file))) {
    return res.status(400).json({ ok: false, error: 'Town already exists in corpus.' });
  }

  townActionInProgress = true;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const place = `${townName}, ${state}`;
    send({ type: 'step-start', name: 'Generate facts' });
    const result = await runStep('Generate facts', 'npx', ['tsx', 'scripts/generateFacts.ts', place], labRoot,
      (line) => send({ type: 'step-output', name: 'Generate facts', line }));
    send({ type: 'step-done', ...result });

    if (result.status !== 'ok') {
      send({ type: 'done', success: false, error: result.output || 'Generation failed.' });
      return;
    }

    const outputPath = path.join(labOutputDir, file);
    try {
      const json = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      json.createdVia = 'editor-resolved';
      fs.writeFileSync(outputPath, JSON.stringify(json, null, 2) + '\n');
    } catch (e) {
      send({ type: 'done', success: false, error: `Facts generated but failed to tag createdVia: ${e.message}` });
      return;
    }

    send({ type: 'done', success: true, slug, file });
  } catch (err) {
    send({ type: 'done', success: false, error: err.message });
  } finally {
    townActionInProgress = false;
    res.end();
  }
});

app.post('/api/town/stub', (req, res) => {
  const { townName, state, county, region: regionInput, country: countryInput } = req.body || {};
  if (!townName || !state) throw new Error('townName and state are required');
  const slug = computeTownSlug(townName, state);
  const file = `${slug}.json`;
  if (fs.existsSync(path.join(factsDir, file))) throw new Error('Town already exists in corpus.');

  const abbr = US_STATE_ABBR[state];
  const region = (regionInput && String(regionInput).trim()) || abbr || state;
  const country = (countryInput && String(countryInput).trim()) || (abbr ? 'United States' : '');

  const json = {
    slug,
    place: `${townName}, ${state}`,
    town: String(townName).trim(),
    state: String(state).trim(),
    region,
    country,
    ...(county ? { county: String(county).trim() } : {}),
    sources: [],
    facts: [],
    createdVia: 'editor-manual',
  };

  fs.mkdirSync(labOutputDir, { recursive: true });
  fs.writeFileSync(path.join(labOutputDir, file), JSON.stringify(json, null, 2) + '\n');
  res.json({ ok: true, slug, file });
});

app.get('/api/git-status', (req, res) => {
  const result = spawnSync('git', ['status', '--short'], { cwd: repoRoot, encoding: 'utf8' });
  res.json({ status: result.stdout.trim() });
});

app.get('/api/landmarks/index', (req, res) => {
  if (!fs.existsSync(landmarksIndexPath)) return res.json({ collections: [] });
  res.json(JSON.parse(fs.readFileSync(landmarksIndexPath, 'utf8')));
});

app.get('/api/landmarks/:state/:file', (req, res) => {
  const fullPath = safeLandmarkFile(req.params.state, req.params.file);
  res.json(JSON.parse(fs.readFileSync(fullPath, 'utf8')));
});

app.post('/api/landmark/save', (req, res) => {
  const { state, file, landmarkId, commentaryTemplate, reviewStatus, reviewNotes } = req.body || {};
  const fullPath = safeLandmarkFile(state, file);
  const json = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  const lm = (json.landmarks || []).find((l) => l.id === landmarkId);
  if (!lm) throw new Error(`Landmark "${landmarkId}" not found`);
  lm.commentaryTemplate = String(commentaryTemplate || '').trim();
  if (reviewStatus) {
    lm.review = {
      ...(lm.review || {}),
      status: reviewStatus,
      reviewedAt: new Date().toISOString().slice(0, 10),
      reviewedBy: 'Barry',
      ...(reviewNotes ? { notes: reviewNotes } : {}),
    };
  }
  fs.writeFileSync(fullPath, JSON.stringify(json, null, 2) + '\n');
  const rebuild = rebuildLandmarksIndex();
  res.json({ ok: true, rebuild });
});

app.post('/api/landmark/review', (req, res) => {
  const { state, file, landmarkId, status, notes } = req.body || {};
  const fullPath = safeLandmarkFile(state, file);
  const json = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  const lm = (json.landmarks || []).find((l) => l.id === landmarkId);
  if (!lm) throw new Error(`Landmark "${landmarkId}" not found`);
  lm.review = {
    status: status || 'approved',
    reviewedAt: new Date().toISOString().slice(0, 10),
    reviewedBy: 'Barry',
    ...(notes ? { notes } : {}),
  };
  fs.writeFileSync(fullPath, JSON.stringify(json, null, 2) + '\n');
  const rebuild = rebuildLandmarksIndex();
  res.json({ ok: true, rebuild });
});

// ── Bridges curation API ──────────────────────────────────────────────────────

function readBridgesJsonl(filename) {
  const p = path.join(bridgesDir, filename);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function loadBridgeDecisions() {
  const rows = readBridgesJsonl('manual-decisions.jsonl');
  const map = {};
  for (const r of rows) map[r.wikidataQid] = r; // last write wins
  return map;
}

function loadCandidateFacts() {
  const rows = readBridgesJsonl('candidate-facts.jsonl');
  const map = {};
  for (const r of rows) map[r.wikidataQid] = r; // last write wins
  return map;
}

function loadEnvVar(key) {
  try {
    const envPath = path.join(process.env.HOME || '/home/barry', 'town-facts-lab', '.env');
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m && m[1] === key) return m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch {}
  return process.env[key];
}

function parseLlmJson(raw) {
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  return JSON.parse(cleaned);
}

function buildBridgeFactsPrompt(label, structureType, fullText) {
  const word = structureType === 'tunnel' ? 'tunnel' : 'bridge';
  return `You are creating spoken facts for a location-aware driving app called Town Crier.

${word}: ${label}

Wikipedia article:
${fullText.slice(0, 8000)}

Create exactly 3 interesting facts about this ${word}.

Rules:
- Return JSON only.
- Each fact must be one sentence, 25-40 words.
- Must sound natural when spoken aloud.
- Must include the name of the ${word}.
- Do not start with "There is", "There are", "It", or "This".
- Prefer history, engineering, records, notable events, and distinctive characteristics.
- Each fact must cover a distinct topic.
- Do NOT invent facts; derive them strictly from the article text above.
- Write in a punchy, engaging style suitable for audio narration.
- Avoid generic descriptions; prefer specific dates, names, dimensions, and events.

JSON:
{"facts": [{"id": "f1", "text": "Fact here."}, {"id": "f2", "text": "Fact here."}, {"id": "f3", "text": "Fact here."}]}`;
}

async function fetchWikiFullText(title) {
  try {
    const url = `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=true&titles=${encodeURIComponent(title)}&format=json&formatversion=2`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'TownCrier-Pi/1.0 (barry253@gmail.com)' },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return '';
    const data = await r.json();
    return data?.query?.pages?.[0]?.extract || '';
  } catch { return ''; }
}

async function callOpenRouterWithRetry(messages, model, maxRetries = 3) {
  const apiKey = loadEnvVar('OPENROUTER_API_KEY');
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not found');
  const RETRYABLE = new Set([429, 500, 502, 503, 504]);
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: 512 }),
      signal: AbortSignal.timeout(30000),
    });
    if (r.ok) return r.json();
    if (!RETRYABLE.has(r.status) || attempt === maxRetries) {
      const text = await r.text().catch(() => '');
      throw new Error(`OpenRouter ${r.status}: ${text.slice(0, 200)}`);
    }
    const retryAfter = r.headers.get('retry-after');
    const waitMs = (retryAfter && /^\d+$/.test(retryAfter))
      ? Number(retryAfter) * 1000
      : Math.min(3000 * Math.pow(2, attempt), 30000);
    console.warn(`OpenRouter ${r.status}; retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${maxRetries})`);
    await new Promise(resolve => setTimeout(resolve, waitMs));
  }
}

app.get('/api/bridges/candidates', (req, res) => {
  const candidates = readBridgesJsonl('candidates.jsonl');
  const decisions = loadBridgeDecisions();
  const merged = candidates.map(c => ({
    ...c,
    decision: decisions[c.wikidataQid]?.decision ?? null,
    decisionNotes: decisions[c.wikidataQid]?.notes ?? '',
  }));
  res.json(merged);
});

app.get('/api/bridges/candidate/:qid/extract', async (req, res) => {
  const { qid } = req.params;
  const regen = req.query.regen === 'true';
  const candidates = readBridgesJsonl('candidates.jsonl');
  const c = candidates.find(x => x.wikidataQid === qid);
  if (!c) return res.status(404).json({ ok: false, error: 'Not found' });

  // Wikipedia REST summary
  let extract = null, thumbnail = null, description = null;
  try {
    const encoded = encodeURIComponent(c.wikipediaTitle.replace(/ /g, '_'));
    const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encoded}`, {
      headers: { 'User-Agent': 'TownCrier-Pi/1.0 (barry253@gmail.com)' },
    });
    if (r.ok) {
      const data = await r.json();
      extract = data.extract ?? null;
      thumbnail = data.thumbnail?.source ?? null;
      description = data.description ?? null;
    }
  } catch {}

  // Facts: use cache unless regen=true
  const factsCache = loadCandidateFacts();
  let facts = (!regen && factsCache[qid]?.facts) ? factsCache[qid].facts : null;
  const connectingPointsDisplay = factsCache[qid]?.connectingPointsDisplay ?? null;
  let factsGenerationError = null;

  if (!facts) {
    try {
      const fullText = await fetchWikiFullText(c.wikipediaTitle);
      const model = loadEnvVar('BRIDGE_FACTS_MODEL') || 'openai/gpt-4o-mini';
      const prompt = buildBridgeFactsPrompt(c.label, c.structureType, fullText);
      const completion = await callOpenRouterWithRetry([{ role: 'user', content: prompt }], model);
      const raw = completion?.choices?.[0]?.message?.content ?? '';
      const parsed = parseLlmJson(raw);
      facts = (Array.isArray(parsed?.facts) ? parsed.facts : [])
        .map((f, i) => ({ id: f.id || `f${i + 1}`, text: String(f.text || '').trim() }))
        .filter(f => f.text);
      const row = JSON.stringify({ wikidataQid: qid, slug: c.id, facts, generatedAt: new Date().toISOString(), model });
      fs.mkdirSync(bridgesDir, { recursive: true });
      fs.appendFileSync(path.join(bridgesDir, 'candidate-facts.jsonl'), row + '\n');
    } catch (e) {
      factsGenerationError = e.message;
      facts = [];
    }
  }

  res.json({ extract, thumbnail, description, facts, connectingPointsDisplay, factsGenerationError: factsGenerationError ?? null });
});

app.post('/api/bridges/candidate/:qid/facts', (req, res) => {
  const { qid } = req.params;
  const { facts, connectingPointsDisplay } = req.body || {};
  if (!qid || !Array.isArray(facts)) throw new Error('qid param and facts array required');
  const candidates = readBridgesJsonl('candidates.jsonl');
  const c = candidates.find(x => x.wikidataQid === qid);
  if (!c) return res.status(404).json({ ok: false, error: 'Candidate not found' });
  const clean = facts
    .map((f, i) => ({ id: f.id || `f${i + 1}`, text: String(f.text || '').trim() }))
    .filter(f => f.text);
  const cpClean = typeof connectingPointsDisplay === 'string' ? connectingPointsDisplay.trim() || null : null;
  const row = JSON.stringify({ wikidataQid: qid, slug: c.id, facts: clean, connectingPointsDisplay: cpClean, generatedAt: new Date().toISOString(), model: 'manual' });
  fs.mkdirSync(bridgesDir, { recursive: true });
  fs.appendFileSync(path.join(bridgesDir, 'candidate-facts.jsonl'), row + '\n');
  res.json({ ok: true });
});

app.post('/api/bridges/decision', (req, res) => {
  const { wikidataQid, decision, notes = '' } = req.body || {};
  if (!wikidataQid || !['approved', 'blocked', 'undecided'].includes(decision)) {
    throw new Error('decision must be approved, blocked, or undecided');
  }
  fs.mkdirSync(bridgesDir, { recursive: true });
  const row = JSON.stringify({
    wikidataQid,
    decision,
    decidedAt: new Date().toISOString().slice(0, 10),
    decidedBy: 'Barry',
    notes: String(notes).trim(),
  });
  fs.appendFileSync(path.join(bridgesDir, 'manual-decisions.jsonl'), row + '\n');
  res.json({ ok: true });
});

app.post('/api/bridges/decisions/batch', (req, res) => {
  const { qids, decision, notes = '' } = req.body || {};
  if (!Array.isArray(qids) || !qids.length || !['approved', 'blocked', 'undecided'].includes(decision)) {
    throw new Error('qids array and decision (approved|blocked|undecided) are required');
  }
  fs.mkdirSync(bridgesDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const lines = qids.map(qid => JSON.stringify({ wikidataQid: qid, decision, decidedAt: today, decidedBy: 'Barry', notes: String(notes).trim() }));
  fs.appendFileSync(path.join(bridgesDir, 'manual-decisions.jsonl'), lines.join('\n') + '\n');
  res.json({ ok: true, count: qids.length });
});

// ── Image override API ────────────────────────────────────────────────────────

app.post('/api/image/save', (req, res) => {
  const { file, imageUrl, imageSource, imageAttribution } = req.body || {};
  const json = readFactFile(file);

  if (imageUrl) {
    json.imageUrl = String(imageUrl).trim();
    json.imageSource = imageSource ? String(imageSource).trim() : 'override';
    if (imageAttribution && typeof imageAttribution === 'object') {
      json.imageAttribution = {
        author: String(imageAttribution.author || '').trim(),
        license: String(imageAttribution.license || '').trim(),
        sourceUrl: String(imageAttribution.sourceUrl || '').trim(),
      };
    } else {
      delete json.imageAttribution;
    }
  } else {
    delete json.imageUrl;
    delete json.imageSource;
    delete json.imageAttribution;
  }

  writeFactFile(file, json);
  const rebuild = rebuildIndex();
  res.json({ ok: true, rebuild });
});

app.get('/api/wikimedia-attribution', (req, res) => {
  try {
    const url = req.query.url;
    if (!url || typeof url !== 'string') return res.status(400).json({ ok: false, error: 'url param required' });
    const r = spawnSync('npx', ['tsx', 'scripts/resolveAttribution.ts', url], { cwd: labRoot, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 30000 });
    if (r.status !== 0) return res.status(500).json({ ok: false, error: (r.stderr || '').slice(0, 200) });
    const out = JSON.parse((r.stdout || '').trim().split('\n').pop());
    res.json(out);
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

// ── Image workbench API ───────────────────────────────────────────────────────

app.get('/api/images/states', (req, res) => {
  try {
    const idx = loadIndex();
    const counts = new Map();
    for (const e of idx) {
      const region = e.state || e.region || e.country || '';
      if (!region) continue;
      counts.set(region, (counts.get(region) || 0) + 1);
    }
    const toSuffix = (name) => name.toLowerCase().replace(/\s+/g, '-');
    const states = [...counts.entries()]
      .map(([name, count]) => ({ name, suffix: toSuffix(name), count }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ states });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/images/list', (req, res) => {
  const { filter = 'all', state, search, page: pageStr = '1', pageSize: pageSizeStr = '60', refresh } = req.query;
  const pageSize = Math.max(1, parseInt(pageSizeStr, 10) || 60);
  const page = Math.max(1, parseInt(pageStr, 10) || 1);

  const index = loadIndex();
  const cache = getImageMetaCache(refresh === '1');
  const pstate = getProcessState(refresh === '1');

  // State/search filter first
  const candidates = index.filter(town => {
    if (state && !town.file.endsWith(`-${state}.json`)) return false;
    if (search) {
      const q = String(search).toLowerCase();
      if (!(town.place || town.slug || '').toLowerCase().includes(q)) return false;
    }
    return true;
  });

  // Attach processState to each candidate
  const withState = candidates.map(town => {
    const meta = cache.get(town.file) || { hasImage: false, imageSource: null, imageUrl: null, imageFocus: null };
    const logStatus = pstate.get(town.file.replace(/\.json$/, '')) || null;
    let processState;
    if (meta.imageUrl) processState = 'has_image';
    else if (logStatus === 'no_image' || logStatus === 'error') processState = 'no_image';
    else if (logStatus) processState = 'has_image';
    else processState = 'unprocessed';
    return { town, meta, processState };
  });

  // Compute stateCounts before processState filter
  const stateCounts = { has_image: 0, no_image: 0, unprocessed: 0, override: 0 };
  for (const i of withState) {
    stateCounts[i.processState] = (stateCounts[i.processState] || 0) + 1;
    if (i.meta.imageSource === 'override') stateCounts.override++;
  }

  // Apply processState/override filter
  let filtered = withState;
  if (filter === 'has_image' || filter === 'hasimage') filtered = withState.filter(i => i.processState === 'has_image');
  else if (filter === 'no_image' || filter === 'missing') filtered = withState.filter(i => i.processState === 'no_image');
  else if (filter === 'unprocessed') filtered = withState.filter(i => i.processState === 'unprocessed');
  else if (filter === 'override') filtered = withState.filter(i => i.meta.imageSource === 'override');

  filtered.sort((a, b) => (a.town.place || a.town.slug || '').localeCompare(b.town.place || b.town.slug || ''));

  const total = filtered.length;
  const totalPages = Math.ceil(total / pageSize) || 1;
  const offset = (page - 1) * pageSize;
  const pageItems = filtered.slice(offset, offset + pageSize);

  const items = pageItems.map(({ town, meta, processState }) => ({
    file: town.file,
    slug: town.slug || town.file.replace(/\.json$/, ''),
    town: town.town || town.place || '',
    state: town.state || '',
    imageUrl: meta.imageUrl,
    imageSource: meta.imageSource,
    imageFocus: meta.imageFocus,
    wikipediaUrl: meta.wikipediaUrl || null,
    processState,
  }));

  res.json({ total, page, pageSize, totalPages, stateCounts, items });
});

app.post('/api/image/save-focus', (req, res) => {
  try {
    const { file, imageFocus } = req.body || {};
    if (!file || !imageFocus) return res.status(400).json({ ok:false, error:'missing file or imageFocus' });
    const clamp = v => Math.min(1, Math.max(0, Number(v)));
    const focus = { x: Number(clamp(imageFocus.x).toFixed(3)), y: Number(clamp(imageFocus.y).toFixed(3)) };
    const json = readFactFile(file);
    json.imageFocus = focus;
    writeFactFile(file, json);
    invalidateImageMeta(file, { imageUrl: json.imageUrl||null, imageSource: json.imageSource||null, imageFocus: focus });
    res.json({ ok:true, imageFocus: focus });
  } catch (e) { res.status(500).json({ ok:false, error:String(e) }); }
});

app.post('/api/image/reset-focus', (req, res) => {
  try {
    const { file } = req.body || {};
    if (!file) return res.status(400).json({ ok:false, error:'missing file' });
    const slug = file.replace(/\.json$/, '');
    const r = spawnSync('npx', ['tsx', 'scripts/resetFocalPoint.ts', slug], { cwd: labRoot, encoding:'utf8', maxBuffer: 10*1024*1024, timeout: 60000 });
    if (r.status !== 0) return res.status(500).json({ ok:false, error: (r.stderr||'').slice(0,300) });
    const out = JSON.parse((r.stdout||'').trim().split('\n').pop());
    if (out.error) return res.json({ ok:false, error: out.error });
    res.json({ ok:true, imageFocus: { x: out.x, y: out.y } });
  } catch (e) { res.status(500).json({ ok:false, error:String(e) }); }
});

app.post('/api/image/suggest', (req, res) => {
  try {
    const { file } = req.body || {};
    if (!file) return res.status(400).json({ ok:false, error:'missing file' });
    const slug = file.replace(/\.json$/, '');
    const r = spawnSync('npx', ['tsx', 'scripts/suggestTownImage.ts', slug], { cwd: labRoot, encoding:'utf8', maxBuffer: 10*1024*1024, timeout: 90000 });
    if (r.status !== 0) return res.status(500).json({ ok:false, error: (r.stderr||'').slice(0,300) });
    const out = JSON.parse((r.stdout||'').trim().split('\n').pop());
    res.json({ ok:true, ...out });
  } catch (e) { res.status(500).json({ ok:false, error:String(e) }); }
});

app.post('/api/image/build', (req, res) => {
  try {
    const { file, imageUrl, imageAttribution } = req.body || {};
    if (!file) return res.status(400).json({ ok:false, error:'missing file' });
    const slug = file.replace(/\.json$/, '');
    const args = ['tsx', 'scripts/buildTownImage.ts', slug, '--force'];
    if (imageUrl) args.push('--source-url=' + imageUrl);
    if (imageUrl && imageAttribution && typeof imageAttribution === 'object') {
      args.push('--attribution=' + JSON.stringify({
        author: String(imageAttribution.author || '').trim(),
        license: String(imageAttribution.license || '').trim(),
        sourceUrl: String(imageAttribution.sourceUrl || '').trim(),
      }));
    }
    const r = spawnSync('npx', args, { cwd: labRoot, encoding:'utf8', maxBuffer: 10*1024*1024, timeout: 120000 });
    if (r.status !== 0) return res.status(500).json({ ok:false, error: (r.stderr||'').slice(0,300) });
    const out = JSON.parse((r.stdout||'').trim().split('\n').pop());
    invalidateImageMeta(file, { imageUrl: out.r2Url||null, imageSource: 'wikipedia', imageFocus: out.focusX!=null?{x:out.focusX,y:out.focusY}:null });
    res.json({ ok:true, result: out });
  } catch (e) { res.status(500).json({ ok:false, error:String(e) }); }
});

app.get('/api/kokoro-clips/:slug', async (req, res) => {
  const { slug } = req.params;
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) return res.status(400).json({ ok: false, error: 'Invalid slug' });

  const factFile = path.join(factsDir, `${slug}.json`);
  let factCount = 0;
  try {
    const json = JSON.parse(fs.readFileSync(factFile, 'utf8'));
    factCount = Array.isArray(json.facts) ? json.facts.length : 0;
  } catch { /* file not found or unreadable — factCount stays 0 */ }

  const base = `https://pub-1feff31ff8ec4ecfafa5cf1a7a5146c7.r2.dev/facts/${slug}/kokoro-af_heart`;
  const checks = ['welcome', ...Array.from({ length: factCount }, (_, i) => `fact-${i}`)];

  const results = await Promise.all(checks.map(async (name) => {
    try {
      const r = await fetch(`${base}/${name}.mp3`, {
        method: 'HEAD',
        signal: AbortSignal.timeout(5000),
      });
      return r.ok;
    } catch {
      return false;
    }
  }));

  const [welcome, ...factClips] = results;
  res.json({ ok: true, welcome, facts: factClips });
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(400).json({ ok: false, error: error.message || String(error) });
});

app.listen(port, host, () => {
  console.log(`Town Crier local facts editor running at http://${host}:${port}`);
  console.log('Local-only by default. Use SSH tunneling for remote access.');
});
