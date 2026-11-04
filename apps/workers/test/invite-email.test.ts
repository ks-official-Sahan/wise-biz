import { uuidv7 } from "@wise-biz/ids";
import { createCaptureMailer } from "@wise-biz/mailer";
import { TenantMemberInvitedV1, inviteToken, inviteTokenMatches } from "@wise-biz/module-tenancy";
import { createMemoryStore } from "@wise-biz/storage";
import { describe, expect, it } from "vitest";

import { createConsumers } from "../src/consumers.ts";
import { startWorker } from "../src/worker.ts";

const SECRET = "workers-test-invite-secret-".padEnd(40, "x");
const CONSOLE = "http://localhost:3001";

describe("invite email consumer (workers wiring)", () => {
  it("is subscribed to tenancy.member.invited and mails a link whose token verifies", async () => {
    const mailer = createCaptureMailer();
    const [consumer] = createConsumers({
      mailer,
      consoleUrl: CONSOLE,
      inviteSecret: SECRET,
      imports: { pool: {} as never, store: createMemoryStore(), onError: () => undefined },
    });
    expect(consumer?.name).toBe("tenancy.invite-email");
    expect(consumer?.events).toEqual(["tenancy.member.invited@v1"]);

    const tenantId = uuidv7();
    const inviteId = uuidv7();
    const payload = TenantMemberInvitedV1.parse({
      id: uuidv7(),
      type: "tenancy.member.invited",
      version: 1,
      source: "api/tenancy",
      tenantId,
      subject: `invite/${inviteId}`,
      time: new Date(0).toISOString(),
      correlationId: "req-1",
      actor: { type: "user", id: uuidv7() },
      data: {
        inviteId,
        tenantId,
        email: "ana@example.com",
        tenantName: "Acme",
        expiresAt: new Date(3_600_000).toISOString(),
      },
    });
    await consumer?.handle({ payload } as never, {} as never);

    expect(mailer.sent).toHaveLength(1);
    const link = new URL(/http:\/\/\S+/.exec(mailer.sent[0]?.text ?? "")?.[0] ?? "");
    expect(link.origin + link.pathname).toBe(`${CONSOLE}/invite/accept`);
    // Params ride in the fragment (never sent to servers or logs).
    expect(link.search).toBe("");
    const params = new URLSearchParams(link.hash.slice(1));
    expect(params.get("t")).toBe(tenantId);
    const token = params.get("k") ?? "";
    expect(inviteTokenMatches(SECRET, tenantId, inviteId, token)).toBe(true);
    expect(token).toBe(inviteToken(SECRET, tenantId, inviteId));
  });

  it("the default consumer set needs MAIL_FROM and INVITE_SECRET at startup (fails before any pool opens)", () => {
    expect(() =>
      startWorker({
        NODE_ENV: "test",
        LOG_LEVEL: "fatal",
        DATABASE_WORKER_URL: "postgres://u:p@127.0.0.1:1/x",
        DATABASE_CHAINER_URL: "postgres://u:p@127.0.0.1:1/x",
      }),
    ).toThrow(/MAIL_FROM|INVITE_SECRET|CONSOLE_URL/);
  });
});
