import { startSentry } from "@wise-biz/observability";

import { startTelemetry } from "./telemetry.ts";

const FORCE_EXIT_MS = 10_000;

const stopTelemetry = await startTelemetry();
const stopSentry = await startSentry(process.env, () => import("@sentry/node"), "wise-biz-api");
const { startServer } = await import("./server.ts");

const server = await startServer();

let shuttingDown = false;
const shutdown = (signal: string): void => {
  if (shuttingDown) {
    process.stderr.write(`second ${signal}: forcing exit\n`);
    process.exit(1);
  }
  shuttingDown = true;
  setTimeout(() => {
    process.stderr.write("shutdown timed out: forcing exit\n");
    process.exit(1);
  }, FORCE_EXIT_MS).unref();
  server
    .close()
    .then(() => stopTelemetry?.())
    .then(() => stopSentry?.())
    .then(
      () => process.exit(0),
      () => process.exit(1),
    );
};
process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  shutdown("SIGINT");
});
