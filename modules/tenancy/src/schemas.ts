import { Uuid7 } from "@wise-biz/contracts";
import { z } from "zod";

import { BRANCH_KINDS, isIanaTimezone } from "./domain/business.ts";

/** Shape only; the domain trims and enforces the business rules again (defence in depth). */
export const SignUpBusinessSchema = z
  .object({
    tenantId: Uuid7,
    name: z.string().max(1000),
    branch: z.object({
      name: z.string().max(1000),
      kind: z.enum(BRANCH_KINDS),
      timezone: z.string().max(64).refine(isIanaTimezone, "must be an IANA time zone"),
      currency: z.string().max(3),
      taxRegion: z.string().max(100),
      businessDayCutoff: z.string().max(5).optional(),
    }),
  })
  .meta({ id: "TenancySignUpBusiness" });

export const TenantCreatedSchema = z
  .object({ tenantId: Uuid7, name: z.string(), branchId: Uuid7, locationId: Uuid7 })
  .meta({ id: "TenancyTenantCreated" });

export const MyTenantSchema = z
  .object({ tenantId: Uuid7, name: z.string(), membershipId: Uuid7 })
  .meta({ id: "TenancyMyTenant" });

export const MyTenantsSchema = z
  .object({ tenants: z.array(MyTenantSchema) })
  .meta({ id: "TenancyMyTenants" });

export const SwitchTenantSchema = z.object({ tenantId: Uuid7 }).meta({ id: "TenancySwitchTenant" });

export type SignUpBusinessInput = z.infer<typeof SignUpBusinessSchema>;
export type TenantCreatedDto = z.infer<typeof TenantCreatedSchema>;
export type MyTenantDto = z.infer<typeof MyTenantSchema>;
