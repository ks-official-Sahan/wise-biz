import { parseCsv } from "./catalog.ts";

/** Parses a CSV off the main thread: a 20 MB file would otherwise freeze the page for seconds. */
self.onmessage = (e: MessageEvent<string>) => {
  try {
    self.postMessage({ ok: true, rows: parseCsv(e.data) });
  } catch (err) {
    self.postMessage({
      ok: false,
      error: err instanceof Error ? err.message : "Could not read it.",
    });
  }
};
