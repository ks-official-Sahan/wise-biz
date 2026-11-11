import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { MAX_LAST_ERRORS, sanitizeDiagnostics } from "../src/domain/diagnostics.ts";
import { scrubText } from "../src/domain/scrub.ts";

const UUID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const WHITELIST = ["appVersion", "platform", "deviceId", "branchId", "lastErrors"];

describe("diagnostic whitelist", () => {
  it("keeps only the whitelisted keys and drops everything else", () => {
    const out = sanitizeDiagnostics({
      appVersion: "2.4.1",
      platform: "android",
      deviceId: UUID,
      branchId: UUID,
      userEmail: "cashier@shop.test",
      cookie: "session=abc",
      env: { DATABASE_URL: "postgres://x" },
      customerName: "Dana Example",
      lastErrors: [{ message: "boom", stack: "at x (secret.ts:1)", userId: UUID }],
    });
    expect(Object.keys(out).sort()).toEqual([...WHITELIST].sort());
    expect(out.lastErrors).toEqual([{ message: "boom" }]);
    expect(JSON.stringify(out)).not.toMatch(/cashier|Dana|session=|postgres|secret\.ts/);
  });

  it("a non-object input yields an empty bundle", () => {
    for (const raw of [null, undefined, "text", 42, ["x"]]) {
      expect(sanitizeDiagnostics(raw)).toEqual({ lastErrors: [] });
    }
  });

  it("scalars must match a strict charset, so an email or card cannot ride in on them", () => {
    const out = sanitizeDiagnostics({
      appVersion: "jo@shop.test",
      platform: "4111 1111 1111 1111",
      deviceId: "not-a-uuid",
      branchId: `${UUID}; drop table`,
    });
    expect(out).toEqual({ lastErrors: [] });
  });

  it("lastErrors is capped at 10 entries, and each message is bounded to 200 characters", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ message: `error ${String(i)}` }));
    expect(sanitizeDiagnostics({ lastErrors: many }).lastErrors).toHaveLength(MAX_LAST_ERRORS);
    const long = sanitizeDiagnostics({ lastErrors: [{ message: "x".repeat(5_000) }] });
    expect(Array.from(long.lastErrors[0]?.message ?? "")).toHaveLength(200);
  });

  it("accepts plain strings as messages and ignores entries that carry no text", () => {
    const out = sanitizeDiagnostics({
      lastErrors: ["disk full", 7, null, { stack: "no message" }, "   "],
    });
    expect(out.lastErrors).toEqual([{ message: "disk full" }]);
  });
});

describe("scrubText: each class is removed and the rest is kept", () => {
  it("emails, cards, phone numbers and bearer tokens", () => {
    expect(scrubText("Card 4111 1111 1111 1111 failed for jo@shop.test")).toBe(
      "Card [card] failed for [email]",
    );
    expect(scrubText("call +1 (555) 123-4567 now")).toBe("call [phone] now");
    expect(scrubText("Authorization: Bearer abc.def-123_XYZ")).not.toMatch(/abc\.def|XYZ/);
  });

  it("long mixed tokens and hex keys, but not long plain words", () => {
    expect(scrubText("token ABCdef123456789012345678 failed")).toBe("token [secret] failed");
    expect(scrubText("id=0123456789abcdef0123456789abcdef")).not.toMatch(/0123456789abcdef/);
    expect(scrubText("ERRORCODEWITHNODIGITSATALLXXXXXXXX")).toBe(
      "ERRORCODEWITHNODIGITSATALLXXXXXXXX",
    );
  });

  it("keeps ISO timestamps and short numbers readable", () => {
    expect(scrubText("at 2026-06-10T12:00:00Z code 404 line 12")).toBe(
      "at 2026-06-10T12:00:00Z code 404 line 12",
    );
  });

  it("turns control characters into spaces", () => {
    expect(scrubText("line one\nline two\u0000end")).toBe("line one line two end");
  });

  it("is idempotent on its own output", () => {
    const samples = [
      "Card 4111 1111 1111 1111 for jo@shop.test",
      "Bearer abcdefghijklmnopqrstuvwxyz0123456789",
      "token ABCdef123456789012345678 and +44 20 7946 0958",
    ];
    for (const s of samples) {
      const once = scrubText(s);
      expect(scrubText(once)).toBe(once);
    }
  });
});

// --- Property-style checks: generated PII must never survive, in any position or format -----------------------

