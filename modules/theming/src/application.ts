import { DomainError } from "@wise-biz/errors";
import { PLATFORM_THEME, resolveTheme, validateTheme } from "@wise-biz/theme";

import { ReceiptTemplateChangedV1, THEMING_TOPIC, ThemePublishedV1 } from "./events.ts";

import type { SaveReceiptTemplateSchema } from "./schemas.ts";
import type { TxHandle, OutboxEvent } from "@wise-biz/db";
import type { CommandContext, CommandResult } from "@wise-biz/module-kit";
import type { ThemeInput } from "@wise-biz/theme";
import type { z } from "zod";

interface ThemeRow {
  id: string;
  version: number | null;
  status: "draft" | "published" | "archived";
  name: string;
  input: ThemeInput;
  created_at: Date;
  published_at: Date | null;
}
const COLUMNS = "id, version, status, name, input, created_at, published_at";

export const toTheme = (r: ThemeRow) => ({
  id: r.id,
  version: r.version,
  status: r.status,
  name: r.name,
  input: r.input,
  createdAt: r.created_at.toISOString(),
  publishedAt: r.published_at === null ? null : r.published_at.toISOString(),
});

const notFound = (): never => {
  throw new DomainError("NOT_FOUND", "Not found");
};
const one = <T>(rows: readonly T[]): T => {
  const row = rows[0];
  /* v8 ignore next */
  if (row === undefined) throw new Error("internal: expected one row");
  return row;
};

function themingEvent(
  def: { type: string; version: number; parse(v: unknown): { id: string } },
  ctx: CommandContext,
  subject: string,
  data: unknown,
): OutboxEvent {
  const e = def.parse({
    id: ctx.ids.uuidv7(),
    type: def.type,
    version: def.version,
    source: "api/theming",
    tenantId: ctx.tenant.tenantId,
    subject,
    time: ctx.now.toISOString(),
    correlationId: ctx.requestId,
    actor: { type: "user", id: ctx.userId },
    data,
  });
  return {
    id: e.id,
    topic: THEMING_TOPIC,
    key: ctx.tenant.tenantId,
    type: def.type,
    version: def.version,
    payload: e,
  };
}

/** The platform theme layered under the tenant's: the same call the devices make, so the check matches what ships. */
export function contrastIssues(input: ThemeInput) {
  return validateTheme(resolveTheme({ platform: PLATFORM_THEME, tenant: input }));
}

export async function loadTheme(tx: TxHandle, tenantId: string) {
  const r = await tx.query<ThemeRow>(
    `select ${COLUMNS} from theming.themes
      where tenant_id = $1 and status in ('draft', 'published')`,
    [tenantId],
  );
  const find = (s: string) => r.rows.find((x) => x.status === s);
  const published = find("published");
  const draft = find("draft");
  return {
    published: published === undefined ? null : toTheme(published),
    draft: draft === undefined ? null : toTheme(draft),
  };
}

export async function listVersions(tx: TxHandle, tenantId: string) {
  const r = await tx.query<ThemeRow>(
    `select ${COLUMNS} from theming.themes
      where tenant_id = $1 and status <> 'draft'
      order by version desc limit 50`,
    [tenantId],
  );
  return { versions: r.rows.map(toTheme) };
}

/** Save (create or replace) the single draft. A draft may fail contrast: only publishing is blocked. */
export async function saveDraftCommand(
  tx: TxHandle,
  ctx: CommandContext,
  body: { input: ThemeInput },
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  const before = await tx.query<ThemeRow>(
    `select ${COLUMNS} from theming.themes where tenant_id = $1 and status = 'draft' for update`,
    [tenantId],
  );
  const input = JSON.stringify(body.input);
  const r =
    before.rows.length === 0
      ? await tx.query<ThemeRow>(
          `insert into theming.themes (id, tenant_id, status, name, input, created_by)
           values ($1, $2, 'draft', $3, $4::jsonb, $5) returning ${COLUMNS}`,
          [ctx.ids.uuidv7(), tenantId, body.input.name, input, ctx.userId],
        )
      : await tx.query<ThemeRow>(
          `update theming.themes set name = $3, input = $4::jsonb
            where tenant_id = $1 and id = $2 returning ${COLUMNS}`,
          [tenantId, one(before.rows).id, body.input.name, input],
        );
  const after = toTheme(one(r.rows));
  return {
    status: 200,
    // A draft is work in progress: nothing downstream may see it until it is published.
    noEvents: true,
    body: after,
    audit: [
      {
        action: "theming.theme.draft_saved",
        entity: "theming.theme",
        entityId: after.id,
        ...(before.rows[0] === undefined ? {} : { before: toTheme(before.rows[0]) }),
        after,
      },
    ],
  };
}

