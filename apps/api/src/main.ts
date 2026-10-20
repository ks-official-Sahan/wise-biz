import { startTelemetry } from "./telemetry.ts";

const stopTelemetry = await startTelemetry();
const { startServer } = await import("./server.ts");

const server = await startServer();

const shutdown = (): void => {
  void server
    .close()
    .then(() => stopTelemetry?.())
    .finally(() => process.exit(0));
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
