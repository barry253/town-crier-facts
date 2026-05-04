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
    .replace(/^,+\s*/, "")
    .replace(/\s+(city|town|village|borough|CDP)$/i, "")
    .trim();
}

const files = fs
  .readdirSync(factsDir)
  .filter((file) => file.endsWith(".json"))
  .sort();

const index = [];

for (const file of files) {
  const fullPath = path.join(factsDir, file);

  try {
    const raw = fs.readFileSync(fullPath, "utf8");
    const json = JSON.parse(raw);

    const rawTown = json.town || json.place || file.replace(".json", "");
    const cleanedTown = cleanDisplayTown(rawTown);

    const state = json.state || json.region || "";
    const country = json.country || "United States";

    const slug = json.slug || file.replace(".json", "");

    const place =
      json.place ||
      (state ? `${cleanedTown}, ${state}` : cleanedTown);

    index.push({
      file,
      place,
      town: cleanedTown,
      state,
      country,
      slug,
      factCount: Array.isArray(json.facts) ? json.facts.length : 0,
      dateAdded: getJsonDate(json),
      lastUpdated: getJsonUpdatedDate(json),
    });

  } catch (err) {
    console.log(`⚠️ Skipping bad file: ${file}`);
    console.log(`   ${err.message}`);
  }
}

fs.writeFileSync(outputPath, JSON.stringify(index, null, 2) + "\n");

console.log(`Generated facts-index.json with ${index.length} towns`);