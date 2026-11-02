import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { _electron as electron, expect, test } from "@playwright/test";

import { TEA, scan, signIn } from "../../pos/e2e/mock-api.ts";

const root = path.resolve(import.meta.dirname, "..");
// ESC p 0 25 250: the pulse that opens the drawer.
const KICK = Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]);

test("a cash sale prints the receipt and kicks the drawer on the network printer", async () => {
  const jobs: Buffer[] = [];
  const server = net.createServer((socket) => {
    const chunks: Buffer[] = [];
    socket.on("data", (c) => chunks.push(c));
    socket.on("end", () => {
      jobs.push(Buffer.concat(chunks));
      socket.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as net.AddressInfo;

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "wb-desktop-sale-"));
  fs.writeFileSync(
    path.join(userData, "hardware.json"),
    JSON.stringify({
      printer: { kind: "network", host: "127.0.0.1", port },
      scale: { kind: "none" },
    }),
  );
  const app = await electron.launch({
    args: [root],
    env: { ...process.env, WISE_BIZ_E2E: "1", WISE_BIZ_USER_DATA: userData },
  });
  try {
    const page = await app.firstWindow();
    await signIn(page, { routes: app.context(), goto: false });
    await scan(page, TEA);
    await page.getByTestId("sell-pay").click();
    await page.getByTestId("tender-suggest-0").click();
    await expect(page.getByTestId("tender-sheet")).toContainText("Receipt printed", {
      timeout: 10_000,
    });

    await expect.poll(() => jobs.length).toBe(1);
    const job = jobs[0] ?? Buffer.alloc(0);
    expect(job.subarray(0, 2)).toEqual(Buffer.from([0x1b, 0x40])); // ESC @ initialise
    expect(job.includes(Buffer.from("Green Tea 500 g"))).toBe(true);
    expect(job.subarray(job.length - KICK.length)).toEqual(KICK);
  } finally {
    await app.close();
    await new Promise<void>((r) =>
      server.close(() => {
        r();
      }),
    );
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
