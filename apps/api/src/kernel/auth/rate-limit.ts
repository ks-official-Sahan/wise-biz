import { createHash } from "node:crypto";
import { isIP } from "node:net";

import { DomainError, toProblem } from "@wise-biz/errors";

import { problemResponse } from "../../problem.ts";

import { withTimeout } from "./timeout.ts";

import type { KernelRedis } from "./types.ts";
import type { AppEnv } from "@wise-biz/module-kit";
import type { Context, MiddlewareHandler } from "hono";

export const RATE_LIMIT_TIMEOUT_MS = 200;
const MINUTE = 60_000;
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface RateRule {
  /** Bucket name, part of the Redis key. */
  name: string;
  limit: number;
  windowMs: number;
  /** Bucket subject (ip, hashed email, user id); null = rule does not apply to this request. */
  subject(c: Context<AppEnv>): string | null | Promise<string | null>;
}

export interface RateLimitOptions {
  /** Absent = unavailable: the request is refused (fail closed). */
  redis?: Pick<KernelRedis, "hit"> | undefined;
  timeoutMs?: number;
  /** Only requests with this method are limited (default: all). */
  method?: string;
  /** Only unsafe methods (POST/PUT/PATCH/DELETE) are limited. */
  unsafeOnly?: boolean;
}

/**
 * Fixed-window limiter on Redis, FAIL CLOSED: if Redis is absent, errors or does not answer within 200 ms the request
 * is refused with 503 RATE_LIMIT_UNAVAILABLE. Use ONLY on credential/abuse-sensitive writes (sign-in, sign-up,
 * create-business); reads never pass through here. Exceeded -> 429 RATE_LIMITED with Retry-After.
 * Keys are ip/user scoped (there is no tenant yet when these run): `rl:{rule}:{subject}`.
 */
export function rateLimit(
  rules: readonly RateRule[],
  opts: RateLimitOptions = {},
): MiddlewareHandler<AppEnv> {
  const timeoutMs = opts.timeoutMs ?? RATE_LIMIT_TIMEOUT_MS;
  return async (c, next) => {
    if (opts.method !== undefined && c.req.method !== opts.method) return next();
    if (opts.unsafeOnly === true && !UNSAFE_METHODS.has(c.req.method)) return next();
    const buckets: { key: string; rule: RateRule }[] = [];
    for (const rule of rules) {
      const subject = await rule.subject(c);
      if (subject !== null) buckets.push({ key: `rl:${rule.name}:${subject}`, rule });
    }
    if (buckets.length === 0) return next();

    let results: { count: number; ttlMs: number }[];
    try {
      const redis = opts.redis;
      if (redis === undefined) throw new Error("redis not configured");
      results = await Promise.all(
        buckets.map((b) => withTimeout(redis.hit(b.key, b.rule.windowMs), timeoutMs, "rate limit")),
      );
    } catch (err) {
      c.get("logger").warn({ err }, "rate limiter unavailable; failing closed");
      return problemResponse(
        c,
        toProblem(
          new DomainError("RATE_LIMIT_UNAVAILABLE", "Service temporarily unavailable"),
          c.get("requestId"),
        ),
      );
    }
    let retryAfterMs = 0;
    results.forEach((r, i) => {
      const limit = buckets[i]?.rule.limit ?? 0;
      if (r.count > limit) retryAfterMs = Math.max(retryAfterMs, r.ttlMs);
    });
    if (retryAfterMs > 0) {
      c.header("Retry-After", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
      return problemResponse(
        c,
        toProblem(new DomainError("RATE_LIMITED", "Too many requests"), c.get("requestId")),
      );
    }
    return next();
  };
}

/**
 * Client IP. `hops` = TRUST_PROXY_HOPS: 0 (default) uses the socket peer address only and ignores x-forwarded-for
 * entirely. N>0 takes the Nth entry from the RIGHT of x-forwarded-for (each trusted proxy appends the address it saw,
 * so the left side is client-controlled); with fewer than N entries the header is ignored and the peer address is used.
 * "unknown" (no socket info) shares one bucket: stricter, safe.
 */
export function clientIp(c: Context<AppEnv>, hops: number, socketIp?: string): string {
  if (hops > 0) {
    const entries = (c.req.header("x-forwarded-for") ?? "")
      .split(",")
      .map((e) => e.trim())
      .filter((e) => e !== "");
    const picked = entries.length >= hops ? entries[entries.length - hops] : undefined;
    if (picked !== undefined && isIP(picked) !== 0) return picked;
  }
  return socketIp ?? "unknown";
}

/**
 * Rate-limit bucket for an address: IPv4 as is; IPv6 (and ::ffff:a.b.c.d mapped) by its /64, because one host or
 * subscriber routinely owns the whole /64 and could otherwise rotate through 2^64 addresses.
 */
export function ipBucket(ip: string): string {
  const mappedV4 = ip.toLowerCase().startsWith("::ffff:") ? ip.slice(7) : "";
  if (isIP(mappedV4) === 4) return mappedV4;
  if (isIP(ip) !== 6) return ip;
  const [head = "", tail = ""] = ip.toLowerCase().split("::");
  const front = head === "" ? [] : head.split(":");
  const back = tail === "" ? [] : tail.split(":");
  const groups = ip.includes("::")
    ? [...front, ...Array<string>(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back]
    : front;
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}

export const sha256Hex = (v: string): string => createHash("sha256").update(v).digest("hex");

export const emailDigest = (email: string): string => sha256Hex(email.trim().toLowerCase());

/** Email from a JSON body without consuming it (the identity handler reads the original request). */
export async function bodyEmail(c: Context<AppEnv>): Promise<string | null> {
  try {
    const body = (await c.req.raw.clone().json()) as { email?: unknown } | null;
    return typeof body?.email === "string" && body.email !== "" ? body.email : null;
  } catch {
    return null;
  }
}

export const LIMITS = {
  signInPerIp: { limit: 10, windowMs: MINUTE },
  signInPerEmail: { limit: 5, windowMs: MINUTE },
  signUpPerIp: { limit: 5, windowMs: MINUTE },
  createBusinessPerUser: { limit: 5, windowMs: MINUTE },
  /** Invite acceptance per signed-in user (token guessing; fails closed like the others). */
  acceptInvitePerUser: { limit: 10, windowMs: MINUTE },
  /** Every other unsafe /v1/auth/* route (change-password, update-user, revoke-*, sign-out...). */
  authWritePerSession: { limit: 10, windowMs: MINUTE },
} as const;
