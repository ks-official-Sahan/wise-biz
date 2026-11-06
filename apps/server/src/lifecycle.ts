/** What `startAll` needs from the API and the workers. Both are started by their own packages. */
export interface ServerParts {
  startApi(): Promise<{ port: number; close(): Promise<void> }>;
  startWorker(): { stop(): Promise<void> };
}

export interface RunningAll {
  /** The HTTP port the API listens on. */
  port: number;
  /** Stops both. Resolves when both stopped; rejects (after trying both) if either failed. */
  stop(): Promise<void>;
}

/**
 * One process, two roles: the HTTP API and the background workers (outbox relay, email and push delivery, reports,
 * exports, alerts). For a host that runs a single container and sleeps it when idle (ADR 0024). The realtime service
 * is not part of it: terminals fall back to polling for changes (ADR 0015), and a free host exposes one port.
 */
export async function startAll(parts: ServerParts): Promise<RunningAll> {
  const api = await parts.startApi();
  let worker: { stop(): Promise<void> };
  try {
    worker = parts.startWorker();
  } catch (err) {
    // The workers failed to start: do not leave a half-running server behind.
    await api.close().catch(() => undefined);
    throw err;
  }
  return {
    port: api.port,
    async stop() {
      // Workers first: they stop taking new work and finish the batch in flight, then the API drains.
      const results = await Promise.allSettled([worker.stop(), api.close()]);
      const failed = results.filter((r) => r.status === "rejected");
      if (failed.length > 0)
        throw new Error(`server stop failed: ${String(failed.length)} part(s)`);
    },
  };
}
