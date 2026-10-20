import { join } from "node:path";

import { defineModule } from "@wise-biz/module-kit";
import { definePermissions } from "@wise-biz/policy";

import { mountRoutes } from "./adapters/http/routes.ts";

export const templateModule = defineModule({
  name: "_template",
  migrationsDir: join(import.meta.dirname, "..", "migrations"),
  permissions: definePermissions("template", ["read", "write"]),
  events: [],
  routes: mountRoutes,
  devOnly: true,
});
