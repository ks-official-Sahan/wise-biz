import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ALL_ENV_FRAGMENTS, diffEnvExample, envKeys } from "./index.ts";

import type { EnvShape } from "./index.ts";

const frags: Record<string, EnvShape> = {
  a: { REQ: z.string(), OPT: z.string().optional(), DEF: z.string().default("x") },
};

const good = `# --- a ---
# (required) needed
REQ=
# optional
OPT=
# default
DEF=x
`;

describe("envKeys", () => {
  it("derives required from zod", () => {
    const req = Object.fromEntries(envKeys(frags).map((k) => [k.key, k.required]));
    expect(req).toEqual({ REQ: true, OPT: false, DEF: false });
  });
});

describe("diffEnvExample", () => {
  it("matches", () => {
    expect(diffEnvExample(good, frags).ok).toBe(true);
  });

  it("reports missing and unknown", () => {
    const d = diffEnvExample(good.replace("OPT=", "EXTRA="), frags);
    expect(d.missing).toEqual(["OPT"]);
    expect(d.unknown).toEqual(["EXTRA"]);
    expect(d.ok).toBe(false);
  });

  it("reports missing (required) marker", () => {
    const d = diffEnvExample(good.replace("(required) ", ""), frags);
    expect(d.missingRequiredMarker).toEqual(["REQ"]);
  });

  it("handles '=' in values, export prefix, CRLF, duplicates, commented keys", () => {
    const text = "# (required)\r\nexport REQ=a=b=c\r\n# OPT=1\r\nDEF=1\r\nDEF=2\r\n";
    const d = diffEnvExample(text, frags);
    expect(d.missing).toEqual(["OPT"]);
    expect(d.duplicate).toEqual(["DEF"]);
    expect(d.missingRequiredMarker).toEqual([]);
  });

  it("ignores blank-line-separated comments", () => {
    const d = diffEnvExample("# (required)\n\nREQ=\nOPT=\nDEF=\n", frags);
    expect(d.missingRequiredMarker).toEqual(["REQ"]);
  });

  it("covers every real fragment key", () => {
    expect(envKeys(ALL_ENV_FRAGMENTS).length).toBeGreaterThan(20);
  });
});
