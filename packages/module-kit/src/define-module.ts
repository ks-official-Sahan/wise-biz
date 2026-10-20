import { isAbsolute } from "node:path";

import { isPermission } from "@wise-biz/policy";

import type { WbModule } from "./types.ts";

const NAME_RE = /^_?[a-z][a-z0-9_]*$/;

/** Validate shape and freeze. Throws on a malformed module so a bad registry entry fails at boot. */
export function defineModule(m: WbModule): WbModule {
  if (!NAME_RE.test(m.name))
    throw new Error(
      `defineModule: invalid name ${JSON.stringify(m.name)} (want ${String(NAME_RE)})`,
    );
  if (!isAbsolute(m.migrationsDir))
    throw new Error(`defineModule(${m.name}): migrationsDir must be an absolute path`);
  if (typeof m.routes !== "function")
    throw new Error(`defineModule(${m.name}): routes must be a function`);
  const seen = new Set<string>();
  for (const p of m.permissions) {
    if (!isPermission(p))
      throw new Error(`defineModule(${m.name}): invalid permission ${String(p)}`);
    if (seen.has(p)) throw new Error(`defineModule(${m.name}): duplicate permission ${p}`);
    seen.add(p);
  }
  return Object.freeze({
    ...m,
    permissions: Object.freeze([...m.permissions]),
    events: Object.freeze([...m.events]),
  });
}
