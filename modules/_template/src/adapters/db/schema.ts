import { sql } from "drizzle-orm";
import { pgSchema, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const templateSchema = pgSchema("template");

// Mirrors migrations/0001_init.sql (the migration is the source of truth). PK is (tenant_id, id).
export const items = templateSchema.table(
  "items",
  {
    id: uuid("id")
      .notNull()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: "items_pkey", columns: [t.tenantId, t.id] })],
);

export const itemChildren = templateSchema.table(
  "item_children",
  {
    id: uuid("id")
      .notNull()
      .default(sql`uuidv7()`),
    tenantId: uuid("tenant_id").notNull(),
    itemId: uuid("item_id").notNull(),
    label: text("label").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: "item_children_pkey", columns: [t.tenantId, t.id] })],
);
