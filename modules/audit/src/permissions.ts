import { definePermissions } from "@wise-biz/policy";

/** read: the audit viewer. export: CSV download (itself audited). */
export const AUDIT_PERMISSIONS = definePermissions("audit", ["read", "export"]);
