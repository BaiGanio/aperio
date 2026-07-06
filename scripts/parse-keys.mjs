import { readFileSync, writeFileSync } from "fs";

const src = readFileSync("docs/translations.js", "utf8");

// Find the en block boundaries using brace counting
function extractBlock(src, startIdx) {
  // Start counting from after the opening brace
  let depth = 1;
  let i = startIdx;
  while (depth > 0 && i < src.length) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    i++;
  }
  return src.slice(startIdx, i - 1);
}

// Find the opening of "en" block
const enStart = src.indexOf('"en":');
if (enStart < 0) { console.error("en not found"); process.exit(1); }
const enBrace = src.indexOf('{', enStart);
if (enBrace < 0) { console.error("en brace not found"); process.exit(1); }

const enBlock = extractBlock(src, enBrace + 1);

// Parse all key-value pairs from the en block
const result = {};
const re = /"([a-z_0-9]+)"\s*:\s*("(?:[^"\\]|\\.)*")/g;
let match;
while ((match = re.exec(enBlock)) !== null) {
  result[match[1]] = JSON.parse(match[2]);
}

writeFileSync("scripts/en-output.json", JSON.stringify(result, null, 2));
console.log("Keys:", Object.keys(result).length);
console.log("First few keys:", Object.keys(result).slice(0, 5));
console.log("Last few keys:", Object.keys(result).slice(-5));
