import { definePermissions } from "@wise-biz/policy";

export const TENANCY_PERMISSIONS = definePermissions("tenancy", ["read", "manage"]);
