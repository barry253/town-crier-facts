#!/usr/bin/env node
const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const factsDir = path.join(repoRoot, 'facts');
const indexPath = path.join(repoRoot, 'facts-index.json');
const landmarksDir = path.join(repoRoot, 'landmarks');
const landmarksIndexPath = path.join(repoRoot, 'landmarks-index.json');
const publicDir = path.join(__dirname, 'public');
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '127.0.0.1';

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

app.use((error, req, res, next) => {
  console.error(error);
  res.status(400).json({ ok: false, error: error.message || String(error) });
});

app.listen(port, host, () => {
  console.log(`Town Crier local facts editor running at http://${host}:${port}`);
  console.log('Local-only by default. Use SSH tunneling for remote access.');
});
