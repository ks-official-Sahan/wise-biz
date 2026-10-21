import { expect, it } from "vitest";

import { postgresGlobalSetup } from "./global-setup.ts";
import { attachPostgres } from "./postgres.ts";

import type { WbPgInfo } from "./global-setup.ts";

it("globalSetup provides wbPg, runs prepare, and tears down; failed prepare stops the server", async () => {
  const provided: Record<string, WbPgInfo> = {};
  let prepared = false;
  const teardown = await postgresGlobalSetup({
    prepare: async (pg) => {
      await pg.createDatabase("prep_check");
      prepared = true;
    },
  })({
    provide: (key, value) => {
      provided[key] = value;
    },
  });
  expect(prepared).toBe(true);
  const info = provided.wbPg;
  expect(info?.port).toBeGreaterThan(0);
  const pg = attachPostgres(info?.host ?? "", info?.port ?? 0);
  await pg.dropDatabase("prep_check");
  await teardown();

  await expect(
    postgresGlobalSetup({ prepare: () => Promise.reject(new Error("boom")) })({
      provide: () => undefined,
    }),
  ).rejects.toThrow("boom");
});
