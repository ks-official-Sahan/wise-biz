export { isValidConditions } from "./conditions.ts";
export type {
  Conditions,
  ConditionReason,
  DayOfWeek,
  DecisionContext,
  DeviceClass,
  Resource,
  TimeWindow,
} from "./conditions.ts";
export { decide } from "./decide.ts";
export type { Decision, Override, Reason } from "./decide.ts";
export { matrixFromRows, toAuthKitMatrix } from "./matrix.ts";
export type { Grant, PolicyMatrix, PolicyRow } from "./matrix.ts";
export {
  createCatalog,
  definePermissions,
  isPermission,
  isPlatformPermission,
  PLATFORM_MODULE,
} from "./permissions.ts";
export type { Permission, PermissionCatalog } from "./permissions.ts";
export {
  isSystemRole,
  isTenantRole,
  OWNER_ROLE,
  PLATFORM_ADMIN_ROLE,
  SYSTEM_ROLES,
} from "./roles.ts";
export type { SystemRole } from "./roles.ts";
export { SNAPSHOT_DOMAIN_TAG, signSnapshot, verifySnapshot } from "./snapshot.ts";
export type {
  PolicySnapshot,
  SignedSnapshot,
  SnapshotFailure,
  SnapshotResult,
} from "./snapshot.ts";
