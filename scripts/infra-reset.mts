import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

// Cross-platform `pnpm infra:reset`: a `sh -c '...'` one-liner breaks under cmd.exe (Windows ignores single quotes).
// Deletes every local infra volume (Postgres, Redis, storage, Kafka), then brings the stack back up, so the Postgres
// init scripts (roles, extensions) run again. `--yes` skips the prompt (CI, scripts).

const COMPOSE = [
  "compose",
  "-f",
  "infra/docker/compose.yaml",
  "--profile",
  "kafka",
  "--profile",
  "init",
];

if (!process.argv.includes("--yes")) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("Delete ALL local infra data (volumes)? [y/N] "))
    .trim()
    .toLowerCase();
  rl.close();
  if (answer !== "y" && answer !== "yes") {
    console.log("aborted");
    process.exit(1);
  }
}

// Constant arguments only; a shell is needed on Windows to resolve the pnpm .cmd shim.
const run = (cmd: string, args: string[]): void => {
  execFileSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });
};
run("docker", [...COMPOSE, "down", "-v"]);
run("pnpm", ["infra:up"]);
