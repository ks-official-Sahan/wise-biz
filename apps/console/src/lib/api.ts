import { uuidv7 } from "@wise-biz/ids";

/** RFC 9457 problem body as the API sends it (packages/errors toProblem). */
export interface Problem {
  readonly type?: string;
  readonly title?: string;
  readonly status: number;
  readonly code?: string;
  readonly detail?: string;
  readonly errors?: readonly { path: string; message: string }[];
}

export class ApiError extends Error {
  readonly status: number;
  readonly problem: Problem;
  constructor(problem: Problem) {
    super(problem.detail ?? problem.title ?? `HTTP ${String(problem.status)}`);
    this.name = "ApiError";
    this.status = problem.status;
    this.problem = problem;
  }

  /** First message for a form field path (422 VALIDATION_FAILED). */
  fieldError(path: string): string | undefined {
    return this.problem.errors?.find((e) => e.path === path)?.message;
  }
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RequestOptions {
  readonly body?: unknown;
  readonly signal?: AbortSignal | undefined;
  /** Mutations: reuse the same key on retry so the API replays instead of applying twice. */
  readonly idempotencyKey?: string | undefined;
}

/**
 * Same-origin JSON client for /v1 (proxied to the API, so the session cookie is first-party and CSP connect-src is
 * 'self'). Every mutation carries an Idempotency-Key (generated when the caller does not pass one).
 */
export async function api<T>(
  method: Method,
  path: `/v1/${string}`,
  opts: RequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET") headers["idempotency-key"] = opts.idempotencyKey ?? uuidv7();
  const res = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  });
  if (res.status === 204) return undefined as T;
  const type = res.headers.get("content-type") ?? "";
  const data: unknown = type.includes("json") ? await res.json() : await res.text();
  if (!res.ok) {
    const problem =
      typeof data === "object" && data !== null
        ? ({ status: res.status, ...data } as Problem)
        : { status: res.status, detail: String(data) };
    throw new ApiError(problem);
  }
  return data as T;
}

export const isNotFound = (err: unknown): boolean => err instanceof ApiError && err.status === 404;
export const isUnauthenticated = (err: unknown): boolean =>
  err instanceof ApiError && err.status === 401;
