import { templateModule } from "@wise-biz/module-template";

import type { WbModule } from "@wise-biz/module-kit";

/** Mounted modules, in registry order (modules/registry.json). devOnly ones are skipped in production. */
export const modules: readonly WbModule[] = [templateModule];
