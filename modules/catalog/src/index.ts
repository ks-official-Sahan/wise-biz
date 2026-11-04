import { join } from "node:path";

import { defineModule } from "@wise-biz/module-kit";
import { definePermissions } from "@wise-biz/policy";

import { CATALOG_EVENTS } from "./events.ts";
import { mountRoutes } from "./http.ts";
import { mountImportRoutes } from "./import/http.ts";
import { mountMediaRoutes } from "./media.ts";

import type { WbModule } from "@wise-biz/module-kit";
import type { ObjectStore } from "@wise-biz/storage";

export {
  BarcodeChangedV1,
  ProductUpsertedV1,
  VariantArchivedV1,
  VariantUpsertedV1,
} from "./events.ts";
export { gs1CheckDigitOk, normaliseBarcode } from "./domain/barcode.ts";
export { createImportConsumer, IMPORT_CONSUMER, MAX_IMPORT_BYTES } from "./import/http.ts";
export type { ImportConsumer } from "./import/http.ts";
export type { ImportJobDeps } from "./import/job.ts";
export { MEDIA_WIDTHS, mediaObjectKey } from "./media.ts";

/** Products, variants, barcodes, units, categories, tags. Emits catalog.* for search, pricing and the POS cache. */
export function createCatalogModule(opts: { store: ObjectStore }): WbModule {
  return defineModule({
    name: "catalog",
    migrationsDir: join(import.meta.dirname, "..", "migrations"),
    permissions: definePermissions("catalog", ["read", "write"]),
    events: [...CATALOG_EVENTS],
    routes: (app, deps) => {
      mountRoutes(app, deps);
      mountImportRoutes(app, deps, opts.store);
      mountMediaRoutes(app, deps, opts.store);
    },
  });
}
