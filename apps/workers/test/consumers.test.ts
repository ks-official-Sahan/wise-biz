import { createCaptureMailer } from "@wise-biz/mailer";
import { createMemoryStore } from "@wise-biz/storage";
import { describe, expect, it } from "vitest";

import { createConsumers } from "../src/consumers.ts";

describe("consumer set", () => {
  it("runs the invite email, search projection and catalog import consumers", () => {
    const consumers = createConsumers({
      mailer: createCaptureMailer(),
      consoleUrl: "http://localhost:3001",
      inviteSecret: "workers-test-invite-secret-".padEnd(40, "x"),
      imports: { pool: {} as never, store: createMemoryStore(), onError: () => undefined },
    });
    expect(consumers.map((c) => [c.name, c.events])).toEqual([
      ["tenancy.invite-email", ["tenancy.member.invited@v1"]],
      ["search.catalog-projection", ["catalog.variant.upserted@v1"]],
      ["catalog.import-runner", ["catalog.import.requested@v1"]],
    ]);
  });
});
