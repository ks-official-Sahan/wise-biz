import { join } from "node:path";

import { loadRegistry, migrate } from "../src/index.ts";

const url = process.env["DATABASE_MIGRATOR_URL"];
if (!url) {
  console.error("DATABASE_MIGRATOR_URL is required");
  process.exit(1);
}
const root = join(import.meta.dirname, "..", "..", "..");
const applied = await migrate(url, await loadRegistry(root));
console.log(
  applied.length === 0
    ? "up to date"
    : applied.map((a) => `${a.module} ${a.version} ${a.name}`).join("\n"),
);
