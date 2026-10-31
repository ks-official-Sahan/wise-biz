import { batchSalePrices, recordMovements, selectBatchesFefo } from "@wise-biz/module-inventory";
import { quote } from "@wise-biz/module-pricing";

import type { OperatorFacts, SalesPorts } from "@wise-biz/module-sales";

/**
 * Sales applies terminal documents against inventory, pricing and tenancy (P1-05). The composition root bridges them
 * with in-process calls in the caller's tenant transaction, so modules never read each other's tables or import each
 * other. After extraction these become the contracts the services expose.
 */
export const salesPorts: SalesPorts = {
  inventory: { recordMovements, batches: batchSalePrices, selectBatchesFefo },
  pricing: {
    // The quote takes the batch facts through the same bridge, so a batch's own sale price wins as on the device.
    quote: (tx, tenantId, input, at) =>
      quote(
        tx,
        tenantId,
        {
          priceListId: input.priceListId,
          lines: input.lines.map((l) => ({ ...l })),
          ...(input.coupons === undefined ? {} : { coupons: [...input.coupons] }),
          ...(input.customerGroup === undefined ? {} : { customerGroup: input.customerGroup }),
        },
        at,
        batchSalePrices,
      ),
  },
  tenancy: {
    // One indexed query for all operators: membership status plus unconditional grants (a conditional grant, e.g. a
    // value limit, never approves an offline document). The owner role is implicit and grants everything.
    operators: async (tx, tenantId, userIds) => {
      if (userIds.length === 0) return new Map();
      const r = await tx.query<{
        user_id: string;
        active: boolean;
        owner: boolean;
        permissions: string[];
      }>(
        `select m.user_id, m.status = 'active' as active, coalesce(bool_or(r.name = 'owner'), false) as owner,
           coalesce(array_agg(distinct rp.permission) filter (where rp.permission is not null
             and rp.conditions is null), '{}') as permissions
         from tenancy.memberships m
         left join tenancy.membership_roles mr on mr.tenant_id = m.tenant_id and mr.membership_id = m.id
         left join tenancy.roles r on r.tenant_id = mr.tenant_id and r.id = mr.role_id
         left join tenancy.role_permissions rp on rp.tenant_id = r.tenant_id and rp.role_id = r.id
         where m.tenant_id = $1 and m.user_id = any($2::uuid[])
         group by m.user_id, m.status`,
        [tenantId, [...new Set(userIds)]],
      );
      return new Map<string, OperatorFacts>(
        r.rows.map((x) => [
          x.user_id,
          { active: x.active, permissions: x.owner ? "all" : new Set(x.permissions) },
        ]),
      );
    },
    policyVersion: async (tx, tenantId) => {
      const r = await tx.query<{ v: number }>(
        "select permissions_version as v from tenancy.tenants where tenant_id = $1",
        [tenantId],
      );
      return r.rows[0]?.v ?? 0;
    },
  },
};
