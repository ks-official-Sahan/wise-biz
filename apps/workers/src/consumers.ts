import type { ConsumerDefinition } from "@wise-biz/events";

/** Consumers run by this worker. Modules append here as they ship (P1+). */
export const consumers: readonly ConsumerDefinition[] = [];
