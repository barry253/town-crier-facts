const fs = require("fs");
const path = require("path");

const factsDir = path.join(__dirname, "..", "facts");
const outputPath = path.join(__dirname, "..", "facts-index.json");

const BAD_PATTERNS = [
  /main article:/i,
  /see also/i,
  /external links/i,
  /references/i,
  /wikimedia commons/i,
  /coordinates:/i,
  /retrieved/i,
  /isbn/i,
];
const CONTEXT_STARTERS = [
  "it ",
  "this ",
  "that ",
  "these ",
  "those ",
  "he ",
  "she ",
  "they ",
  "there ",
  "the name ",
  "the park ",
  "the building ",
  "the area ",
];
const GENERIC_STARTERS = ["located in ", "known for ", "home to ", "the town is ", "the city is "];
const END_PUNCTUATION = /[.!?。！？…\"'”’)]$/;
const REVIEWED_STATUSES = new Set(["approved", "ignore_flag", "reviewed"]);

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
    .trim();
}

function cleanText(value) {
  return String(value || "")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isReviewedFact(fact) {
  const status = String(fact?.review?.status || fact?.qa?.status || "").toLowerCase();
  return REVIEWED_STATUSES.has(status) || fact?.reviewed === true;
}

function getFactFlags(text, fact, json) {
  if (isReviewedFact(fact)) return [];

  const raw = String(fact.text || fact.fact || "");
  const cleaned = cleanText(text);
  const lower = cleaned.toLowerCase();
  const flags = [];

  if (BAD_PATTERNS.some((pattern) => pattern.test(cleaned))) {
    flags.push({ severity: "bad", label: "Wikipedia artifact" });
  }
  if (!fact.source) {
    flags.push({ severity: "bad", label: "Missing source" });
  }
  if (
    fact.source &&
    Array.isArray(json.sources) &&
    !json.sources.some((source) => source.url === fact.source)
  ) {
    flags.push({ severity: "warning", label: "Source not in sources list" });
  }
  if (CONTEXT_STARTERS.some((starter) => lower.startsWith(starter))) {
    flags.push({ severity: "warning", label: "May be missing context" });
  }
  if (cleaned.length < 60) {
    flags.push({ severity: "warning", label: "Very short" });
  }
  if (cleaned.length > 280) {
    flags.push({ severity: "warning", label: "Long for audio" });
  }
  if (cleaned && !END_PUNCTUATION.test(cleaned)) {
    flags.push({ severity: "warning", label: "No ending punctuation" });
  }
  if (/\n/.test(raw) || /\s{2,}/.test(raw) || /�/.test(raw)) {
    flags.push({ severity: "warning", label: "Formatting issue" });
  }
  if (GENERIC_STARTERS.some((starter) => lower.startsWith(starter))) {
    flags.push({ severity: "weak", label: "Generic opening" });
  }

  return flags;
}

function summarizeTownQuality(json) {
  const facts = Array.isArray(json.facts) ? json.facts : [];
  const summary = {
    factCount: facts.length,
    reviewedCount: 0,
    badCount: 0,
    warningCount: 0,
    weakCount: 0,
  };

  facts.forEach((fact) => {
    if (isReviewedFact(fact)) summary.reviewedCount += 1;
    const flags = getFactFlags(fact.text || fact.fact || "", fact, json);
    if (flags.some((flag) => flag.severity === "bad")) summary.badCount += 1;
    else if (flags.some((flag) => flag.severity === "warning")) summary.warningCount += 1;
    else if (flags.some((flag) => flag.severity === "weak")) summary.weakCount += 1;
  });

  return summary;
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
    const quality = summarizeTownQuality(json);

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
      ...quality,
      hasIssues: quality.badCount > 0 || quality.warningCount > 0 || quality.weakCount > 0,
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
