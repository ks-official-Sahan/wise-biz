import { createServer } from "node:http";

import { verifyTicket } from "@wise-biz/module-sync";

import { Hub } from "./hub.ts";

import type { Stream, Subscriber } from "./hub.ts";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Logger } from "pino";

export interface RealtimeOptions {
  secret: string;
  subscriber: Subscriber;
  logger: Logger;
  maxConnections?: number;
  /** A stream is closed after this long so a revoked terminal cannot listen forever (it reconnects with a new ticket). */
  maxAgeMs?: number;
  heartbeatMs?: number;
  /** Readiness of the Redis subscription connection. */
  ready?: () => boolean;
  now?: () => number;
}

const DEFAULT_MAX_CONNECTIONS = 20_000;
const DEFAULT_MAX_AGE_MS = 5 * 60_000;
/** Streams one terminal may hold open (a reconnect overlaps the old stream for a moment). */
const MAX_STREAMS_PER_DEVICE = 4;
const HEADERS_TIMEOUT_MS = 10_000;
const SOCKET_HEADROOM = 256;
const DEFAULT_HEARTBEAT_MS = 25_000;
const RETRY_MS = 3000;

export interface RealtimeServer {
  server: Server;
  hub: Hub;
  stop: () => Promise<void>;
}

const bearer = (req: IncomingMessage): string | undefined => {
  const h = req.headers.authorization;
  return h?.startsWith("Bearer ") === true ? h.slice(7).trim() : undefined;
};

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

/**
 * `GET /v1/stream` (Server-Sent Events). Auth is a signed ticket minted by the API (Authorization: Bearer), checked
 * with HMAC only: no database, so instances scale out freely. The ticket carries the exact channels the terminal may
 * hear; the stream never accepts a channel from the client.
 */
export function createRealtimeServer(opts: RealtimeOptions): RealtimeServer {
  const hub = new Hub(opts.subscriber);
  const now = opts.now ?? Date.now;
  const max = opts.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  const maxAge = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const ready = opts.ready ?? (() => true);
  const perDevice = new Map<string, number>();

  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (req.method !== "GET") {
      json(res, 405, { error: "method_not_allowed" }, { allow: "GET" });
      return;
    }
    if (path === "/health") {
      json(res, 200, { status: "ok" });
      return;
    }
    if (path === "/ready") {
      const ok = ready();
      json(res, ok ? 200 : 503, { status: ok ? "ok" : "unavailable" });
      return;
    }
    if (path !== "/v1/stream") {
      json(res, 404, { error: "not_found" });
      return;
    }
    const token = bearer(req);
    const claims = token === undefined ? undefined : verifyTicket(opts.secret, token, now());
    if (claims === undefined) {
      json(res, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
      return;
    }
    if (hub.size >= max || !ready() || (perDevice.get(claims.sub) ?? 0) >= MAX_STREAMS_PER_DEVICE) {
      json(res, 503, { error: "unavailable" }, { "retry-after": "5" });
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true);
    const sink = {
      write: (chunk: string) => void res.write(chunk),
      end: () => {
        res.end();
      },
      backlog: () => res.writableLength,
    };
    // Registered before the (async) subscribe: a client that hangs up meanwhile must still release its slot.
    perDevice.set(claims.sub, (perDevice.get(claims.sub) ?? 0) + 1);
    let opened: Stream | undefined;
    let age: NodeJS.Timeout | undefined;
    let gone = false;
    res.on("close", () => {
      gone = true;
      if (age !== undefined) clearTimeout(age);
      opened?.close();
      const n = (perDevice.get(claims.sub) ?? 1) - 1;
      if (n <= 0) perDevice.delete(claims.sub);
      else perDevice.set(claims.sub, n);
    });
    hub.open(claims.tid, claims.ch, sink).then(
      (stream) => {
        opened = stream;
        if (gone) {
          stream.close();
          return;
        }
        age = setTimeout(() => {
          stream.write("event: reconnect\ndata: {}\n\n");
          stream.close();
        }, maxAge);
        age.unref();
        // `ready` says the subscription is live: the terminal pulls once now to close the gap, then lives on hints.
        stream.write(
          `retry: ${String(RETRY_MS)}\nevent: ready\ndata: ${JSON.stringify({ channels: claims.ch })}\n\n`,
        );
      },
      (err: unknown) => {
        opts.logger.error({ err }, "realtime subscribe failed");
        res.end();
      },
    );
  });
  // Streams are long-lived: no request timeout on them.
  server.requestTimeout = 0;
  // Unauthenticated sockets are bounded too: slow headers cannot pin them, and the total has headroom over streams.
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.maxConnections = max + SOCKET_HEADROOM;
  const beat = setInterval(() => {
    hub.heartbeat();
  }, opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
  beat.unref();

  return {
    server,
    hub,
    stop: () =>
      new Promise<void>((resolve) => {
        clearInterval(beat);
        hub.closeAll();
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}
