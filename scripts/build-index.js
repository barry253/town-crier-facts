const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const factsDir = path.join(__dirname, "..", "facts");
const outputPath = path.join(__dirname, "..", "facts-index.json");

function getGitDate(file, format) {
  try {
    return execSync(`git log --follow --format=${format} -- "facts/${file}"`, {
      cwd: path.join(__dirname, ".."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

function getDateAdded(file, fullPath, json) {
  if (json.dateAdded) return json.dateAdded;
  if (json.addedAt) return json.addedAt;
  if (json.createdAt) return json.createdAt;
  if (json.generatedAt) return json.generatedAt;

  const commitDates = getGitDate(file, "%cI");
  if (commitDates.length) return commitDates[commitDates.length - 1];

  return fs.statSync(fullPath).mtime.toISOString();
}

function getLastUpdated(file, fullPath, json) {
  if (json.updatedAt) return json.updatedAt;
  if (json.generatedAt) return json.generatedAt;

  const commitDates = getGitDate(file, "%cI");
  if (commitDates.length) return commitDates[0];

  return fs.statSync(fullPath).mtime.toISOString();
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
    dateAdded: getDateAdded(file, fullPath, json),
    lastUpdated: getLastUpdated(file, fullPath, json),
  };
});

fs.writeFileSync(outputPath, JSON.stringify(index, null, 2));

console.log(`Generated facts-index.json with ${index.length} towns`);
