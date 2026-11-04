/**
 * One place errors leave the app. Only the error's name and message are kept (never the object: it can carry request
 * bodies, keys or customer data), and ids are masked. A crash reporter (Sentry) hooks in here in P1-15.
 */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export function scrub(err: unknown): string {
  const name = err instanceof Error ? err.name : "NonError";
  const message = err instanceof Error ? err.message : String(err);
  return `${name}: ${message.replace(UUID, "<id>").slice(0, 300)}`;
}

let sink: (line: string) => void = () => undefined;

/** Install the reporter (tests, Sentry). Default is silent. */
export function setReportSink(next: (line: string) => void): void {
  sink = next;
}

export function reportError(err: unknown): void {
  sink(scrub(err));
}
