/**
 * The edge in front of the API: routes by path, drops forwarded-for headers the client could have forged, applies a
 * coarse limit and a body cap before a request reaches the origin, and resolves short links from KV. It holds no state
 * and no business rules: authentication, signatures, tenancy and the real rate limits stay in the API.
 */

export interface KvLike {
  get(key: string): Promise<string | null>;
}

export interface RateLimiterLike {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface EdgeEnv {
  /** The API's public https origin. */
  API_ORIGIN: string;
  SHORTLINKS?: KvLike | undefined;
  RATE_LIMITER?: RateLimiterLike | undefined;
}

/** Larger bodies are refused before they are streamed to the origin (imports upload to object storage, not here). */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SHORT_CODE = /^[0-9A-Za-z_-]{3,32}$/;
/** The business a short link belongs to (ADR 0020): a UUID in the path, the same value the API uses as tenant id. */
const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Headers that say where a request came from: the edge sets them itself and never forwards the client's. */
const FORGEABLE = [
  "x-forwarded-for",
  "x-real-ip",
  "x-forwarded-host",
  "x-forwarded-proto",
  "forwarded",
];

type Fetcher = (request: Request) => Promise<Response>;

function problem(
  status: number,
  code: string,
  title: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ type: "about:blank", title, status, code }), {
    status,
    headers: {
      "content-type": "application/problem+json",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** `/s/:tenant/:code`. The KV key carries the business, so two businesses can use the same code (ADR 0020). */
async function shortlink(rest: string, env: EdgeEnv): Promise<Response> {
  const [tenant = "", code = "", extra] = rest.split("/");
  const valid = extra === undefined && TENANT_ID.test(tenant) && SHORT_CODE.test(code);
  const target = valid ? await env.SHORTLINKS?.get(`s:${tenant}:${code}`) : null;
  // A target that is not https (or not a URL) is never followed: the KV is a data store, not a trusted redirect list.
  if (target === null || target === undefined || !isHttpsUrl(target))
    return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  return new Response(null, {
    status: 302,
    headers: {
      location: target,
      "cache-control": "public, max-age=300",
      "referrer-policy": "no-referrer",
    },
  });
}

/** Passes the body through and errors the stream once it is longer than `max`, so a chunked upload has no way round the cap. */
function capBody(body: ReadableStream<Uint8Array>, max: number, onExceed: () => void) {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > max) {
          onExceed();
          controller.error(new Error("body too large"));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

async function toOrigin(
  request: Request,
  url: URL,
  env: EdgeEnv,
  fetcher: Fetcher,
  exceeded: { value: boolean },
): Promise<Response> {
  const origin = new URL(env.API_ORIGIN);
  const upstream = new URL(url.pathname + url.search, origin);
  const headers = new Headers(request.headers);
  for (const name of FORGEABLE) headers.delete(name);
  const ip = request.headers.get("cf-connecting-ip");
  if (ip !== null) headers.set("x-forwarded-for", ip);
  headers.set("x-forwarded-host", url.host);
  headers.set("x-forwarded-proto", "https");
  headers.delete("host");
  // `duplex` is required by Node (tests) when streaming a body; the Workers runtime ignores it.
  const init: RequestInit & { duplex: "half" } = {
    method: request.method,
    headers,
    redirect: "manual",
    duplex: "half",
  };
  if (request.method !== "GET" && request.method !== "HEAD" && request.body !== null)
    init.body = capBody(request.body, MAX_BODY_BYTES, () => {
      exceeded.value = true;
    });
  return fetcher(new Request(upstream, init));
}

/** Builds the fetch handler. `fetcher` is injected so tests need no network. */
export function createEdge(fetcher: Fetcher = (r) => fetch(r)) {
  return async (request: Request, env: EdgeEnv): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/edge/health")
      return new Response("ok", { headers: { "cache-control": "no-store" } });

    if (path.startsWith("/s/")) {
      if (request.method !== "GET" && request.method !== "HEAD")
        return problem(405, "METHOD_NOT_ALLOWED", "Method not allowed", { allow: "GET, HEAD" });
      return shortlink(path.slice(3), env);
    }

    const toApi = path === "/v1" || path.startsWith("/v1/");
    if (!toApi && !path.startsWith("/r/")) return problem(404, "NOT_FOUND", "Not found");

    // Every forwarded unsafe request (the /v1 API and the /r routes) passes the same two guards.
    if (UNSAFE.has(request.method)) {
      // A declared length is refused up front; a body with none (chunked) is counted as it streams, in toOrigin.
      const declared = request.headers.get("content-length");
      if (declared !== null) {
        const length = Number(declared);
        if (!Number.isSafeInteger(length) || length < 0)
          return problem(400, "BAD_REQUEST", "Invalid Content-Length");
        if (length > MAX_BODY_BYTES)
          return problem(413, "PAYLOAD_TOO_LARGE", "Request body too large");
      }
      const ip = request.headers.get("cf-connecting-ip");
      if (env.RATE_LIMITER !== undefined && ip !== null) {
        const verdict = await env.RATE_LIMITER.limit({ key: ip });
        if (!verdict.success)
          return problem(429, "RATE_LIMITED", "Too many requests", { "retry-after": "60" });
      }
    }

    const exceeded = { value: false };
    try {
      return await toOrigin(request, url, env, fetcher, exceeded);
    } catch {
      if (exceeded.value) return problem(413, "PAYLOAD_TOO_LARGE", "Request body too large");
      return problem(502, "ORIGIN_UNAVAILABLE", "The service is temporarily unavailable", {
        "retry-after": "5",
      });
    }
  };
}
