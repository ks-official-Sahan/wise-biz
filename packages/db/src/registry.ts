import { readFile, realpath } from "node:fs/promises";
import { join, sep } from "node:path";

import { assertModuleName } from "./migrator.ts";

import type { ModuleEntry } from "./migrator.ts";

/**
 * Read modules/registry.json -> entries with migration dirs (`<root>/modules/<m>/migrations`).
 * Names are validated and the resolved (symlink-free) dir must stay inside `<root>/modules/`.
 */
export async function loadRegistry(repoRoot: string): Promise<ModuleEntry[]> {
  const raw: unknown = JSON.parse(
    await readFile(join(repoRoot, "modules", "registry.json"), "utf8"),
  );
  const list = (raw as { modules?: unknown }).modules;
  if (!Array.isArray(list) || !list.every((m) => typeof m === "string")) {
    throw new Error("modules/registry.json: expected { modules: string[] }");
  }
  const base = join(await realpath(repoRoot), "modules");
  const out: ModuleEntry[] = [];
  for (const module of list) {
    assertModuleName(module);
    const dir = join(base, module, "migrations");
    let real = dir;
    try {
      real = await realpath(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; // not created yet: no files
    }
    if (!real.startsWith(base + sep))
      throw new Error(`${module}: migration dir resolves outside ${base}`);
    out.push({ module, dir });
  }
  return out;
}

/**
 * Schemas (module names) that are GLOBAL: no tenant_id, no RLS, reachable only by their own role (identity).
 * `global` is optional in modules/registry.json and every entry must also be listed in `modules`.
 */
export async function loadGlobalSchemas(repoRoot: string): Promise<string[]> {
  const raw: unknown = JSON.parse(
    await readFile(join(repoRoot, "modules", "registry.json"), "utf8"),
  );
  const { modules, global } = raw as { modules?: unknown; global?: unknown };
  if (global === undefined) return [];
  if (!Array.isArray(global) || !global.every((m) => typeof m === "string")) {
    throw new Error("modules/registry.json: expected global: string[]");
  }
  const known = new Set(Array.isArray(modules) ? (modules as string[]) : []);
  for (const module of global) {
    assertModuleName(module);
    if (!known.has(module)) {
      throw new Error(`modules/registry.json: global "${module}" is not in modules`);
    }
  }
  return global;
}
