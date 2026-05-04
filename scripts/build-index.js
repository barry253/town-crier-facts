const fs = require("fs");
const path = require("path");

const factsDir = path.join(__dirname, "..", "facts");
const outputPath = path.join(__dirname, "..", "facts-index.json");

function getJsonDate(json) {
  return (
    json.dateAdded ||
    json.addedAt ||
    json.createdAt ||
    json.generatedAt ||
    json.date ||
    ""
  );
}

function getJsonUpdatedDate(json) {
  return (
    json.lastUpdated ||
    json.updatedAt ||
    json.generatedAt ||
    json.dateAdded ||
    json.addedAt ||
    json.createdAt ||
    json.date ||
    ""
  );
}

function cleanDisplayTown(name) {
  return String(name || "")
    .replace(/\s+(city|town|village|borough|CDP)$/i, "")
    .trim();
}

const index = files.map((file) => {
  const fullPath = path.join(factsDir, file);
  const json = JSON.parse(fs.readFileSync(fullPath, "utf8"));

  const rawTown = json.town || json.place || file.replace(".json", "");
  const cleanedTown = cleanDisplayTown(rawTown);

  const state = json.state || json.region || "";
  const country = json.country || "United States";

  const slug = json.slug || file.replace(".json", "");

  return {
    file,
    place: json.place || `${cleanedTown}, ${state}`,
    town: cleanedTown,
    state,
    country,
    slug,
    factCount: Array.isArray(json.facts) ? json.facts.length : 0,
    dateAdded: getJsonDate(json),
    lastUpdated: getJsonUpdatedDate(json),
  };
});

fs.writeFileSync(outputPath, JSON.stringify(index, null, 2));

console.log(`Generated facts-index.json with ${index.length} towns`);
