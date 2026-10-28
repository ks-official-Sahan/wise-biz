import { z } from "@hono/zod-openapi";

import { DEVICE_STATUSES, PLATFORMS } from "./domain/device.ts";

const uuid7 = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "UUIDv7");
const name = z.string().trim().min(1).max(80);

export const CreateEnrollmentCodeSchema = z
  .object({ branchId: uuid7, name })
  .strict()
  .openapi("CreateEnrollmentCode");

export const EnrollmentCodeSchema = z
  .object({
    code: z
      .string()
      .openapi({ description: "Shown once. Type it on the terminal or scan the QR payload." }),
    qr: z.string(),
    expiresAt: z.string(),
    branchId: z.string(),
    name: z.string(),
  })
  .openapi("EnrollmentCode");

export const EnrollSchema = z
  .object({
    code: z.string().min(8).max(16),
    deviceId: uuid7,
    /** Raw 32-byte Ed25519 public key, base64url. */
    publicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    platform: z.enum(PLATFORMS),
    appVersion: z.string().min(1).max(32),
  })
  .strict()
  .openapi("Enroll");

export const DeviceSchema = z
  .object({
    deviceId: z.string(),
    tenantId: z.string(),
    branchId: z.string(),
    name: z.string(),
    platform: z.enum(PLATFORMS),
    appVersion: z.string(),
    status: z.enum(DEVICE_STATUSES),
    enrolledAt: z.string(),
    lastSeenAt: z.string().nullable(),
  })
  .openapi("Device");

export const DeviceListSchema = z.object({ devices: z.array(DeviceSchema) }).openapi("DeviceList");

export const UpdateDeviceSchema = z
  .object({
    status: z.enum(["active", "suspended", "revoked", "blacklisted"]).optional(),
    name: name.optional(),
    branchId: uuid7.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "nothing to change")
  .openapi("UpdateDevice");

export const HeartbeatSchema = z
  .object({
    appVersion: z.string().min(1).max(32),
    batteryPct: z.number().int().min(0).max(100).nullable().optional(),
    unsyncedCount: z.number().int().min(0).max(1_000_000),
    oldestUnsyncedAt: z.iso.datetime({ offset: true }).nullable().optional(),
    operatorId: uuid7.nullable().optional(),
    connection: z.enum(["wifi", "ethernet", "cellular", "offline", "unknown"]).optional(),
  })
  .strict()
  .openapi("Heartbeat");

export const HeartbeatReplySchema = z
  .object({ status: z.enum(DEVICE_STATUSES), serverTime: z.string() })
  .openapi("HeartbeatReply");

export type DeviceDto = z.infer<typeof DeviceSchema>;
export type EnrollInput = z.infer<typeof EnrollSchema>;
export type HeartbeatInput = z.infer<typeof HeartbeatSchema>;
export type UpdateDeviceInput = z.infer<typeof UpdateDeviceSchema>;
