import { sql } from "drizzle-orm";
import { pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const templateSchema = pgSchema("template");

export const items = templateSchema.table("items", {
  id: uuid("id")
    .primaryKey()
    .default(sql`uuidv7()`),
  tenantId: uuid("tenant_id").notNull(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const itemChildren = templateSchema.table("item_children", {
  id: uuid("id")
    .primaryKey()
    .default(sql`uuidv7()`),
  tenantId: uuid("tenant_id").notNull(),
  itemId: uuid("item_id").notNull(),
  label: text("label").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
