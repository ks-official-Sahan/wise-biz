import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ModuleEntry } from "./migrator.ts";

/** Read modules/registry.json -> entries with migration dirs (`<root>/modules/<m>/migrations`). */
export async function loadRegistry(repoRoot: string): Promise<ModuleEntry[]> {
  const raw: unknown = JSON.parse(
    await readFile(join(repoRoot, "modules", "registry.json"), "utf8"),
  );
  const list = (raw as { modules?: unknown }).modules;
  if (!Array.isArray(list) || !list.every((m) => typeof m === "string")) {
    throw new Error("modules/registry.json: expected { modules: string[] }");
  }
  return list.map((module) => ({
    module,
    dir: join(repoRoot, "modules", module, "migrations"),
  }));
}
