import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { routePath } from "hono/route";

import type { AppEnv } from "@wise-biz/module-kit";
import type { MiddlewareHandler } from "hono";

const tracer = trace.getTracer("@wise-biz/api");

/** One server span per request. Resolves to the no-op tracer when no SDK is registered. */
export function tracing(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await tracer.startActiveSpan(
      c.req.method,
      { kind: SpanKind.SERVER, attributes: { "http.request.method": c.req.method } },
      async (span) => {
        try {
          await next();
          // Hono catches handler errors itself; they surface on c.error, not as a throw.
          if (c.error) span.recordException(c.error);
        } catch (err) {
          span.recordException(err instanceof Error ? err : new Error(String(err)));
          throw err;
        } finally {
          const route = routePath(c, -1);
          const status = c.res.status;
          span.updateName(`${c.req.method} ${route}`);
          span.setAttributes({
            "http.route": route,
            "http.response.status_code": status,
            "wb.request_id": c.get("requestId"),
          });
          const tenant = c.get("tenant");
          if (tenant) span.setAttribute("wb.tenant_id", tenant.tenantId);
          if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
          span.end();
        }
      },
    );
  };
}
