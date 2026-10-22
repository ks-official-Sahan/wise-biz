import { uuidv7 } from "@wise-biz/ids";
import { createCatalog } from "@wise-biz/policy";
import { describe, expect, it } from "vitest";

import {
  createInviteEmailConsumer,
  inviteAcceptLink,
  INVITE_EMAIL_CONSUMER,
} from "../src/consumers/invite-email.ts";
import {
  INVITE_TTL_MS,
  assertAllFound,
  inviteExpiresAt,
  inviteStatus,
  normalizeEmail,
  uniqueIds,
} from "../src/domain/invites.ts";
import { assertLastOwnerKept, assertOwnerRoleChange } from "../src/domain/members.ts";
import { pageSize } from "../src/domain/pagination.ts";
import { MAX_GRANTS_PER_ROLE, assertCustomRoleName, validateGrants } from "../src/domain/roles.ts";
import { TenantMemberInvitedV1, TENANCY_EVENTS } from "../src/events.ts";
import { inviteToken, inviteTokenMatches } from "../src/invite-token.ts";

import { INVITE_SECRET } from "./helpers.ts";

const SECRET = INVITE_SECRET;
const T = uuidv7();
const I = uuidv7();
const catalog = createCatalog(["tenancy:read", "tenancy:manage", "sales:void"]);

/** Local capture sender (tenancy does not depend on @wise-biz/mailer). */
function captureMailer() {
  const sent: { to: string; subject: string; text: string; html: string }[] = [];
  return {
    sent,
    send: (m: { to: string; subject: string; text: string; html?: string }) => {
      sent.push({ to: m.to, subject: m.subject, text: m.text, html: m.html ?? "" });
      return Promise.resolve();
    },
  };
}

function domainCode(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code;
  }
}

describe("invite token", () => {
  it("is deterministic, bound to (tenant, invite) and verifies in constant time", () => {
    const token = inviteToken(SECRET, T, I);
    expect(token).toBe(inviteToken(SECRET, T, I));
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(inviteTokenMatches(SECRET, T, I, token)).toBe(true);
    expect(inviteTokenMatches(SECRET, T, uuidv7(), token)).toBe(false);
    expect(inviteTokenMatches(SECRET, uuidv7(), I, token)).toBe(false);
    expect(
      inviteTokenMatches(SECRET, T, I, token.slice(0, -1) + (token.endsWith("A") ? "B" : "A")),
    ).toBe(false);
    expect(inviteTokenMatches(SECRET, T, I, "short")).toBe(false);
    expect(inviteTokenMatches(SECRET, T, I, "")).toBe(false);
  });

  it("a different server secret never verifies (a leaked token alone cannot be replayed on another deployment)", () => {
    const token = inviteToken(SECRET, T, I);
    const other = "another-secret-".padEnd(40, "y");
    expect(inviteTokenMatches(other, T, I, token)).toBe(false);
  });

  it("fails closed when no secret is configured", () => {
    expect(inviteTokenMatches(undefined, T, I, inviteToken(SECRET, T, I))).toBe(false);
  });

  it("builds the accept link with encoded query parameters and no double slash", () => {
    expect(inviteAcceptLink("http://localhost:3001/", "a", "b", "c d+e")).toBe(
      "http://localhost:3001/invite/accept?t=a&i=b&k=c+d%2Be",
    );
    expect(inviteAcceptLink("https://console.example///", T, I, "k")).toBe(
      `https://console.example/invite/accept?t=${T}&i=${I}&k=k`,
    );
  });
});

