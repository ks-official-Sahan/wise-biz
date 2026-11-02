// Builds the web bundle the e2e suite serves, pointing at the mocked API origin (see onboarding.spec.ts).
import { spawnSync } from "node:child_process";
import process from "node:process";

const result = spawnSync("pnpm", ["exec", "expo", "export", "--platform", "web"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, EXPO_PUBLIC_API_URL: "http://localhost:3000", EXPO_PUBLIC_PREVIEW: "1" },
});
process.exit(result.status ?? 1);
