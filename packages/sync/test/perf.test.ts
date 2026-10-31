import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { createDevice, saleBody } from "./support/fake-server.ts";

const base = join(import.meta.dirname, "..", "node_modules", ".cache", "wb-sync-test");
mkdirSync(base, { recursive: true });
const dir = mkdtempSync(join(base, "perf-"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * P1-07 budget: a local sale commit (10 lines, a tender, the signed outbox row) under 15 ms at p95, with WAL and
 * `synchronous=FULL` on a real file. The database sits on the repo drive: the OS temp dir can be behind a scanner.
 */
describe("local sale commit", () => {
  it("is under 15 ms at p95 with durable writes", { timeout: 60_000 }, async () => {
    const d = await createDevice({ file: join(dir, "device.db") });
    try {
      await d.db.exec(
        `create table sales (id text primary key, total integer);
         create table sale_lines (sale_id text, line integer, variant_id text, qty text, total integer, primary key (sale_id, line));
         create table sale_tenders (sale_id text, kind text, amount integer)`,
      );
      const times: number[] = [];
      for (let n = 0; n < 300; n++) {
        const t0 = performance.now();
        await d.outbox.transaction(async (tx) => {
          await tx.run("insert into sales values (?, ?)", [`s${String(n)}`, 1100]);
          const line = await tx.prepare("insert into sale_lines values (?, ?, ?, '1', 110)");
          for (let l = 0; l < 10; l++) await line.run([`s${String(n)}`, l, `v${String(l)}`]);
          await tx.run("insert into sale_tenders values (?, 'cash', 1100)", [`s${String(n)}`]);
          await tx.enqueue("complete_sale", saleBody(n));
        });
        times.push(performance.now() - t0);
      }
      times.sort((a, b) => a - b);
      const p95 = times[Math.floor(times.length * 0.95)] ?? 0;
      process.stderr.write(
        `local sale commit: p50 ${(times[150] ?? 0).toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, max ${(times.at(-1) ?? 0).toFixed(1)} ms\n`,
      );
      expect(p95).toBeLessThan(15);
    } finally {
      await d.close();
    }
  });
});
