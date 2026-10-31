/**
 * The server rejects a signature more than 5 minutes from its own clock, and POS tablets drift. Each heartbeat reply
 * carries the server time; the offset is kept here and applied to every signature and every command timestamp.
 */
export function createServerClock(now: () => number = Date.now) {
  let offsetMs = 0;
  return {
    now: (): number => now() + offsetMs,
    /** Learns the offset from a server time (ISO string) received just now. */
    observe(serverTime: string, receivedAtMs: number = now()): void {
      const t = Date.parse(serverTime);
      if (Number.isFinite(t)) offsetMs = t - receivedAtMs;
    },
    offsetMs: (): number => offsetMs,
  };
}

export type ServerClock = ReturnType<typeof createServerClock>;
