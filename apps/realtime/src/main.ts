import { startSentry } from "@wise-biz/observability";

import { startTelemetry } from "./telemetry.ts";

const FORCE_EXIT_MS = 10_000;

const stopTelemetry = await startTelemetry(process.env, () => import("@opentelemetry/sdk-node"));
const stopSentry = await startSentry(
  process.env,
  () => import("@sentry/node"),
  "wise-biz-realtime",
);
const { startRealtime } = await import("./start.ts");

const rt = await startRealtime();

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
  rt.stop()
    .then(
      () => 0,
      () => 1,
    )
    // Flush telemetry after a failed stop too; keep the failure as the exit code.
    .then(async (failed) => {
      await stopTelemetry?.().catch(() => undefined);
      await stopSentry?.().catch(() => undefined);
      process.exit(failed === 0 ? code : 1);
    })
    .catch(() => process.exit(1));
};
process.on("unhandledRejection", (reason) => {
  rt.logger.fatal({ err: reason }, "unhandled rejection: stopping realtime");
  shutdown("unhandledRejection", 1);
});
process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  shutdown("SIGINT");
});
