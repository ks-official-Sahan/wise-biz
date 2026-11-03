import { createCaptureMailer } from "@wise-biz/mailer";
import { createMemoryStore } from "@wise-biz/storage";
import { describe, expect, it } from "vitest";

import { createConsumers } from "../src/consumers.ts";

describe("consumer set", () => {
  it("runs the invite email, search, pricing and inventory projections, and catalog import consumers", () => {
    const consumers = createConsumers({
      mailer: createCaptureMailer(),
      consoleUrl: "http://localhost:3001",
      inviteSecret: "workers-test-invite-secret-".padEnd(40, "x"),
      imports: { pool: {} as never, store: createMemoryStore(), onError: () => undefined },
    });
    expect(consumers.map((c) => [c.name, c.events])).toEqual([
      ["tenancy.invite-email", ["tenancy.member.invited@v1"]],
      ["search.catalog-projection", ["catalog.variant.upserted@v1"]],
      ["pricing.variant-facts", ["catalog.variant.upserted@v1"]],
      ["inventory.variant-facts", ["catalog.variant.upserted@v1"]],
      [
        "sync.changes",
        expect.arrayContaining(["pricing.price.changed@v1", "inventory.movement.recorded@v1"]),
      ],
      ["shortlinks.receipt-links", ["sales.sale.completed@v1"]],
      ["reporting.rollups", expect.arrayContaining(["sales.sale.completed@v1"])],
      ["notifications.fanout", ["inventory.balance.low@v1", "inventory.batch.expiring@v1"]],
      ["inventory.low-stock", ["inventory.movement.recorded@v1"]],
      ["catalog.import-runner", ["catalog.import.requested@v1"]],
    ]);
  });
});
