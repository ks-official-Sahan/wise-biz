import { z } from "zod";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuid = z.string().regex(UUID_RE, "UUID");
const ticketStatus = z.enum(["open", "pending", "solved", "closed"]);
const priority = z.enum(["low", "normal", "high", "urgent"]);
const messageBody = z.string().trim().min(1).max(8000);
/** Client diagnostics are capped in size before the domain whitelists them. */
const diagnostics = z
  .record(z.string().max(64), z.unknown())
  .refine((v) => JSON.stringify(v).length <= 16_384, "diagnostics are too large");

export const IdParam = z.object({ id: uuid });

export const CreateTicketSchema = z
  .object({
    subject: z.string().trim().min(1).max(200),
    priority: priority.default("normal"),
    branchId: uuid.optional(),
    /** The first message: what the tenant needs help with. */
    body: messageBody,
    diagnostics: diagnostics.optional(),
  })
  .meta({ id: "SupportCreateTicket" });

/** `internal` is not in this schema: zod strips it, so a tenant can never post a platform-only note. */
export const AddMessageSchema = z.object({ body: messageBody }).meta({ id: "SupportAddMessage" });

export const ChangeStatusSchema = z
  .object({ status: ticketStatus })
  .meta({ id: "SupportChangeStatus" });

export const TicketListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  after: z.string().max(200).optional(),
  status: ticketStatus.optional(),
});

export const TicketSummarySchema = z
  .object({
    id: z.string(),
    subject: z.string(),
    status: ticketStatus,
    priority,
    branchId: z.string().nullable(),
    planCode: z.string(),
    slaFirstResponseDueAt: z.string(),
    slaResolutionDueAt: z.string(),
    firstRespondedAt: z.string().nullable(),
    solvedAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: "SupportTicket" });

export const MessageSchema = z
  .object({
    id: z.string(),
    authorKind: z.enum(["tenant", "platform"]),
    authorId: z.string(),
    body: z.string(),
    internal: z.boolean(),
    createdAt: z.string(),
  })
  .meta({ id: "SupportMessage" });

export const TicketDetailSchema = TicketSummarySchema.extend({
  diagnostics: z.object({
    appVersion: z.string().optional(),
    platform: z.string().optional(),
    deviceId: z.string().optional(),
    branchId: z.string().optional(),
    lastErrors: z.array(z.object({ message: z.string() })),
  }),
  messages: z.array(MessageSchema),
  /** True when the thread has more than the returned messages (see MESSAGE_DETAIL_LIMIT). */
  messagesTruncated: z.boolean(),
}).meta({ id: "SupportTicketDetail" });

export const TicketPageSchema = z
  .object({
    items: z.array(TicketSummarySchema),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: "SupportTicketPage" });
