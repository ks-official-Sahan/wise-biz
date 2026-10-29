import { createCaptureMailer } from "@wise-biz/mailer";
import { describe, expect, it } from "vitest";

import { createConsumers } from "../src/consumers.ts";

describe("consumer set", () => {
  it("runs the invite email and the search projection consumers", () => {
    const consumers = createConsumers({
      mailer: createCaptureMailer(),
      consoleUrl: "http://localhost:3001",
      inviteSecret: "workers-test-invite-secret-".padEnd(40, "x"),
    });
    expect(consumers.map((c) => [c.name, c.events])).toEqual([
      ["tenancy.invite-email", ["tenancy.member.invited@v1"]],
      ["search.catalog-projection", ["catalog.variant.upserted@v1"]],
    ]);
  });
});
