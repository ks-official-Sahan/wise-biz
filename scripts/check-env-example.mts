import { readFileSync } from "node:fs";

import { ALL_ENV_FRAGMENTS, diffEnvExample } from "../packages/env/src/index.ts";

const text = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
const diff = diffEnvExample(text, ALL_ENV_FRAGMENTS);

const sections: [string, readonly string[]][] = [
  ["missing in .env.example", diff.missing],
  ["unknown in .env.example", diff.unknown],
  ["duplicate in .env.example", diff.duplicate],
  ['comment lacks "(required)"', diff.missingRequiredMarker],
];
for (const [title, keys] of sections) {
  if (keys.length > 0) console.error(`${title}: ${keys.join(", ")}`);
}
if (diff.ok) console.log(".env.example matches env schema");
process.exit(diff.ok ? 0 : 1);
