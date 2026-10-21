import { createApp, openapiInfo } from "./app.ts";
import { createLogger } from "./logger.ts";

import type { WbModule } from "@wise-biz/module-kit";
import type pg from "pg";

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => [k, sortKeys(x)]),
    );
  }
  return v;
}

const WIDTH = 100;

/** 2-space JSON laid out like Prettier (objects expanded, scalar arrays inline when they fit). */
function pretty(v: unknown, indent: number, prefixLen: number): string {
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    if (v.every((x) => x === null || typeof x !== "object")) {
      const inline = `[${v.map((x) => JSON.stringify(x)).join(", ")}]`;
      if (indent + prefixLen + inline.length + 1 <= WIDTH) return inline;
    }
    const pad = " ".repeat(indent + 2);
    return `[\n${v.map((x) => pad + pretty(x, indent + 2, 0)).join(",\n")}\n${" ".repeat(indent)}]`;
  }
  if (v !== null && typeof v === "object") {
    const entries = Object.entries(v);
    if (entries.length === 0) return "{}";
    const pad = " ".repeat(indent + 2);
    const body = entries.map(([k, x]) => {
      const key = `${JSON.stringify(k)}: `;
      return pad + key + pretty(x, indent + 2, key.length);
    });
    return `{\n${body.join(",\n")}\n${" ".repeat(indent)}}`;
  }
  return JSON.stringify(v);
}

/**
 * Deterministic OpenAPI 3.1 document for the given modules. Registers routes only: the pool and redis
 * are never touched, so no database is needed.
 */
export function buildOpenApi(modules: readonly WbModule[]): string {
  const app = createApp({
    modules,
    pool: {} as pg.Pool,
    redis: { ping: () => Promise.resolve("PONG") },
    env: { NODE_ENV: "test", API_DEV_AUTH: false, CORS_ORIGINS: [] },
    logger: createLogger("silent"),
  });
  const doc = app.getOpenAPI31Document(openapiInfo);
  return `${pretty(sortKeys(doc), 0, 0)}\n`;
}
