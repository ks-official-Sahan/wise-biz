import { parseCsv } from "./catalog.ts";

/** Below this the parse takes a few milliseconds, so a worker's start-up costs more than it saves. */
const INLINE_BELOW_CHARS = 256 * 1024;

type Reply = { ok: true; rows: string[][] } | { ok: false; error: string };

/** Parses CSV text; a large file goes to a worker so the page stays responsive. Falls back to inline without Worker. */
export function parseCsvAsync(text: string, signal?: AbortSignal): Promise<string[][]> {
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
      reject(new DOMException("Aborted", "AbortError"));
    };
    if (signal?.aborted === true) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.onmessage = (e: MessageEvent<Reply>) => {
      done();
      if (e.data.ok) resolve(e.data.rows);
      else reject(new Error(e.data.error));
    };
    worker.onerror = () => {
      done();
      reject(new Error("That file could not be read."));
    };
    worker.postMessage(text);
  });
}
