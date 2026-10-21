import { join } from "node:path";

import { defineModule } from "@wise-biz/module-kit";
import { definePermissions } from "@wise-biz/policy";

import { mountRoutes } from "./adapters/http/routes.ts";
import { TemplateItemCreatedV1 } from "./events.ts";

export const templateModule = defineModule({
  name: "_template",
  migrationsDir: join(import.meta.dirname, "..", "migrations"),
  permissions: definePermissions("template", ["read", "write"]),
  events: [TemplateItemCreatedV1],
  routes: mountRoutes,
  devOnly: true,
});
