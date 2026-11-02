import { createMemoryPrinter } from "@wise-biz/hardware";
import { createMockAdapter } from "@wise-biz/payments-adapters";

import type { Printer } from "@wise-biz/hardware";
import type { PaymentAdapter } from "@wise-biz/payments-adapters";

export interface Devices {
  /** Undefined hides the card button: a terminal with no card reader set up takes cash only. */
  readonly adapter: PaymentAdapter | undefined;
  /** Undefined means "no printer set up": the sale still completes and the sheet says so. */
  readonly printer: Printer | undefined;
}

/**
 * The devices this terminal has. Real printers and card readers are configured per terminal in settings (P1-12 / P1-13);
 * until then a build opts into the mock card terminal and an in-memory printer with EXPO_PUBLIC_MOCK_PAYMENTS=1 (demos
 * and the e2e suite). A release build without the flag never carries a card button that approves everything.
 */
export function configuredDevices(): Devices {
  if (process.env.EXPO_PUBLIC_MOCK_PAYMENTS !== "1")
    return { adapter: undefined, printer: undefined };
  const printer = createMemoryPrinter();
  (globalThis as { __wbPrinterJobs?: Uint8Array[] }).__wbPrinterJobs = printer.jobs;
  return { adapter: createMockAdapter({ scenario: { kind: "approve", afterMs: 400 } }), printer };
}
