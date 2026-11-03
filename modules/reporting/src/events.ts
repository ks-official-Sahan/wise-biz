import { defineEvent } from "@wise-biz/contracts";
import { z } from "zod";

export const REPORTING_TOPIC = "reporting";

/** A requested export finished and can be downloaded (only the requester is told). */
export const ExportReadyV1 = defineEvent(
  "reporting.export.ready",
  1,
  z.object({
    exportId: z.string(),
    requestedBy: z.string(),
    kind: z.string(),
    rowCount: z.number().int(),
  }),
);

export const REPORTING_EVENTS = [ExportReadyV1] as const;
