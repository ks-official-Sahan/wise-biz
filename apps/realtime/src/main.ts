import { startRealtime } from "./start.ts";

const FORCE_EXIT_MS = 10_000;

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
  rt.stop().then(
    () => process.exit(code),
    () => process.exit(1),
  );
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
