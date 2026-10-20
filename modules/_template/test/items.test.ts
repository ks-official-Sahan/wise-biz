import { countQueries, withTenantTx } from "@wise-biz/db";
import { uuidv7 } from "@wise-biz/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createItem, listItems } from "../src/application/items.ts";
import { newItem } from "../src/domain/item.ts";

import { clock, ctx, ids, repo, seed, setup } from "./helpers.ts";

import type pg from "pg";

const A = uuidv7();
const B = uuidv7();
const deps = { repo, clock, ids };
let pool: pg.Pool;
let migrator: pg.Pool;
let drop: () => Promise<void>;

beforeAll(async () => {
  ({ pool, migrator, drop } = await setup());
});
afterAll(async () => {
  await drop();
});

describe("domain", () => {
  const d = { tenantId: A, nextId: () => uuidv7(), now: new Date(0) };
  it("trims the name", () => {
    expect(newItem({ name: "  Tea  " }, d).item.name).toBe("Tea");
  });
  it.each([["   "], [""], ["x".repeat(201)]])("rejects invalid name %j", (name) => {
    expect(() => newItem({ name }, d)).toThrow(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );
  });
  it("rejects more than 20 children and blank labels", () => {
    expect(() => newItem({ name: "a", children: Array(21).fill("x") }, d)).toThrow();
    expect(() => newItem({ name: "a", children: [" "] }, d)).toThrow();
  });
});

describe("create + list", () => {
  it("round trips an item with children", async () => {
    const t = uuidv7();
    const created = await withTenantTx(pool, ctx(t), (tx) =>
      createItem(deps, tx, t, { name: " Widget ", children: ["red", "blue"] }),
    );
    expect(created.name).toBe("Widget");
    const page = await withTenantTx(pool, ctx(t), (tx) =>
      listItems(deps, tx, t, { limit: 50, include: ["children"] }),
    );
    expect(page.nextCursor).toBeNull();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.children?.map((c) => c.label).sort()).toEqual(["blue", "red"]);
  });

  it("rolls back item and children together when a child is invalid", async () => {
    const t = uuidv7();
    await expect(
      withTenantTx(pool, ctx(t), (tx) =>
        createItem(deps, tx, t, { name: "x", children: ["ok", ""] }),
      ),
    ).rejects.toThrow();
    const page = await withTenantTx(pool, ctx(t), (tx) => listItems(deps, tx, t, { limit: 10 }));
    expect(page.items).toEqual([]);
  });

  it("keyset-paginates 55 items: 50 + cursor, then 5", async () => {
    const t = uuidv7();
    await seed(pool, t, 55);
    const p1 = await withTenantTx(pool, ctx(t), (tx) => listItems(deps, tx, t, { limit: 50 }));
    expect(p1.items).toHaveLength(50);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await withTenantTx(pool, ctx(t), (tx) =>
      listItems(deps, tx, t, { limit: 50, after: p1.nextCursor ?? undefined }),
    );
    expect(p2.items).toHaveLength(5);
    expect(p2.nextCursor).toBeNull();
    const all = [...p1.items, ...p2.items].map((i) => i.id);
    expect(new Set(all).size).toBe(55);
    expect(all).toEqual([...all].sort());
  });

  it("rejects a malformed cursor", async () => {
    await expect(
      withTenantTx(pool, ctx(A), (tx) =>
        listItems(deps, tx, A, { limit: 5, after: "bm90LWEtdXVpZA" }),
      ),
    ).rejects.toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });
});

describe("query count (no N+1)", () => {
  it("is exactly 2 with include=children and 1 without, for 50 rows", async () => {
    const t = uuidv7();
    await seed(pool, t, 50, 3);
    const withInc = await countQueries(() =>
      withTenantTx(pool, ctx(t), (tx) =>
        listItems(deps, tx, t, { limit: 50, include: ["children"] }),
      ),
    );
    expect(withInc.result.items).toHaveLength(50);
    expect(withInc.result.items.every((i) => i.children?.length === 3)).toBe(true);
    expect(withInc.count).toBe(2);
    const without = await countQueries(() =>
      withTenantTx(pool, ctx(t), (tx) => listItems(deps, tx, t, { limit: 50 })),
    );
    expect(without.count).toBe(1);
  });
});

describe("tenant isolation (RLS)", () => {
  it("tenant A never sees or counts tenant B via repository or raw SQL", async () => {
    await seed(pool, A, 3, 1);
    await seed(pool, B, 4, 1);
    const listA = await withTenantTx(pool, ctx(A), (tx) =>
      listItems(deps, tx, A, { limit: 50, include: ["children"] }),
    );
    expect(listA.items).toHaveLength(3);
    // Even if the app passes the wrong tenant id, RLS returns nothing for B's rows.
    const spoof = await withTenantTx(pool, ctx(A), (tx) => listItems(deps, tx, B, { limit: 50 }));
    expect(spoof.items).toEqual([]);
    const raw = await withTenantTx(pool, ctx(A), async (tx) => ({
      items: (await tx.query("select count(*)::int as n from template.items")).rows[0],
      kids: (await tx.query("select count(*)::int as n from template.item_children")).rows[0],
    }));
    expect(raw).toEqual({ items: { n: 3 }, kids: { n: 3 } });
  });

  it("returns zero rows when no tenant is set", async () => {
    const res = await pool.query("select count(*)::int as n from template.items");
    expect(res.rows[0]).toEqual({ n: 0 });
  });

  it("cannot insert a row for another tenant", async () => {
    await expect(
      withTenantTx(pool, ctx(A), (tx) =>
        tx.query("insert into template.items (tenant_id, name) values ($1, 'x')", [B]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("a child cannot point at another tenant's item (composite FK)", async () => {
    const bItem = await withTenantTx(pool, ctx(B), async (tx) => {
      const r = await tx.query<{ id: string }>("select id from template.items limit 1");
      return r.rows[0]?.id;
    });
    // tenant_id = A (passes RLS) but item belongs to B -> FK violation.
    await expect(
      withTenantTx(pool, ctx(A), (tx) =>
        tx.query(
          "insert into template.item_children (tenant_id, item_id, label) values ($1, $2, 'x')",
          [A, bItem],
        ),
      ),
    ).rejects.toMatchObject({ code: "23503" });
    // Table owner with RLS forced and tenant A set: still blocked by the FK, not just by RLS.
    const client = await migrator.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.tenant_id', $1, true)", [A]);
      await expect(
        client.query(
          "insert into template.item_children (tenant_id, item_id, label) values ($1, $2, 'x')",
          [A, bItem],
        ),
      ).rejects.toMatchObject({ code: "23503" });
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});
