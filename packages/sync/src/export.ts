import { gcm } from "@noble/ciphers/aes.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { fromUtf8, utf8 } from "@wise-biz/crypto";

import { fromBase64, toBase64 } from "./chain.ts";

import type { WireCommand } from "./chain.ts";
import type { Outbox } from "./outbox.ts";

/**
 * An encrypted file of the commands that have not reached the server, for manual upload when a device cannot sync
 * (broken network for days, a device being retired). The commands are already signed and chained, so tampering is
 * detectable on the server; the encryption is for confidentiality (receipts hold customer data).
 *
 * Key: HKDF-SHA256(tenant key material, salt = fresh 16 random bytes, info = "wise-biz/outbox-export/v1"). The
 * material is a per-tenant secret the console shows to the owner (>= 32 random bytes); a stolen file without it is
 * opaque. AES-256-GCM, 12-byte random nonce, header authenticated as AAD.
 */
export const EXPORT_VERSION = 1;
const INFO = utf8("wise-biz/outbox-export/v1");
const MIN_MATERIAL = 32;

export interface ExportFile {
  readonly v: 1;
  readonly deviceId: string;
  readonly exportedAt: number;
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly count: number;
  readonly salt: string;
  readonly nonce: string;
  readonly ct: string;
}

export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportError";
  }
}

const header = (f: Omit<ExportFile, "salt" | "nonce" | "ct">) =>
  utf8(JSON.stringify([f.v, f.deviceId, f.exportedAt, f.fromSeq, f.toSeq, f.count]));
const deriveKey = (material: Uint8Array, salt: Uint8Array) =>
  hkdf(sha256, material, salt, INFO, 32);

export interface ExportDeps {
  outbox: Outbox;
  deviceId: string;
  /** Tenant key material, at least 32 bytes. */
  material: Uint8Array;
  now?: () => number;
}

/** Every pending command, oldest first, encrypted. Returns undefined when there is nothing to export. */
export async function exportOutbox(deps: ExportDeps): Promise<ExportFile | undefined> {
  if (deps.material.length < MIN_MATERIAL) throw new ExportError("key material is too short");
  const all = await deps.outbox.allPending();
  const first = all[0];
  if (first === undefined) return undefined;
  const last = all[all.length - 1] ?? first;
  return seal(
    deps,
    all.map((c) => c.command),
    first.seq,
    last.seq,
  );
}

function seal(
  deps: ExportDeps,
  commands: readonly WireCommand[],
  fromSeq: number,
  toSeq: number,
): ExportFile {
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const meta = {
    v: EXPORT_VERSION,
    deviceId: deps.deviceId,
    exportedAt: (deps.now ?? Date.now)(),
    fromSeq,
    toSeq,
    count: commands.length,
  } as const;
  const plain = utf8(commands.map((c) => JSON.stringify(c)).join("\n"));
  const ct = gcm(deriveKey(deps.material, salt), nonce, header(meta)).encrypt(plain);
  return { ...meta, salt: toBase64(salt), nonce: toBase64(nonce), ct: toBase64(ct) };
}

/** Decrypts an export (support tooling, tests). Throws ExportError for a wrong key or a modified file. */
export function openExport(file: ExportFile, material: Uint8Array): WireCommand[] {
  if ((file.v as number) !== EXPORT_VERSION) throw new ExportError("unknown export version");
  try {
    const plain = gcm(
      deriveKey(material, fromBase64(file.salt)),
      fromBase64(file.nonce),
      header(file),
    ).decrypt(fromBase64(file.ct));
    const text = fromUtf8(plain);
    const commands = text.split("\n").map((l) => JSON.parse(l) as WireCommand);
    if (commands.length !== file.count) throw new Error("count");
    return commands;
  } catch {
    throw new ExportError("the file cannot be decrypted: wrong key or modified");
  }
}
