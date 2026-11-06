import { startSentry } from "@wise-biz/observability";

import { startAll } from "./lifecycle.ts";

const FORCE_EXIT_MS = 10_000;

// One Sentry and one tracing setup for the whole process, tagged as the server.
const stopSentry = await startSentry(process.env, () => import("@sentry/node"), "wise-biz-server");
const stopTelemetry = await (async () => {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return undefined;
  const { NodeSDK } = await import("@opentelemetry/sdk-node");
  const sdk = new NodeSDK({ serviceName: "wise-biz-server" });
  sdk.start();
  return () => sdk.shutdown();
})();

const { startServer } = await import("@wise-biz/api/server");
const { startWorker } = await import("@wise-biz/workers");

const all = await startAll({ startApi: () => startServer(), startWorker: () => startWorker() });

let shuttingDown = false;
const shutdown = (signal: string, code = 0): void => {
  if (shuttingDown) {
    process.stderr.write(`second ${signal}: forcing exit\n`);
    process.exit(1);
  }
  shuttingDown = true;
  setTimeout(() => {
    process.stderr.write("shutdown timed out: forcing exit\n");
    process.exit(1);
  }, FORCE_EXIT_MS).unref();
  all
    .stop()
    .then(
      () => 0,
      () => 1,
    )
    .then(async (failed) => {
      await stopTelemetry?.().catch(() => undefined);
      await stopSentry?.().catch(() => undefined);
      process.exit(failed === 0 ? code : 1);
    })
    .catch(() => process.exit(1));
};
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`unhandled rejection: ${String(reason)}\n`);
  shutdown("unhandledRejection", 1);
});
process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  shutdown("SIGINT");
});
