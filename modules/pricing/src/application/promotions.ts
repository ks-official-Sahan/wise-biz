import { DomainError } from "@wise-biz/errors";

import { PromotionArchivedV1, PromotionPublishedV1 } from "../events.ts";
import { CreatePromotionSchema } from "../schemas.ts";

import { invalid, iso, notFound, num, pricingEvent, stale, one } from "./shared.ts";

import type {
  CreateCouponSchema,
  EffectSchema,
  TargetSchema,
  UpdatePromotionSchema,
} from "../schemas.ts";
import type { TxHandle } from "@wise-biz/db";
import type { CommandContext, CommandResult } from "@wise-biz/module-kit";
import type { z } from "zod";

interface PromoRow {
  id: string;
  name: string;
  status: "draft" | "published" | "archived";
  priority: number;
  stackable: boolean;
  target: z.infer<typeof TargetSchema>;
  effect: z.infer<typeof EffectSchema>;
  requires_coupon: boolean;
  customer_groups: string[] | null;
  starts_at: Date | null;
  ends_at: Date | null;
  min_qty: string | null;
  min_amount_minor: string | null;
  version: number;
  published_at: Date | null;
}
export const PROMO_COLS = `id, name, status, priority, stackable, target, effect, requires_coupon, customer_groups,
  starts_at, ends_at, min_qty, min_amount_minor, version, published_at`;
export const toPromotion = (r: PromoRow) => ({
  id: r.id,
  name: r.name,
  status: r.status,
  priority: r.priority,
  stackable: r.stackable,
  target: r.target,
  effect: r.effect,
  requiresCoupon: r.requires_coupon,
  customerGroups: r.customer_groups,
  startsAt: iso(r.starts_at),
  endsAt: iso(r.ends_at),
  minQty: r.min_qty,
  minAmountMinor: num(r.min_amount_minor),
  version: r.version,
  publishedAt: iso(r.published_at),
});
export type Promotion = ReturnType<typeof toPromotion>;
export type { PromoRow };

async function load(tx: TxHandle, tenantId: string, id: string): Promise<Promotion> {
  const r = await tx.query<PromoRow>(
    `select ${PROMO_COLS} from pricing.promotions where tenant_id = $1 and id = $2 for update`,
    [tenantId, id],
  );
  const row = r.rows[0];
  return row === undefined ? notFound() : toPromotion(row);
}

export async function getPromotion(tx: TxHandle, tenantId: string, id: string) {
  const r = await tx.query<PromoRow>(
    `select ${PROMO_COLS} from pricing.promotions where tenant_id = $1 and id = $2`,
    [tenantId, id],
  );
  const row = r.rows[0];
  return row === undefined ? undefined : toPromotion(row);
}

/** Keyset page by id (UUIDv7 = creation order), newest last; optional status filter. */
export async function listPromotions(
  tx: TxHandle,
  tenantId: string,
  q: { status?: string | undefined; after?: string | undefined; limit: number },
) {
  const params: unknown[] = [tenantId, q.limit + 1];
  const where = ["tenant_id = $1"];
  if (q.status !== undefined) {
    params.push(q.status);
    where.push(`status = $${String(params.length)}`);
  }
  if (q.after !== undefined) {
    params.push(q.after);
    where.push(`id > $${String(params.length)}`);
  }
  const r = await tx.query<PromoRow>(
    `select ${PROMO_COLS} from pricing.promotions where ${where.join(" and ")} order by id limit $2`,
    params,
  );
  const rows = r.rows.slice(0, q.limit);
  return {
    items: rows.map(toPromotion),
    nextCursor: r.rows.length > q.limit ? (rows.at(-1)?.id ?? null) : null,
  };
}

const values = (p: z.output<typeof CreatePromotionSchema>) => [
  p.name,
  p.priority,
  p.stackable,
  JSON.stringify(p.target),
  JSON.stringify(p.effect),
  p.requiresCoupon,
  p.customerGroups ?? null,
  p.startsAt ?? null,
  p.endsAt ?? null,
  p.minQty ?? null,
  p.minAmountMinor ?? null,
];

export async function createPromotionCommand(
  tx: TxHandle,
  ctx: CommandContext,
  input: z.output<typeof CreatePromotionSchema>,
): Promise<CommandResult> {
  const id = input.id ?? ctx.ids.uuidv7();
  const r = await tx.query<PromoRow>(
    `insert into pricing.promotions (tenant_id, id, name, priority, stackable, target, effect, requires_coupon,
       customer_groups, starts_at, ends_at, min_qty, min_amount_minor, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $14)
     returning ${PROMO_COLS}`,
    [ctx.tenant.tenantId, id, ...values(input), ctx.now],
  );
  const promo = toPromotion(one(r.rows));
  return {
    status: 201,
    body: promo,
    audit: [
      {
        action: "pricing.promotion.created",
        entity: "pricing.promotion",
        entityId: id,
        after: promo,
      },
    ],
    // A draft reaches no device and no cart; publishing emits the event.
    noEvents: true,
  };
}

const notDraft = (): never => {
  throw new DomainError(
    "CONFLICT",
    "Only draft promotions can be changed. Archive it and create a new one.",
  );
};

