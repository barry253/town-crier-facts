const fs = require("fs");
const path = require("path");

const repoRoot = path.join(__dirname, "..");
const landmarksDir = path.join(repoRoot, "landmarks");
const outputPath = path.join(repoRoot, "landmarks-index.json");

function collectJsonFiles(dir, results = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsonFiles(fullPath, results);
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      if (fullPath !== outputPath) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

function computeBbox(landmarks) {
  const lats = [];
  const lons = [];

  for (const lm of landmarks) {
    const geo = lm.geometry;
    if (!geo) continue;

    if (geo.type === "point") {
      if (geo.latitude != null) lats.push(geo.latitude);
      if (geo.longitude != null) lons.push(geo.longitude);
    } else if (geo.type === "polygon" && Array.isArray(geo.coordinates)) {
      for (const pair of geo.coordinates) {
        if (Array.isArray(pair) && pair.length >= 2) {
          lats.push(pair[0]);
          lons.push(pair[1]);
        }
      }
    }
  }

  if (lats.length === 0 || lons.length === 0) return null;

  return {
    minLatitude: Math.min(...lats),
    maxLatitude: Math.max(...lats),
    minLongitude: Math.min(...lons),
    maxLongitude: Math.max(...lons),
  };
}

const files = collectJsonFiles(landmarksDir).sort();

const collections = [];

for (const fullPath of files) {
  const relPath = path.relative(repoRoot, fullPath).replace(/\\/g, "/");

  try {
    const raw = fs.readFileSync(fullPath, "utf8");
    const json = JSON.parse(raw);

    const landmarks = Array.isArray(json.landmarks) ? json.landmarks : [];

    const entry = {
      region: json.region || null,
      country: json.country || null,
      state: json.state || null,
      updatedAt: json.updatedAt || null,
      file: relPath,
      landmarkCount: landmarks.length,
      bbox: computeBbox(landmarks),
    };

    collections.push(entry);
  } catch (err) {
    console.log(`⚠️ Skipping bad file: ${relPath}`);
    console.log(`   ${err.message}`);
  }
}

collections.sort((a, b) => {
  const country = String(a.country || "").localeCompare(String(b.country || ""));
  if (country !== 0) return country;
  const state = String(a.state || "").localeCompare(String(b.state || ""));
  if (state !== 0) return state;
  return String(a.region || "").localeCompare(String(b.region || ""));
});

const index = {
  schemaVersion: 1,
  type: "landmarksIndex",
  updatedAt: new Date().toISOString().slice(0, 10),
  collections,
};

fs.writeFileSync(outputPath, JSON.stringify(index, null, 2) + "\n");

console.log(`Generated landmarks-index.json with ${collections.length} collection${collections.length === 1 ? "" : "s"}`);