/** Publish the draft: blocked while any colour pair fails contrast. Archives the previous version, emits the event. */
export async function publishCommand(tx: TxHandle, ctx: CommandContext): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  const d = await tx.query<ThemeRow>(
    `select ${COLUMNS} from theming.themes where tenant_id = $1 and status = 'draft' for update`,
    [tenantId],
  );
  const draft = d.rows[0] ?? notFound();
  const issues = contrastIssues(draft.input);
  if (issues.length > 0) {
    throw new DomainError("VALIDATION_FAILED", "The theme fails the contrast checks.", {
      fieldErrors: issues.map((i) => ({
        path: `${i.mode}.${i.fg}`,
        message: `${i.fg} on ${i.bg} is ${i.ratio.toFixed(2)}:1, needs ${String(i.required)}:1.`,
      })),
    });
  }
  const prev = await tx.query<{ id: string }>(
    `update theming.themes set status = 'archived'
      where tenant_id = $1 and status = 'published' returning id`,
    [tenantId],
  );
  const next = await tx.query<{ v: number }>(
    `select coalesce(max(version), 0) + 1 as v from theming.themes where tenant_id = $1`,
    [tenantId],
  );
  const r = await tx.query<ThemeRow>(
    `update theming.themes set status = 'published', version = $3, published_at = $4
      where tenant_id = $1 and id = $2 returning ${COLUMNS}`,
    [tenantId, draft.id, one(next.rows).v, ctx.now],
  );
  const after = toTheme(one(r.rows));
  return {
    status: 200,
    body: after,
    audit: [
      {
        action: "theming.theme.published",
        entity: "theming.theme",
        entityId: after.id,
        ...(prev.rows[0] === undefined ? {} : { before: { archivedId: prev.rows[0].id } }),
        after: { id: after.id, version: after.version, name: after.name },
      },
    ],
    events: [
      themingEvent(ThemePublishedV1, ctx, `theme/${after.id}`, {
        themeId: after.id,
        version: after.version,
        name: after.name,
        input: after.input,
      }),
    ],
  };
}

/** Rollback is a draft: copy an older version's design into the draft, then publish it like any other change. */
export async function restoreCommand(
  tx: TxHandle,
  ctx: CommandContext,
  body: { version: number },
): Promise<CommandResult> {
  const src = await tx.query<ThemeRow>(
    `select ${COLUMNS} from theming.themes where tenant_id = $1 and version = $2`,
    [ctx.tenant.tenantId, body.version],
  );
  const from = src.rows[0] ?? notFound();
  return saveDraftCommand(tx, ctx, { input: from.input });
}

// --- Receipt templates ---

interface TemplateRow {
  id: string;
  branch_id: string | null;
  version: number;
  paper: "58" | "80";
  invoice_prefix: string;
  footer_text: string;
  blocks: z.infer<typeof SaveReceiptTemplateSchema>["blocks"];
  updated_at: Date;
}
const TCOLUMNS = "id, branch_id, version, paper, invoice_prefix, footer_text, blocks, updated_at";
const toTemplate = (r: TemplateRow) => ({
  id: r.id,
  branchId: r.branch_id,
  version: r.version,
  paper: r.paper,
  invoicePrefix: r.invoice_prefix,
  footerText: r.footer_text,
  blocks: r.blocks,
  updatedAt: r.updated_at.toISOString(),
});

export async function loadTemplates(tx: TxHandle, tenantId: string, branchId?: string) {
  const r = await tx.query<TemplateRow>(
    `select ${TCOLUMNS} from theming.receipt_templates
      where tenant_id = $1 and (branch_id is null or branch_id = $2::uuid)
      order by branch_id nulls first`,
    [tenantId, branchId ?? null],
  );
  return { templates: r.rows.map(toTemplate) };
}

/** Create or replace the template of one scope (the business default, or one branch), with an optimistic version. */
export async function saveTemplateCommand(
  tx: TxHandle,
  ctx: CommandContext,
  body: z.infer<typeof SaveReceiptTemplateSchema>,
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  const branchId = body.branchId ?? null;
  const cur = await tx.query<TemplateRow>(
    `select ${TCOLUMNS} from theming.receipt_templates
      where tenant_id = $1 and branch_id is not distinct from $2::uuid for update`,
    [tenantId, branchId],
  );
  const existing = cur.rows[0];
  if (existing !== undefined && body.version !== undefined && body.version !== existing.version)
    throw new DomainError("CONFLICT", "Someone else changed this receipt. Reload and try again.");
  const blocks = JSON.stringify(body.blocks);
  const r =
    existing === undefined
      ? await tx.query<TemplateRow>(
          `insert into theming.receipt_templates
             (id, tenant_id, branch_id, paper, invoice_prefix, footer_text, blocks, updated_by, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9) returning ${TCOLUMNS}`,
          [
            ctx.ids.uuidv7(),
            tenantId,
            branchId,
            body.paper,
            body.invoicePrefix,
            body.footerText,
            blocks,
            ctx.userId,
            ctx.now,
          ],
        )
      : await tx.query<TemplateRow>(
          `update theming.receipt_templates
              set version = version + 1, paper = $3, invoice_prefix = $4, footer_text = $5,
                  blocks = $6::jsonb, updated_by = $7, updated_at = $8
            where tenant_id = $1 and id = $2 returning ${TCOLUMNS}`,
          [
            tenantId,
            existing.id,
            body.paper,
            body.invoicePrefix,
            body.footerText,
            blocks,
            ctx.userId,
            ctx.now,
          ],
        );
  const after = toTemplate(one(r.rows));
  return {
    status: 200,
    body: after,
    audit: [
      {
        action: "theming.receipt_template.saved",
        entity: "theming.receipt_template",
        entityId: after.id,
        ...(existing === undefined ? {} : { before: toTemplate(existing) }),
        after,
      },
    ],
    events: [
      themingEvent(ReceiptTemplateChangedV1, ctx, `receipt-template/${after.id}`, {
        templateId: after.id,
        branchId: after.branchId,
        version: after.version,
      }),
    ],
  };
}
