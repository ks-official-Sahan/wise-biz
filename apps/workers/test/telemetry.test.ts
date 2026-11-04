import { expect, it } from "vitest";

import { startTelemetry } from "../src/telemetry.ts";

it("does not start the SDK without an OTLP endpoint", async () => {
  expect(await startTelemetry({})).toBeUndefined();
  expect(await startTelemetry({ OTEL_EXPORTER_OTLP_ENDPOINT: "" })).toBeUndefined();
});

it("starts the SDK under the service name and returns its shutdown", async () => {
  const calls: string[] = [];
  class FakeSdk {
    constructor(options: { serviceName: string }) {
      calls.push(`new ${options.serviceName}`);
    }
    start(): void {
      calls.push("start");
    }
    shutdown(): Promise<void> {
      calls.push("shutdown");
      return Promise.resolve();
    }
  }
  const stop = await startTelemetry({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" }, () =>
    Promise.resolve({ NodeSDK: FakeSdk }),
  );
  await stop?.();
  expect(calls).toEqual(["new wise-biz-workers", "start", "shutdown"]);
});
