// @ts-check
// Prints a markdown table of the newest turbo run summary (.turbo/runs/*.json).
// Used as a CI job summary. Always exits 0: a missing summary must not fail CI.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

/**
 * @typedef {{
 *   taskId: string,
 *   cache?: { status?: string, local?: boolean, remote?: boolean },
 *   execution?: { startTime?: number, endTime?: number, exitCode?: number }
 * }} TurboTask
 * @typedef {{ execution?: { startTime?: number, endTime?: number }, tasks?: TurboTask[] }} TurboRun
 */

const runsDir = join(import.meta.dirname, "..", ".turbo", "runs");

/** @returns {string | undefined} */
function newestSummary() {
  let files;
  try {
    files = readdirSync(runsDir).filter((name) => name.endsWith(".json"));
  } catch {
    return undefined;
  }
  let best;
  let bestTime = -1;
  for (const name of files) {
    const path = join(runsDir, name);
    const mtime = statSync(path).mtimeMs;
    if (mtime > bestTime) {
      best = path;
      bestTime = mtime;
    }
  }
  return best;
}

/** @param {string} line */
const out = (line) => process.stdout.write(`${line}\n`);

/** @param {string} value */
// Task ids and cache statuses come from PR-controlled names: keep one line, escape table pipes.
const cell = (value) =>
  String(value)
    .replace(/[\r\n]+/g, " ")
    .replace(/\|/g, "\\|");

/** @param {TurboTask} task */
function cacheStatus(task) {
  if (task.cache?.status) return task.cache.status;
  return task.cache?.local || task.cache?.remote ? "HIT" : "MISS";
}

function main() {
  const path = newestSummary();
  if (!path) {
    out("no turbo summary");
    return;
  }
  /** @type {TurboRun} */
  let run;
  try {
    run = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    out("no turbo summary (unreadable)");
    return;
  }

  const tasks = run.tasks ?? [];
  const rows = tasks.map((task) => {
    const start = task.execution?.startTime ?? 0;
    const end = task.execution?.endTime ?? start;
    return { id: task.taskId, cache: cacheStatus(task), ms: Math.max(0, end - start) };
  });
  const totalMs =
    run.execution?.endTime && run.execution?.startTime
      ? run.execution.endTime - run.execution.startTime
      : rows.reduce((sum, row) => sum + row.ms, 0);

  out("## Turbo timings\n");
  out("| Task | Cache | Duration (ms) |");
  out("| --- | --- | ---: |");
  for (const row of rows) {
    out(`| ${cell(row.id)} | ${cell(row.cache)} | ${row.ms} |`);
  }
  out(`\nTotal: ${totalMs} ms across ${rows.length} tasks.`);
}

main();
