import { defineEvent } from "@wise-biz/contracts";
import { z } from "zod";

/** Emitted in the same transaction as the tenant insert (outbox). */
export const TenantCreatedV1 = defineEvent(
  "tenancy.tenant.created",
  1,
  z.object({
    tenantId: z.string(),
    name: z.string(),
    branchId: z.string(),
    locationId: z.string(),
    ownerUserId: z.string(),
  }),
);

export const TENANCY_TENANT_TOPIC = "tenancy.tenant";
