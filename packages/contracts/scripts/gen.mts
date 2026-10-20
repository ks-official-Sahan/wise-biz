import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { generate } from "../src/generate.ts";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "generated");
// Only clear what generate() owns: apps/api writes generated/openapi.json next to these.
rmSync(join(out, "asyncapi.json"), { force: true });
rmSync(join(out, "jsonschema"), { recursive: true, force: true });
for (const [path, content] of Object.entries(generate())) {
  const file = join(out, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}
console.log(`generated ${String(Object.keys(generate()).length)} files in generated/`);
