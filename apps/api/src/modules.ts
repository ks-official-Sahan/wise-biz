import { templateModule } from "@wise-biz/module-template";
import { createTenancyModule } from "@wise-biz/module-tenancy";

import type { WbModule } from "@wise-biz/module-kit";
import type { ActiveTenantSetter, TenancyModuleOptions } from "@wise-biz/module-tenancy";

/**
 * Mounted modules, in registry order (modules/registry.json; identity is global and mounted by the kernel at
 * /v1/auth/*). devOnly ones are skipped in production. Tenancy gets its narrow session port and its invite secret from
 * the kernel.
 */
export function createModules(
  sessions: ActiveTenantSetter,
  tenancy: TenancyModuleOptions = {},
): readonly WbModule[] {
  return [createTenancyModule(sessions, tenancy), templateModule];
}

/** Route/permission shapes only (OpenAPI generation, tests): the session port is not wired and must never be called. */
export const docModules: readonly WbModule[] = createModules({
  setActiveTenant: () => Promise.reject(new Error("docModules: session port is not wired")),
});
