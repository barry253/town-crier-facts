const fs = require("fs");
const path = require("path");

const repoRoot = path.join(__dirname, "..");
const routesDir = path.join(repoRoot, "routes");
const outputPath = path.join(routesDir, "routes-index.json");

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

const files = collectJsonFiles(routesDir).sort();

const routes = [];

for (const fullPath of files) {
  const relPath = path.relative(repoRoot, fullPath).replace(/\\/g, "/");

  try {
    const raw = fs.readFileSync(fullPath, "utf8");
    const json = JSON.parse(raw);

    const entry = {
      routeId: json.routeId,
      routeName: json.routeName,
      country: json.country,
      state: json.state,
      region: json.region || null,
      updatedAt: json.updatedAt || null,
      file: relPath,
      enabled: json.enabled !== undefined ? json.enabled : true,
      triggerCount: Array.isArray(json.triggers) ? json.triggers.length : 0,
    };

    if (json.bbox !== undefined) entry.bbox = json.bbox;
    if (json.routeCorridorMeters !== undefined) entry.routeCorridorMeters = json.routeCorridorMeters;
    if (json.directions !== undefined) entry.directions = json.directions;
    if (json.shield !== undefined) entry.shield = json.shield;
    if (json.tags !== undefined) entry.tags = json.tags;
    if (json.review !== undefined) entry.review = json.review;

    routes.push(entry);
  } catch (err) {
    console.log(`⚠️ Skipping bad file: ${relPath}`);
    console.log(`   ${err.message}`);
  }
}

routes.sort((a, b) => {
  const country = String(a.country || "").localeCompare(String(b.country || ""));
  if (country !== 0) return country;
  const state = String(a.state || "").localeCompare(String(b.state || ""));
  if (state !== 0) return state;
  return String(a.routeId || "").localeCompare(String(b.routeId || ""));
});

const index = {
  schemaVersion: 1,
  type: "tourGuideRoutesIndex",
  updatedAt: new Date().toISOString().slice(0, 10),
  routes,
};

fs.writeFileSync(outputPath, JSON.stringify(index, null, 2) + "\n");

console.log(`Generated routes/routes-index.json with ${routes.length} route${routes.length === 1 ? "" : "s"}`);
