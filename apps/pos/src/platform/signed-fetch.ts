import { signRequest, signRequestWith } from "@wise-biz/http-signatures";
import { TransportError } from "@wise-biz/sync";

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{
  status: number;
  headers: { get: (name: string) => string | null };
  text: () => Promise<string>;
}>;

export interface SignedFetchOptions {
  baseUrl: string;
  deviceId: string;
  /** The device's Ed25519 secret key (raw 32 bytes), read from the platform vault when needed. */
  secretKey?: () => Uint8Array | Promise<Uint8Array>;
  /** Or a signer that keeps the key to itself (a non-extractable key, another process): give this or `secretKey`. */
  sign?: (message: Uint8Array) => Promise<Uint8Array>;
  fetch: FetchLike;
  /** Corrected server time in ms (see ServerClock): the server rejects a signature more than 5 min off. */
  now?: () => number;
}

export interface Reply<T> {
  readonly status: number;
  readonly body: T;
  readonly etag: string | null;
}

export type SignedFetch = <T = unknown>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  options?: { body?: unknown; headers?: Record<string, string>; accept304?: boolean },
) => Promise<Reply<T>>;

const retryAfter = (value: string | null): number | undefined => {
  if (value === null) return undefined;
  const secs = Number(value);
  return Number.isFinite(secs) && secs >= 0 ? Math.min(secs, 3600) * 1000 : undefined;
};

/**
 * Every terminal request is signed (RFC 9421 profile): the signature covers the method, path, body digest, time and a
 * fresh nonce. Failures become `TransportError` with the API's problem `code`, so the sync loops can tell "sign in
 * again" from "retry later" from "stop for the owner".
 */
export function createSignedFetch(opts: SignedFetchOptions): SignedFetch {
  const base = opts.baseUrl.replace(/\/$/, "");
  const now = opts.now ?? Date.now;
  return async <T>(
    method: string,
    path: string,
    options: { body?: unknown; headers?: Record<string, string>; accept304?: boolean } = {},
  ): Promise<Reply<T>> => {
    const cut = path.indexOf("?");
    const pathOnly = cut < 0 ? path : path.slice(0, cut);
    const query = cut < 0 ? "" : path.slice(cut + 1);
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const request = {
      method,
      path: pathOnly,
      query,
      body,
      deviceId: opts.deviceId,
      now: Math.floor(now() / 1000),
    };
    const signature =
      opts.sign !== undefined
        ? await signRequestWith(request, opts.sign)
        : opts.secretKey !== undefined
          ? signRequest({ ...request, secretKey: await opts.secretKey() })
          : undefined;
    if (signature === undefined)
      throw new Error("createSignedFetch needs a secretKey or a sign function");
    const headers: Record<string, string> = {
      ...signature,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers,
    };
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await opts.fetch(`${base}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
      });
    } catch (cause) {
      throw new TransportError("network error", { status: 0, details: cause });
    }
    const text = await res.text();
    const parsed: unknown = text === "" ? undefined : safeJson(text);
    if (res.status === 304 && options.accept304 === true) {
      return { status: 304, body: undefined as T, etag: res.headers.get("etag") };
    }
    if (res.status >= 200 && res.status < 300) {
      return { status: res.status, body: parsed as T, etag: res.headers.get("etag") };
    }
    const problem = (parsed ?? {}) as { code?: unknown; detail?: unknown; details?: unknown };
    const code = typeof problem.code === "string" ? problem.code : undefined;
    const retryAfterMs = retryAfter(res.headers.get("retry-after"));
    throw new TransportError(
      typeof problem.detail === "string" ? problem.detail : `HTTP ${String(res.status)}`,
      {
        status: res.status,
        ...(code === undefined ? {} : { code }),
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        details: problem.details,
      },
    );
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
