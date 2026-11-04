import { afterEach, describe, expect, it } from "vitest";

import { exportOutbox, ExportError, openExport } from "../src/export.ts";

import { createDevice, saleBody } from "./support/fake-server.ts";

import type { Device } from "./support/fake-server.ts";

const open: Device[] = [];
afterEach(async () => {
  for (const d of open.splice(0)) await d.close().catch(() => undefined);
});
const device = async () => {
  const d = await createDevice();
  open.push(d);
  return d;
};
const material = (fill: number) => new Uint8Array(32).fill(fill);

describe("outbox export", () => {
  it("round-trips the pending commands, in order, under the tenant key material", async () => {
    const d = await device();
    for (let n = 0; n < 5; n++) {
      await d.outbox.transaction((tx) =>
        tx.enqueue("complete_sale", saleBody(n, { customer: "Ada" })),
      );
    }
    await d.outbox.recordAcks([{ seq: 0, status: "applied" }]);
    const file = await exportOutbox({
      outbox: d.outbox,
      deviceId: "dev-1",
      material: material(7),
      now: () => 42,
    });
    expect(file).toMatchObject({
      v: 1,
      deviceId: "dev-1",
      exportedAt: 42,
      fromSeq: 1,
      toSeq: 4,
      count: 4,
    });
    if (file === undefined) throw new Error("no file");
    const back = openExport(file, material(7));
    expect(back.map((c) => c.body.meta.deviceSeq)).toEqual([1, 2, 3, 4]);
    expect(back[0]).toEqual((await d.outbox.allPending())[0]?.command);
    // Customer data is not readable in the file.
    expect(JSON.stringify(file)).not.toContain("Ada");
  });

  it("uses a fresh salt and nonce every time", async () => {
    const d = await device();
    await d.outbox.transaction((tx) => tx.enqueue("x", { n: 1 }));
    const a = await exportOutbox({ outbox: d.outbox, deviceId: "d", material: material(1) });
    const b = await exportOutbox({ outbox: d.outbox, deviceId: "d", material: material(1) });
    expect(a?.salt).not.toBe(b?.salt);
    expect(a?.nonce).not.toBe(b?.nonce);
    expect(a?.ct).not.toBe(b?.ct);
  });

  it("refuses a wrong key and any modified part of the file", async () => {
    const d = await device();
    await d.outbox.transaction((tx) => tx.enqueue("x", { n: 1 }));
    const file = await exportOutbox({ outbox: d.outbox, deviceId: "d", material: material(1) });
    if (file === undefined) throw new Error("no file");
    expect(() => openExport(file, material(2))).toThrow(ExportError);
    expect(() => openExport({ ...file, deviceId: "other" }, material(1))).toThrow(ExportError);
    expect(() => openExport({ ...file, toSeq: 9 }, material(1))).toThrow(ExportError);
    expect(() => openExport({ ...file, count: 2 }, material(1))).toThrow(ExportError);
    const flipped = file.ct.startsWith("A") ? `B${file.ct.slice(1)}` : `A${file.ct.slice(1)}`;
    expect(() => openExport({ ...file, ct: flipped }, material(1))).toThrow(ExportError);
    expect(() => openExport({ ...file, v: 2 as never }, material(1))).toThrow(/version/);
  });

  it("returns nothing when everything is synced, and rejects weak key material", async () => {
    const d = await device();
    expect(
      await exportOutbox({ outbox: d.outbox, deviceId: "d", material: material(1) }),
    ).toBeUndefined();
    await expect(
      exportOutbox({ outbox: d.outbox, deviceId: "d", material: new Uint8Array(16) }),
    ).rejects.toThrow(/too short/);
  });
});
