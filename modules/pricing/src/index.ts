import { join } from "node:path";

import { defineModule } from "@wise-biz/module-kit";
import { definePermissions } from "@wise-biz/policy";

import { PRICING_EVENTS } from "./events.ts";
import { mountRoutes } from "./http.ts";

import type { BatchPrices } from "./application/quote.ts";
import type { WbModule } from "@wise-biz/module-kit";

export {
  FeeUpsertedV1,
  FxRateRecordedV1,
  PriceChangedV1,
  PriceListUpsertedV1,
  PromotionArchivedV1,
  PromotionPublishedV1,
  TaxRegionUpsertedV1,
} from "./events.ts";
export { createPricingFactsConsumer, PRICING_FACTS_CONSUMER } from "./projection.ts";
export type { PricingFactsConsumer } from "./projection.ts";
export type { BatchPrices, Quote } from "./application/quote.ts";

/** Price lists, tax regions, fees, promotions, coupons, FX rates and the server-side quote (same engine as devices). */
export function createPricingModule(opts: { batchPrices?: BatchPrices } = {}): WbModule {
  return defineModule({
    name: "pricing",
    migrationsDir: join(import.meta.dirname, "..", "migrations"),
    permissions: definePermissions("pricing", ["read", "write"]),
    events: [...PRICING_EVENTS],
    routes: (app, deps) => {
      mountRoutes(app, deps, opts.batchPrices);
    },
  });
}
