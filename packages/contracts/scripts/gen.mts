import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { generate } from "../src/generate.ts";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "generated");
rmSync(out, { recursive: true, force: true });
for (const [path, content] of Object.entries(generate())) {
  const file = join(out, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}
console.log(`generated ${readdirSync(out).length} entries in generated/`);
