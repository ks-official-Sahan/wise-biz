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

/** Yesterday's sales for one business, per currency (once per business date). */
export const DigestReadyV1 = defineEvent(
  "reporting.digest.ready",
  1,
  z.object({
    businessDate: z.string(),
    totals: z.array(
      z.object({
        currency: z.string(),
        salesCount: z.number().int(),
        netMinor: z.number().int(),
        voidsCount: z.number().int(),
        returnsCount: z.number().int(),
      }),
    ),
  }),
);

export const REPORTING_EVENTS = [ExportReadyV1, DigestReadyV1] as const;
