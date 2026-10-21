import { z } from "zod";

import { Currency, Cursor, Money, PageQuery, Problem, Timestamp, Uuid7 } from "./common/index.ts";
import { EventEnvelope, listEvents } from "./events/index.ts";

const COMMON = { Currency, Cursor, EventEnvelope, Money, PageQuery, Problem, Timestamp, Uuid7 };

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

/**
 * 2-space JSON laid out the way Prettier does (objects always expanded, arrays of scalars kept
 * on one line when they fit in 100 columns) so committed files pass `prettier --check`.
 */
function pretty(v: unknown, indent: number, prefixLen: number): string {
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    if (v.every((x) => x === null || typeof x !== "object")) {
      const inline = `[${v.map((x) => JSON.stringify(x)).join(", ")}]`;
      // +1 for the trailing comma that may follow.
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

const json = (v: unknown): string => `${pretty(sortKeys(v), 0, 0)}\n`;
const toSchema = (s: z.ZodType) =>
  z.toJSONSchema(s, { target: "draft-2020-12", io: "input", unrepresentable: "any" });

/** Pure: returns file contents keyed by path relative to `generated/`. */
export function generate(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const [name, schema] of Object.entries(COMMON)) {
    files[`jsonschema/${name}.json`] = json(toSchema(schema));
  }
  const channels: Record<string, unknown> = {};
  const messages: Record<string, unknown> = {};
  for (const e of listEvents()) {
    const payload = toSchema(e.schema);
    files[`jsonschema/${e.key}.json`] = json(payload);
    const msg = e.key.replace(/[^A-Za-z0-9]/g, "_");
    messages[msg] = {
      name: e.key,
      contentType: "application/json",
      payload: { schemaFormat: "application/schema+json;version=draft-2020-12", schema: payload },
    };
    channels[msg] = {
      address: e.type.split(".")[0],
      messages: { [msg]: { $ref: `#/components/messages/${msg}` } },
    };
  }
  files["asyncapi.json"] = json({
    asyncapi: "3.0.0",
    info: { title: "wise-biz events", version: "1.0.0" },
    channels,
    components: { messages },
  });
  return files;
}
