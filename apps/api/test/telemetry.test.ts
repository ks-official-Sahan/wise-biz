import { expect, it } from "vitest";

import { startTelemetry } from "../src/telemetry.ts";

it("does not start the SDK without an OTLP endpoint", async () => {
  expect(await startTelemetry({})).toBeUndefined();
  expect(await startTelemetry({ OTEL_EXPORTER_OTLP_ENDPOINT: "" })).toBeUndefined();
});
