import { parseCsv } from "./csv.ts";

/** Below this the parse takes a few milliseconds, so a worker's start-up costs more than it saves. */
const INLINE_BELOW_CHARS = 256 * 1024;

type Reply = { ok: true; rows: string[][] } | { ok: false; error: string };

const aborted = (): DOMException => new DOMException("Aborted", "AbortError");

/**
 * Parses CSV text; a large file goes to a worker so the page stays responsive. Falls back to inline parsing when there
 * is no Worker or the worker cannot start (a blocked or failed script load must not turn a valid file into an error).
 */
export function parseCsvAsync(text: string, signal?: AbortSignal): Promise<string[][]> {
  if (signal?.aborted === true) return Promise.reject(aborted());
  if (text.length < INLINE_BELOW_CHARS || typeof Worker === "undefined") {
    return Promise.resolve().then(() => parseCsv(text));
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./csv.worker.ts", import.meta.url), { type: "module" });
    const done = (): void => {
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
    };
    const onAbort = (): void => {
      done();
      reject(aborted());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.onmessage = (e: MessageEvent<Reply>) => {
      done();
      if (e.data.ok) resolve(e.data.rows);
      else reject(new Error(e.data.error));
    };
    worker.onerror = (e) => {
      e.preventDefault();
      done();
      try {
        resolve(parseCsv(text));
      } catch (err) {
        reject(err instanceof Error ? err : new Error("That file could not be read."));
      }
    };
    worker.postMessage(text);
  });
}
