import { PLATFORM_THEME } from "@wise-biz/theme";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_BLOCKS,
  applyFix,
  cleanHex,
  describeIssue,
  moveBlock,
  paperWidth,
  previewOf,
  previewVars,
  renderPreview,
  seedText,
  templateProblems,
} from "./branding.ts";

import type { ThemeInput } from "@wise-biz/theme";

const pale: ThemeInput = {
  ...PLATFORM_THEME,
  name: "Pale",
  overrides: { light: { accent: "#FFFF99" } },
};

describe("colour text", () => {
  it("accepts #rrggbb with or without the hash and refuses the rest", () => {
    expect(cleanHex("#0E7C66")).toBe("#0e7c66");
    expect(cleanHex(" 0e7c66 ")).toBe("#0e7c66");
    expect(cleanHex("#0e7c6")).toBeNull();
    expect(cleanHex("red")).toBeNull();
    expect(cleanHex("")).toBeNull();
  });

  it("reads the stored brand colour whatever its shape", () => {
    expect(seedText("#ABCDEF")).toBe("#abcdef");
    expect(seedText({ colorSpace: "srgb", components: [1, 0, 0] })).toBe("#ff0000");
    expect(seedText({ colorSpace: "srgb", components: [0, 0, 1], hex: "#0000FF" })).toBe("#0000ff");
  });
});

describe("theme preview and contrast", () => {
  it("passes the platform theme", () => {
    const p = previewOf(PLATFORM_THEME);
    expect(p.error).toBeNull();
    expect(p.issues).toEqual([]);
    expect(p.resolved).not.toBeNull();
  });

  it("names the failing pair in plain words", () => {
    const p = previewOf(pale);
    expect(p.issues.length).toBeGreaterThan(0);
    const text = describeIssue(p.issues[0] ?? (undefined as never));
    expect(text).toMatch(/^Light mode: text on accent on accent is \d\.\d\d:1, needs 4\.5:1\.$/);
  });

  it("offers a one-click fix that clears the failure", () => {
    const issue = previewOf(pale).issues[0];
    expect(issue).toBeDefined();
    const fixed = applyFix(pale, issue ?? (undefined as never));
    expect(fixed).not.toBeNull();
    expect(previewOf(fixed ?? pale).issues).toEqual([]);
  });

  it("offers no fix when the colour was not overridden (the brand colour itself is the problem)", () => {
    const issue = previewOf(pale).issues[0];
    expect(applyFix(PLATFORM_THEME, issue ?? (undefined as never))).toBeNull();
  });

  it("paints the preview from scoped variables only", () => {
    const p = previewOf(PLATFORM_THEME);
    const vars = previewVars(p.resolved ?? (undefined as never), "dark");
    expect(vars["--pv-accent"]).toMatch(/^#[0-9a-f]{6}$/i);
    expect(vars["--pv-text-on-accent"]).toMatch(/^#[0-9a-f]{6}$/i);
    expect(Object.keys(vars).every((k) => k.startsWith("--pv-"))).toBe(true);
  });
});

describe("receipt layout", () => {
  it("moves a block and stops at the ends", () => {
    expect(moveBlock(["a", "b", "c"], 1, -1)).toEqual(["b", "a", "c"]);
    expect(moveBlock(["a", "b", "c"], 1, 1)).toEqual(["a", "c", "b"]);
    expect(moveBlock(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"]);
    expect(moveBlock(["a", "b", "c"], 2, 1)).toEqual(["a", "b", "c"]);
    expect(moveBlock(["a"], 5, 1)).toEqual(["a"]);
  });

  it("says why a layout cannot be saved", () => {
    expect(templateProblems(DEFAULT_BLOCKS, "INV-")).toEqual([]);
    expect(templateProblems([{ type: "logo" }], "")).toEqual([
      "A receipt needs the items block.",
      "A receipt needs the totals block.",
    ]);
    expect(templateProblems(DEFAULT_BLOCKS, "inv 1")[0]).toMatch(/invoice prefix/);
  });

  it("fits every line to the paper and follows the block order", () => {
    for (const paper of ["58", "80"] as const) {
      const lines = renderPreview(DEFAULT_BLOCKS, paper, "INV-", "Open daily 8 to 6");
      expect(lines.every((l) => l.length <= paperWidth(paper))).toBe(true);
      expect(lines.find((l) => l.includes("TOTAL"))).toMatch(/14\.58$/);
      expect(lines.some((l) => l.includes("Sale INV-42"))).toBe(true);
    }
    expect(paperWidth("58")).toBe(32);
    expect(paperWidth("80")).toBe(48);
    const lines = renderPreview([{ type: "totals" }, { type: "lines" }], "80", "", "");
    expect(lines.findIndex((l) => l.startsWith("Subtotal"))).toBeLessThan(
      lines.findIndex((l) => l.includes("Flat white")),
    );
  });

  it("never lets long text push past the paper", () => {
    const lines = renderPreview(
      [{ type: "text", text: "x".repeat(200) }],
      "58",
      "",
      "y".repeat(100),
    );
    expect(lines.every((l) => l.length <= 32)).toBe(true);
  });
});
