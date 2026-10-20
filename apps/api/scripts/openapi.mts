import { writeFileSync } from "node:fs";

import { modules } from "../src/modules.ts";
import { buildOpenApi } from "../src/openapi.ts";

const target = new URL("../../../packages/contracts/generated/openapi.json", import.meta.url);
writeFileSync(target, buildOpenApi(modules));
console.log(`wrote ${target.pathname}`);
