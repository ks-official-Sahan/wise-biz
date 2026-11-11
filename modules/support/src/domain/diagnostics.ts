import { scrubMessage } from "./scrub.ts";

/**
 * Diagnostic bundle attached to a ticket. Only these keys survive; everything else the client sent (names, emails,
 * tokens, cookies, environment, free-form context) is dropped. Input is untrusted, so this never throws.
 */

export const MAX_LAST_ERRORS = 10;
const MAX_SCALAR_CHARS = 40;

const VERSION_RE = /^[A-Za-z0-9._+-]{1,40}$/;
const PLATFORM_RE = /^[A-Za-z0-9_-]{1,40}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DiagnosticError {
  readonly message: string;
}

export interface DiagnosticBundle {
  readonly appVersion?: string;
  readonly platform?: string;
  readonly deviceId?: string;
  readonly branchId?: string;
  readonly lastErrors: DiagnosticError[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Returns the value only when it is a string matching the strict charset (so it cannot carry an email or a card). */
const exact = (v: unknown, re: RegExp): string | undefined =>
  typeof v === "string" && re.test(v) && v.length <= MAX_SCALAR_CHARS ? v : undefined;

function lastErrorsOf(v: unknown): DiagnosticError[] {
  if (!Array.isArray(v)) return [];
  const out: DiagnosticError[] = [];
  for (const item of v.slice(0, MAX_LAST_ERRORS)) {
    const raw =
      typeof item === "string"
        ? item
        : isRecord(item) && typeof item.message === "string"
          ? item.message
          : undefined;
    if (raw === undefined) continue;
    const message = scrubMessage(raw);
    if (message.trim() !== "") out.push({ message });
  }
  return out;
}

export function sanitizeDiagnostics(raw: unknown): DiagnosticBundle {
  if (!isRecord(raw)) return { lastErrors: [] };
  const appVersion = exact(raw.appVersion, VERSION_RE);
  const platform = exact(raw.platform, PLATFORM_RE);
  const deviceId = exact(raw.deviceId, UUID_RE);
  const branchId = exact(raw.branchId, UUID_RE);
  return {
    ...(appVersion !== undefined && { appVersion }),
    ...(platform !== undefined && { platform }),
    ...(deviceId !== undefined && { deviceId }),
    ...(branchId !== undefined && { branchId }),
    lastErrors: lastErrorsOf(raw.lastErrors),
  };
}