describe("invite consumer", () => {
  const event = (over: Record<string, unknown> = {}) =>
    TenantMemberInvitedV1.parse({
      id: uuidv7(),
      type: "tenancy.member.invited",
      version: 1,
      source: "api/tenancy",
      tenantId: T,
      subject: `invite/${I}`,
      time: new Date(0).toISOString(),
      correlationId: "req-1",
      actor: { type: "user", id: uuidv7() },
      data: {
        inviteId: I,
        tenantId: T,
        email: "ana@example.com",
        tenantName: "Acme <Traders>",
        expiresAt: new Date(INVITE_TTL_MS).toISOString(),
        ...over,
      },
    });

  it("is registered for the invited event and sends a link whose token verifies", async () => {
    const mailer = captureMailer();
    const consumer = createInviteEmailConsumer({
      mailer,
      consoleUrl: "http://localhost:3001",
      inviteSecret: SECRET,
    });
    expect(consumer.name).toBe(INVITE_EMAIL_CONSUMER);
    expect(consumer.events).toEqual(["tenancy.member.invited@v1"]);
    expect(TENANCY_EVENTS).toContain(TenantMemberInvitedV1);

    await consumer.handle({ payload: event() });
    expect(mailer.sent).toHaveLength(1);
    const sent = mailer.sent[0];
    expect(sent?.to).toBe("ana@example.com");
    const link = /https:?\/\/\S+|http:\/\/\S+/.exec(sent?.text ?? "")?.[0] ?? "";
    const url = new URL(link);
    expect(url.pathname).toBe("/invite/accept");
    expect(url.searchParams.get("t")).toBe(T);
    expect(url.searchParams.get("i")).toBe(I);
    expect(inviteTokenMatches(SECRET, T, I, url.searchParams.get("k") ?? "")).toBe(true);
  });

  it("escapes the tenant name in the html part", async () => {
    const mailer = captureMailer();
    const consumer = createInviteEmailConsumer({
      mailer,
      consoleUrl: "http://x",
      inviteSecret: SECRET,
    });
    await consumer.handle({ payload: event() });
    expect(mailer.sent[0]?.html).toContain("Acme &lt;Traders&gt;");
    expect(mailer.sent[0]?.html).not.toContain("<Traders>");
  });

  it("an event that does not match the schema throws (the bus retries, then dead-letters)", async () => {
    const consumer = createInviteEmailConsumer({
      mailer: captureMailer(),
      consoleUrl: "http://x",
      inviteSecret: SECRET,
    });
    await expect(consumer.handle({ payload: { not: "an event" } })).rejects.toThrow();
  });

  it("a mail failure propagates so the bus can retry", async () => {
    const consumer = createInviteEmailConsumer({
      mailer: { send: () => Promise.reject(new Error("smtp down")) },
      consoleUrl: "http://x",
      inviteSecret: SECRET,
    });
    await expect(consumer.handle({ payload: event() })).rejects.toThrow("smtp down");
  });
});

