import { join } from "node:path";

import { defineModule } from "@wise-biz/module-kit";
import { definePermissions } from "@wise-biz/policy";

import { THEMING_EVENTS } from "./events.ts";
import { mountRoutes } from "./http.ts";

export { ReceiptTemplateChangedV1, ThemePublishedV1 } from "./events.ts";
export { contrastIssues } from "./application.ts";

/** The look of the business: versioned themes (draft, publish, rollback) and receipt templates. */
export const themingModule = defineModule({
  name: "theming",
  migrationsDir: join(import.meta.dirname, "..", "migrations"),
  permissions: definePermissions("theming", ["read", "write"]),
  events: [...THEMING_EVENTS],
  routes: mountRoutes,
});