const LETTERS_AND_SPACES = fc.stringMatching(/^[A-Za-z ]{0,40}$/);
const EMAIL = fc
  .tuple(
    fc.stringMatching(/^[a-z0-9._+-]{1,16}$/),
    fc.stringMatching(/^[a-z]{3,10}$/),
    fc.stringMatching(/^[a-z]{2,6}$/),
  )
  .map(([local, domain, tld]) => `${local}@${domain}.${tld}`);
const CARD = fc
  .tuple(fc.stringMatching(/^[0-9]{13,19}$/), fc.constantFrom(" ", "-", ""))
  .map(([digits, sep]) => digits.match(/.{1,4}/g)?.join(sep) ?? digits);
const PHONE = fc
  .tuple(fc.stringMatching(/^[0-9]{9,12}$/), fc.constantFrom("", "+", "+1 ", "+44 "))
  .map(([digits, prefix]) => `${prefix}${digits}`);
const MIXED_TOKEN = fc
  .tuple(
    fc.stringMatching(/^[A-Za-z]{12,20}$/),
    fc.stringMatching(/^[0-9]{12,20}$/),
    fc.stringMatching(/^[A-Za-z0-9]{0,10}$/),
  )
  .map(([letters, digits, tail]) => `${letters}${digits}${tail}`);
const BEARER_TOKEN = fc.stringMatching(/^[A-Za-z0-9._~+/=-]{20,40}$/);
const PII = fc.oneof(EMAIL, CARD, PHONE, MIXED_TOKEN);

describe("property: generated PII never survives the scrubber", () => {
  it("emails are removed in any surrounding text", () => {
    fc.assert(
      fc.property(LETTERS_AND_SPACES, EMAIL, LETTERS_AND_SPACES, (pre, email, post) => {
        const out = scrubText(`${pre} ${email} ${post}`);
        expect(out).not.toContain(email);
        expect(out).not.toContain("@");
      }),
      { numRuns: 300 },
    );
  });

  it("card-like digit runs (13 to 19 digits, grouped or not) leave no digit behind", () => {
    fc.assert(
      fc.property(LETTERS_AND_SPACES, CARD, LETTERS_AND_SPACES, (pre, card, post) => {
        expect(scrubText(`${pre} ${card} ${post}`)).not.toMatch(/\d/);
      }),
      { numRuns: 300 },
    );
  });

  it("phone-like numbers (9 to 12 digits, optional + and country prefix) leave no digit behind", () => {
    fc.assert(
      fc.property(LETTERS_AND_SPACES, PHONE, LETTERS_AND_SPACES, (pre, phone, post) => {
        expect(scrubText(`${pre} ${phone} ${post}`)).not.toMatch(/\d/);
      }),
      { numRuns: 300 },
    );
  });

  it("long mixed letter-and-digit tokens are removed whole", () => {
    fc.assert(
      fc.property(LETTERS_AND_SPACES, MIXED_TOKEN, LETTERS_AND_SPACES, (pre, token, post) => {
        const out = scrubText(`${pre} ${token} ${post}`);
        expect(out).not.toContain(token);
        expect(out).not.toMatch(/\d/);
      }),
      { numRuns: 300 },
    );
  });

  it("bearer tokens are removed whole, whatever their characters", () => {
    fc.assert(
      fc.property(LETTERS_AND_SPACES, BEARER_TOKEN, LETTERS_AND_SPACES, (pre, token, post) => {
        const out = scrubText(`${pre} Bearer ${token} ${post}`);
        expect(out).not.toContain(token);
      }),
      { numRuns: 300 },
    );
  });

  it("a whole sanitised message carries none of its PII, and is bounded", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(LETTERS_AND_SPACES, PII), { minLength: 1, maxLength: 4 }),
        (parts) => {
          const message = parts.map(([text, pii]) => `${text} ${pii}`).join(" ");
          const out = sanitizeDiagnostics({ lastErrors: [{ message }] }).lastErrors[0];
          expect(out).toBeDefined();
          if (out === undefined) return;
          expect(out.message).not.toMatch(/\d/);
          expect(out.message).not.toContain("@");
          expect(Array.from(out.message).length).toBeLessThanOrEqual(200);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("unknown keys carrying PII never reach the bundle", () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.stringMatching(/^[a-z]{3,12}$/).filter((k) => !WHITELIST.includes(k)),
          PII,
          { maxKeys: 6 },
        ),
        (extra) => {
          const out = sanitizeDiagnostics(extra);
          expect(Object.keys(out)).toEqual(["lastErrors"]);
          const json = JSON.stringify(out);
          for (const v of Object.values(extra)) expect(json).not.toContain(v);
        },
      ),
      { numRuns: 200 },
    );
  });
});