describe("invite domain rules", () => {
  it("normalises email: trimmed, lower case", () => {
    expect(normalizeEmail("  Ana.Silva@Example.COM ")).toBe("ana.silva@example.com");
  });

  it("status: accepted and revoked win over expiry; pending before expiry; expired at or after it", () => {
    const now = new Date(1_000_000);
    const base = { expiresAt: new Date(2_000_000), acceptedAt: null, revokedAt: null };
    expect(inviteStatus(base, now)).toBe("pending");
    expect(inviteStatus({ ...base, expiresAt: now }, now)).toBe("expired");
    expect(inviteStatus({ ...base, expiresAt: new Date(0) }, now)).toBe("expired");
    expect(inviteStatus({ ...base, expiresAt: new Date(0), revokedAt: now }, now)).toBe("revoked");
    expect(inviteStatus({ ...base, acceptedAt: now, revokedAt: null }, now)).toBe("accepted");
    expect(inviteExpiresAt(now).getTime() - now.getTime()).toBe(INVITE_TTL_MS);
  });

  it("uniqueIds rejects duplicates and keeps order", () => {
    expect(uniqueIds(["b", "a"], "x")).toEqual(["b", "a"]);
    expect(domainCode(() => uniqueIds(["a", "a"], "x"))).toBe("VALIDATION_FAILED");
  });

  it("assertAllFound names the first missing ids as a validation error", () => {
    expect(() => {
      assertAllFound(["a"], new Set(["a"]), "roleIds");
    }).not.toThrow();
    expect(
      domainCode(() => {
        assertAllFound(["a", "b"], new Set(["a"]), "roleIds");
      }),
    ).toBe("VALIDATION_FAILED");
  });

  it("owner role changes: non-owners may not add or remove it (NOT_FOUND); owners may", () => {
    const base = { currentRoles: ["cashier"], nextRoles: ["cashier"] };
    expect(() => {
      assertOwnerRoleChange({ ...base, actorIsOwner: false });
    }).not.toThrow();
    expect(
      domainCode(() => {
        assertOwnerRoleChange({ actorIsOwner: false, currentRoles: [], nextRoles: ["owner"] });
      }),
    ).toBe("NOT_FOUND");
    expect(
      domainCode(() => {
        assertOwnerRoleChange({ actorIsOwner: false, currentRoles: ["owner"], nextRoles: [] });
      }),
    ).toBe("NOT_FOUND");
    expect(() => {
      assertOwnerRoleChange({ actorIsOwner: true, currentRoles: [], nextRoles: ["owner"] });
    }).not.toThrow();
    expect(() => {
      assertOwnerRoleChange({
        actorIsOwner: false,
        currentRoles: ["owner"],
        nextRoles: ["owner", "cashier"],
      });
    }).not.toThrow();
  });

  it("the last owner cannot be demoted (CONFLICT); with another owner it can", () => {
    expect(
      domainCode(() => {
        assertLastOwnerKept({ currentRoles: ["owner"], nextRoles: [], otherActiveOwners: 0 });
      }),
    ).toBe("CONFLICT");
    expect(() => {
      assertLastOwnerKept({ currentRoles: ["owner"], nextRoles: [], otherActiveOwners: 1 });
    }).not.toThrow();
    expect(() => {
      assertLastOwnerKept({ currentRoles: ["cashier"], nextRoles: [], otherActiveOwners: 0 });
    }).not.toThrow();
  });

  it("grants: catalog only, never platform, no duplicates, valid conditions, bounded count", () => {
    expect(validateGrants([{ permission: "sales:void" }], catalog)).toEqual([
      { permission: "sales:void", conditions: null },
    ]);
    expect(
      validateGrants(
        [{ permission: "tenancy:read", conditions: { maxAmountMinor: 10 } }],
        catalog,
      )[0]?.conditions,
    ).toEqual({
      maxAmountMinor: 10,
    });
    expect(domainCode(() => validateGrants([{ permission: "nope:read" }], catalog))).toBe(
      "VALIDATION_FAILED",
    );
    expect(
      domainCode(() =>
        validateGrants([{ permission: "platform:admin" }], createCatalog(["platform:admin"])),
      ),
    ).toBe("VALIDATION_FAILED");
    expect(
      domainCode(() =>
        validateGrants([{ permission: "tenancy:read" }, { permission: "tenancy:read" }], catalog),
      ),
    ).toBe("VALIDATION_FAILED");
    expect(
      domainCode(() =>
        validateGrants([{ permission: "tenancy:read", conditions: { x: 1 } }], catalog),
      ),
    ).toBe("VALIDATION_FAILED");
    const many = Array.from({ length: MAX_GRANTS_PER_ROLE + 1 }, () => ({
      permission: "tenancy:read",
    }));
    expect(domainCode(() => validateGrants(many, catalog))).toBe("VALIDATION_FAILED");
  });

  it("custom role names: lower-case snake; owner and platform_admin reserved", () => {
    expect(assertCustomRoleName("floor_lead2")).toBe("floor_lead2");
    for (const bad of ["Floor", "2floor", "owner", "platform_admin", "a-b", ""]) {
      expect(domainCode(() => assertCustomRoleName(bad))).toBe("VALIDATION_FAILED");
    }
  });

  it("page size: default 50, 1..200 integers only", () => {
    expect(pageSize(undefined)).toBe(50);
    expect(pageSize(200)).toBe(200);
    for (const bad of [0, 201, 1.5, Number.NaN]) {
      expect(domainCode(() => pageSize(bad))).toBe("VALIDATION_FAILED");
    }
  });
});
