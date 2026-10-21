import { z } from "zod";

import { defineEvent } from "./registry.ts";

/** SAMPLE event so generators have content; replaced by real P1 events (docs/architecture/events.md). */
export const PlatformContractsPingV1 = defineEvent(
  "platform.contracts.ping",
  1,
  z.object({ note: z.string() }),
);
