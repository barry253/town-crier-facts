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

const files = fs
  .readdirSync(factsDir)
  .filter((file) => file.endsWith(".json"))
  .sort();

const index = files.map((file) => {
  const fullPath = path.join(factsDir, file);
  const json = JSON.parse(fs.readFileSync(fullPath, "utf8"));

  return {
    file,
    place: json.place || "",
    town: json.town || json.place || file.replace(".json", ""),
    state: json.state || json.region || "",
    country: json.country || "United States",
    slug: json.slug || file.replace(".json", ""),
    dateAdded: getJsonDate(json),
    lastUpdated: getJsonUpdatedDate(json),
  };
});

fs.writeFileSync(outputPath, JSON.stringify(index, null, 2));

console.log(`Generated facts-index.json with ${index.length} towns`);