export async function updatePromotionCommand(
  tx: TxHandle,
  ctx: CommandContext,
  id: string,
  input: z.output<typeof UpdatePromotionSchema>,
): Promise<CommandResult> {
  const before = await load(tx, ctx.tenant.tenantId, id);
  if (before.status !== "draft") return notDraft();
  if (before.version !== input.version) return stale();
  const patch: Partial<typeof input> = { ...input };
  delete patch.version;
  const merged = CreatePromotionSchema.safeParse({
    ...before,
    ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
    id: undefined,
  });
  if (!merged.success) {
    const issue = merged.error.issues[0];
    return invalid(issue?.path.join(".") ?? "", issue?.message ?? "invalid promotion");
  }
  const r = await tx.query<PromoRow>(
    `update pricing.promotions set name = $3, priority = $4, stackable = $5, target = $6::jsonb, effect = $7::jsonb,
       requires_coupon = $8, customer_groups = $9, starts_at = $10, ends_at = $11, min_qty = $12,
       min_amount_minor = $13, version = version + 1, updated_at = $14
     where tenant_id = $1 and id = $2 returning ${PROMO_COLS}`,
    [ctx.tenant.tenantId, id, ...values(merged.data), ctx.now],
  );
  const after = toPromotion(one(r.rows));
  return {
    status: 200,
    body: after,
    audit: [
      {
        action: "pricing.promotion.updated",
        entity: "pricing.promotion",
        entityId: id,
        before,
        after,
      },
    ],
    noEvents: true,
  };
}

/** draft -> published (immutable from here) or any -> archived. */
export async function transitionPromotionCommand(
  tx: TxHandle,
  ctx: CommandContext,
  id: string,
  to: "published" | "archived",
  version: number,
): Promise<CommandResult> {
  const before = await load(tx, ctx.tenant.tenantId, id);
  if (before.version !== version) return stale();
  if (to === "published" && before.status !== "draft") return notDraft();
  if (to === "archived" && before.status === "archived") {
    throw new DomainError("CONFLICT", "This promotion is already archived.");
  }
  const r = await tx.query<PromoRow>(
    `update pricing.promotions set status = $3,
       published_at = case when $3 = 'published' then $4 else published_at end, version = version + 1, updated_at = $4
     where tenant_id = $1 and id = $2 returning ${PROMO_COLS}`,
    [ctx.tenant.tenantId, id, to, ctx.now],
  );
  const after = toPromotion(one(r.rows));
  const event =
    to === "published"
      ? pricingEvent(PromotionPublishedV1, ctx, `promotion/${id}`, {
          promotionId: id,
          name: after.name,
          priority: after.priority,
          stackable: after.stackable,
          target: after.target,
          effect: after.effect,
          requiresCoupon: after.requiresCoupon,
          customerGroups: after.customerGroups,
          startsAt: after.startsAt,
          endsAt: after.endsAt,
          minQty: after.minQty,
          minAmountMinor: after.minAmountMinor,
          version: after.version,
        })
      : pricingEvent(PromotionArchivedV1, ctx, `promotion/${id}`, {
          promotionId: id,
          version: after.version,
        });
  return {
    status: 200,
    body: after,
    audit: [
      {
        action: `pricing.promotion.${to}`,
        entity: "pricing.promotion",
        entityId: id,
        before,
        after,
      },
    ],
    events: [event],
  };
}

// --- Coupons ---

interface CouponRow {
  id: string;
  promotion_id: string;
  code: string;
  max_uses: number | null;
  uses: number;
  active: boolean;
}
const toCoupon = (r: CouponRow) => ({
  id: r.id,
  promotionId: r.promotion_id,
  code: r.code,
  maxUses: r.max_uses,
  uses: r.uses,
  active: r.active,
});

export async function createCouponCommand(
  tx: TxHandle,
  ctx: CommandContext,
  promotionId: string,
  input: z.output<typeof CreateCouponSchema>,
): Promise<CommandResult> {
  const promo = await load(tx, ctx.tenant.tenantId, promotionId);
  if (!promo.requiresCoupon) invalid("promotionId", "This promotion does not take coupons.");
  if (promo.status === "archived") return notDraft();
  const id = input.id ?? ctx.ids.uuidv7();
  const r = await tx.query<CouponRow>(
    `insert into pricing.coupons (tenant_id, id, promotion_id, code, max_uses, created_at)
     values ($1, $2, $3, $4, $5, $6) returning id, promotion_id, code, max_uses, uses, active`,
    [ctx.tenant.tenantId, id, promotionId, input.code, input.maxUses ?? null, ctx.now],
  );
  const coupon = toCoupon(one(r.rows));
  return {
    status: 201,
    body: coupon,
    audit: [
      { action: "pricing.coupon.created", entity: "pricing.coupon", entityId: id, after: coupon },
    ],
    // Codes are secrets of a kind: never broadcast. The quote checks them server-side.
    noEvents: true,
  };
}

export async function listCoupons(tx: TxHandle, tenantId: string, promotionId: string) {
  const r = await tx.query<CouponRow>(
    `select id, promotion_id, code, max_uses, uses, active from pricing.coupons
     where tenant_id = $1 and promotion_id = $2 order by id`,
    [tenantId, promotionId],
  );
  return r.rows.map(toCoupon);
}
