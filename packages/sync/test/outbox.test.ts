import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { verify } from "@wise-biz/crypto";
import { createHlc, uuidv7 } from "@wise-biz/ids";
import { afterEach, describe, expect, it } from "vitest";

import { commandHash, fromBase64, GENESIS_HASH, toBase64 } from "../src/chain.ts";
import { createOutbox, UnsyncedWorkError } from "../src/outbox.ts";
import { openLocalDb } from "../src/schema/migrations.ts";

import { betterSqliteAdapter } from "./support/better-sqlite.ts";
import { createDevice, saleBody } from "./support/fake-server.ts";

import type { Device } from "./support/fake-server.ts";

const base = join(import.meta.dirname, "..", "node_modules", ".cache", "wb-sync-test");
const dirs: string[] = [];
const open: Device[] = [];
afterEach(async () => {
  for (const d of open.splice(0)) await d.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const device = async (opts?: Parameters<typeof createDevice>[0]) => {
  const d = await createDevice(opts);
  open.push(d);
  return d;
};

describe("outbox", () => {
  it("writes the domain rows and the command in one transaction, chained and signed", async () => {
    const d = await device();
    await d.db.exec("create table sales (id text primary key)");
    for (let n = 0; n < 5; n++) {
      await d.outbox.transaction(async (tx) => {
        await tx.run("insert into sales values (?)", [`sale-${String(n)}`]);
        await tx.enqueue("complete_sale", saleBody(n));
      });
    }
    const all = await d.outbox.allPending();
    expect(all.map((c) => c.seq)).toEqual([0, 1, 2, 3, 4]);
    let prev = GENESIS_HASH;
    for (const c of all) {
      const m = c.command.body.meta;
      expect(m.deviceSeq).toBe(c.seq);
      expect(m.prevHash).toBe(toBase64(prev));
      const want = commandHash(c.command.type, c.seq, c.command.body, prev);
      expect(m.hash).toBe(toBase64(want));
      expect(verify(fromBase64(m.signature), want, d.publicKey)).toBe(true);
      prev = want;
    }
  });

  it("a failed transaction leaves neither the sale nor the command, nor a hole in the sequence", async () => {
    const d = await device();
    await d.db.exec("create table sales (id text primary key)");
    await d.outbox.transaction(async (tx) => {
      await tx.enqueue("complete_sale", saleBody(0));
    });
    await expect(
      d.outbox.transaction(async (tx) => {
        await tx.run("insert into sales values ('x')");
        await tx.enqueue("complete_sale", saleBody(1));
        throw new Error("printer jammed");
      }),
    ).rejects.toThrow("printer jammed");
    await d.outbox.transaction(async (tx) => {
      await tx.enqueue("complete_sale", saleBody(2));
    });
    expect(await d.db.all("select id from sales")).toEqual([]);
    expect((await d.outbox.allPending()).map((c) => c.seq)).toEqual([0, 1]);
    // The surviving commands still verify as one chain.
    const [a, b] = await d.outbox.allPending();
    expect(b?.command.body.meta.prevHash).toBe(a?.command.body.meta.hash);
  });

  it("assigns unique contiguous sequence numbers to overlapping writers", async () => {
    const d = await device();
    await Promise.all(
      Array.from({ length: 60 }, (_, n) =>
        d.outbox.transaction(async (tx) => {
          await tx.enqueue("complete_sale", saleBody(n));
        }),
      ),
    );
    const all = await d.outbox.allPending();
    expect(all.map((c) => c.seq)).toEqual(Array.from({ length: 60 }, (_, i) => i));
    for (let i = 1; i < all.length; i++) {
      expect(all[i]?.command.body.meta.prevHash).toBe(all[i - 1]?.command.body.meta.hash);
    }
  });

  it("keeps its place across a restart", async () => {
    mkdirSync(base, { recursive: true });
    const dir = mkdtempSync(join(base, "ob-"));
    dirs.push(dir);
    const file = join(dir, "device.db");
    const first = await device({ file });
    await first.outbox.transaction(async (tx) => {
      await tx.enqueue("open_shift", { id: "shift-1" });
    });
    await first.close();
    open.length = 0;
    // Same file, same key material is not needed to continue the chain: the head is in the database.
    const db = await openLocalDb(betterSqliteAdapter(file));
    const outbox = createOutbox({
      db,
      keys: first.keys,
      hlc: createHlc({ node: "dev-1" }),
      ids: { uuidv7 },
    });
    const next = await outbox.transaction((tx) => tx.enqueue("complete_sale", saleBody(1)));
    expect(next.seq).toBe(1);
    const [a, b] = await outbox.allPending();
    expect(b?.command.body.meta.prevHash).toBe(a?.command.body.meta.hash);
    await db.close();
  });

  it("refuses a body that already carries meta, and uses body.id (or a new id) for the command id", async () => {
    const d = await device();
    await expect(
      d.outbox.transaction((tx) => tx.enqueue("x", { meta: { forged: true } })),
    ).rejects.toThrow(/meta/);
    const withId = await d.outbox.transaction((tx) => tx.enqueue("x", { id: "abc" }));
    const without = await d.outbox.transaction((tx) => tx.enqueue("x", { n: 1 }));
    expect(withId.id).toBe("abc");
    expect(without.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("pending honours the count and byte budgets but always returns at least one", async () => {
    const d = await device();
    for (let n = 0; n < 10; n++) {
      await d.outbox.transaction((tx) =>
        tx.enqueue("complete_sale", saleBody(n, { pad: "x".repeat(500) })),
      );
    }
    expect((await d.outbox.pending(4, 1_000_000)).map((c) => c.seq)).toEqual([0, 1, 2, 3]);
    const two = await d.outbox.pending(10, 1500);
    expect(two.length).toBeGreaterThanOrEqual(1);
    expect(two.length).toBeLessThan(10);
    expect((await d.outbox.pending(10, 1)).length).toBe(1);
  });

  it("records answers once, keeps rejections for the operator, and reports what is unsynced", async () => {
    let t = 1_000;
    const d = await device({ now: () => t++ });
    for (let n = 0; n < 4; n++) {
      await d.outbox.transaction((tx) => tx.enqueue("complete_sale", saleBody(n)));
    }
    expect(await d.outbox.unsyncedCount()).toBe(4);
    expect(await d.outbox.oldestUnsyncedAt()).toBe(1_000);
    const r1 = await d.outbox.recordAcks([
      { seq: 0, status: "applied" },
      { seq: 1, status: "rejected", error: { code: "PRICE_MISMATCH", message: "stale" } },
    ]);
    expect(r1).toEqual({ acked: 1, rejected: 1 });
    // The same answers again change nothing.
    expect(await d.outbox.recordAcks([{ seq: 0, status: "replayed" }])).toEqual({
      acked: 0,
      rejected: 0,
    });
    expect(await d.outbox.unsyncedCount()).toBe(2);
    expect(await d.outbox.oldestUnsyncedAt()).toBe(1_002);
    const rej = await d.outbox.rejected();
    expect(rej.map((r) => [r.seq, r.error?.code])).toEqual([[1, "PRICE_MISMATCH"]]);
    await expect(d.outbox.assertSafeToSignOut()).rejects.toBeInstanceOf(UnsyncedWorkError);
    await d.outbox.recordAcks([
      { seq: 2, status: "applied" },
      { seq: 3, status: "applied" },
    ]);
    await expect(d.outbox.assertSafeToSignOut()).resolves.toBeUndefined();
    expect(await d.outbox.oldestUnsyncedAt()).toBeUndefined();
    expect(await d.outbox.pruneAcked(Number.MAX_SAFE_INTEGER)).toBe(3);
    // The chain continues after pruning: the head is not in the pruned rows.
    const next = await d.outbox.transaction((tx) => tx.enqueue("complete_sale", saleBody(9)));
    expect(next.seq).toBe(4);
  });

  it("counts attempts and rewinds acked commands back to pending", async () => {
    const d = await device();
    for (let n = 0; n < 3; n++) await d.outbox.transaction((tx) => tx.enqueue("x", { n }));
    await d.outbox.recordAttempt([]);
    await d.outbox.recordAttempt([0, 1]);
    expect((await d.outbox.allPending()).map((c) => c.attempts)).toEqual([1, 1, 0]);
    await d.outbox.recordAcks([
      { seq: 0, status: "applied" },
      { seq: 1, status: "applied" },
    ]);
    expect(await d.outbox.rewindTo(1)).toBe(1);
    expect(await d.outbox.hasSeq(1)).toBe(true);
    expect(await d.outbox.hasSeq(7)).toBe(false);
    expect((await d.outbox.allPending()).map((c) => c.seq)).toEqual([1, 2]);
  });
});
