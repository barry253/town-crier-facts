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
const bridgesDir = path.join(process.env.HOME || '/home/barry', 'town-facts-lab', 'queues', 'bridges');

let publishInProgress = false;

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

function safeFactFile(file) {
  if (!file || typeof file !== 'string') throw new Error('Missing file');
  if (!file.endsWith('.json')) throw new Error('Only JSON fact files are allowed');
  if (file.includes('/') || file.includes('\\') || file.includes('..')) throw new Error('Invalid file path');
  return path.join(factsDir, file);
}

function readFactFile(file) {
  const fullPath = safeFactFile(file);
  return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
}

function writeFactFile(file, json) {
  const fullPath = safeFactFile(file);
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

  function runStep(name, cmd, args, onLine) {
    return new Promise((resolve) => {
      const proc = spawn(cmd, args, { cwd: repoRoot, env: process.env });
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

  const steps = [];
  try {
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);

    send({ type: 'step-start', name: 'Rebuild index' });
    const s1 = await runStep('Rebuild index', 'node', ['scripts/build-index.js']);
    steps.push(s1); send({ type: 'step-done', ...s1 });
    if (s1.status === 'error') { send({ type: 'done', success: false, steps }); publishInProgress = false; res.end(); return; }

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
    const s2 = await runStep('Stage changes', 'git', ['add', 'facts', 'facts-index.json', 'landmarks', 'landmarks-index.json', 'neighborhoods']);
    steps.push(s2); send({ type: 'step-done', ...s2 });
    if (s2.status === 'error') { send({ type: 'done', success: false, steps }); publishInProgress = false; res.end(); return; }

    const check = await runStep('check', 'git', ['diff', '--cached', '--quiet']);
    if (check.code === 0) {
      send({ type: 'done', success: true, noChanges: true, steps });
      publishInProgress = false; res.end(); return;
    }

    send({ type: 'step-start', name: 'Commit' });
    const s3 = await runStep('Commit', 'git', ['commit', '-m', `Editor publish: ${timestamp}`]);
    steps.push(s3); send({ type: 'step-done', ...s3 });
    if (s3.status === 'error') { send({ type: 'done', success: false, steps }); publishInProgress = false; res.end(); return; }

    send({ type: 'step-start', name: 'Push to GitHub' });
    const s4 = await runStep('Push to GitHub', 'git', ['push', 'origin', 'main']);
    steps.push(s4); send({ type: 'step-done', ...s4 });
    if (s4.status === 'error') { send({ type: 'done', success: false, steps }); publishInProgress = false; res.end(); return; }

    send({ type: 'step-start', name: 'Sync to R2' });
    const homeDir = process.env.HOME || '/home/barry';
    const s5 = await runStep('Sync to R2', 'bash', [`${homeDir}/town-facts-lab/scripts/publish-facts.sh`],
      (line) => send({ type: 'step-output', name: 'Sync to R2', line }));
    steps.push(s5); send({ type: 'step-done', ...s5 });

    send({ type: 'done', success: s5.status === 'ok', steps });
  } catch (err) {
    send({ type: 'done', success: false, error: err.message, steps });
  } finally {
    publishInProgress = false;
    res.end();
  }
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

app.get('/api/wikimedia-attribution', async (req, res) => {
  const { url } = req.query;
  if (!url || typeof url !== 'string') return res.status(400).json({ ok: false, error: 'url param required' });

  // Extract bare filename (no File: prefix) from either URL format:
  //   Description: https://commons.wikimedia.org/wiki/File:Foo.jpg
  //   Direct:      https://upload.wikimedia.org/wikipedia/commons/X/XX/Foo.jpg
  let filename = null;
  const descMatch = url.match(/\/wiki\/File:([^?#]+)$/i);
  if (descMatch) {
    filename = decodeURIComponent(descMatch[1]);
  } else {
    const directMatch = url.match(/\/wikipedia\/commons\/[^/]+\/[^/]+\/([^/?#]+)$/i);
    if (directMatch) filename = decodeURIComponent(directMatch[1]);
  }
  if (!filename) return res.status(400).json({ ok: false, error: 'Could not extract filename from URL. Paste a Wikimedia Commons description or upload URL.' });

  const apiUrl = `https://commons.wikimedia.org/w/api.php?action=query&titles=File:${encodeURIComponent(filename)}&prop=imageinfo&iiprop=extmetadata|url|user&format=json&formatversion=2`;

  try {
    const r = await fetch(apiUrl, {
      headers: { 'User-Agent': 'TownCrier-Pi/1.0 (barry253@gmail.com)' },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error(`Wikimedia API returned ${r.status}`);
    const data = await r.json();
    const page = data?.query?.pages?.[0];
    if (!page || page.missing) return res.status(404).json({ ok: false, error: `File not found on Wikimedia Commons (tried: File:${filename})` });

    const info = page?.imageinfo?.[0] || {};
    const meta = info.extmetadata || {};
    const stripHtml = (s) => String(s || '').replace(/<[^>]+>/g, '').trim();

    res.json({
      ok: true,
      directUrl: info.url || null,
      author: stripHtml(meta.Artist?.value),
      license: stripHtml(meta.LicenseShortName?.value),
      sourceUrl: info.descriptionurl || '',
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
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
