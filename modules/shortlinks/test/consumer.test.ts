import { receiptCode } from "@wise-biz/receipt";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyReceiptLink } from "../src/index.ts";

import { consumer, inTenantTx, saleEvent, setup } from "./helpers.ts";

import type { Fixture } from "./helpers.ts";

interface DataLink {
  tenant_id: string;
  code: string;
  sale_id: string;
  snapshot: Record<string, unknown>;
}

const TENANT_A = "0192f8c6-0000-7000-8000-00000000000a";
const TENANT_B = "0192f8c6-0000-7000-8000-00000000000b";
const SALE = "0192f8c6-0000-7000-8000-0000000000aa";

let fx: Fixture;

beforeAll(async () => {
  fx = await setup();
});
afterAll(async () => {
  await fx.drop();
});

describe("sales.sale.completed consumer", () => {
  it("writes the link under the event's tenant with the code the terminal printed", async () => {
    const ev = saleEvent(TENANT_A, SALE);
    await inTenantTx(fx.worker, TENANT_A, (c) => applyReceiptLink(c, ev));
    const r = await inTenantTx(fx.migrator, TENANT_A, (c) =>
      c.query<DataLink>(
        "select tenant_id, code, sale_id, snapshot from shortlinks.receipt_links where sale_id = $1",
        [SALE],
      ),
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.tenant_id).toBe(TENANT_A);
    expect(r.rows[0]?.code).toBe(receiptCode(SALE));
    expect(JSON.stringify(r.rows[0]?.snapshot)).not.toContain("customerId");
  });

  it("is idempotent on (tenant_id, sale_id): a redelivery inserts nothing and keeps the first snapshot", async () => {
    const SALE2 = "0192f8c6-0000-7000-8000-0000000000bb";
    const first = await inTenantTx(fx.worker, TENANT_A, (c) =>
      applyReceiptLink(c, saleEvent(TENANT_A, SALE2, { payableMinor: 1000 })),
    );
    const again = await inTenantTx(fx.worker, TENANT_A, (c) =>
      applyReceiptLink(c, saleEvent(TENANT_A, SALE2, { payableMinor: 9999 })),
    );
    expect(first).toBe(true);
    expect(again).toBe(false);
    const r = await inTenantTx(fx.migrator, TENANT_A, (c) =>
      c.query<DataLink>("select snapshot from shortlinks.receipt_links where sale_id = $1", [
        SALE2,
      ]),
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.snapshot).toMatchObject({ payableMinor: 1000 });
  });

  it("handle() runs the same write through the consumer definition", async () => {
    const SALE3 = "0192f8c6-0000-7000-8000-0000000000cc";
    expect(consumer.events).toEqual(["sales.sale.completed@v1"]);
    await inTenantTx(fx.worker, TENANT_A, (client) =>
      consumer.handle({ payload: saleEvent(TENANT_A, SALE3) }, { client }),
    );
    const r = await inTenantTx(fx.migrator, TENANT_A, (c) =>
      c.query("select 1 from shortlinks.receipt_links where sale_id = $1", [SALE3]),
    );
    expect(r.rowCount).toBe(1);
  });

  it("RLS backstop: a transaction scoped to tenant B cannot write tenant A's event", async () => {
    const SALE4 = "0192f8c6-0000-7000-8000-0000000000dd";
    await expect(
      inTenantTx(fx.worker, TENANT_B, (c) => applyReceiptLink(c, saleEvent(TENANT_A, SALE4))),
    ).rejects.toThrow(/row-level security/);
  });

  it("a malformed event throws (the bus retries, then dead-letters)", async () => {
    const bad = saleEvent(TENANT_A, SALE) as { data: { lines: unknown } };
    bad.data.lines = "nope";
    await expect(
      inTenantTx(fx.worker, TENANT_A, (c) => applyReceiptLink(c, bad)),
    ).rejects.toThrow();
  });
});

describe("tables are closed to the API role", () => {
  it("wb_app cannot read or write receipt_links directly, even as its own tenant", async () => {
    await expect(fx.pool.query("select 1 from shortlinks.receipt_links")).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      fx.pool.query(
        "insert into shortlinks.receipt_links (tenant_id, code, sale_id, snapshot) values ($1,'AAAAAAAAAA',$2,'{}')",
        [TENANT_A, SALE],
      ),
    ).rejects.toThrow(/permission denied/);
  });
});
