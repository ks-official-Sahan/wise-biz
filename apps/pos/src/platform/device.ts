import { generateKeyPair, publicKeyFrom, sign, toBase64url } from "@wise-biz/crypto";
import { uuidv7 } from "@wise-biz/ids";
import { fromBase64, toBase64 } from "@wise-biz/sync";

import { createSignedFetch } from "./signed-fetch.ts";

import type { FetchLike, SignedFetch } from "./signed-fetch.ts";
import type { KeyStore } from "@wise-biz/sync";

/** What a terminal keeps in secure storage after enrolling. The secret never goes anywhere else. */
export interface DeviceIdentity {
  readonly deviceId: string;
  readonly tenantId: string;
  readonly branchId: string;
  /** Raw 32-byte Ed25519 secret, base64. */
  readonly secretKey: string;
}

/**
 * Secure storage for the identity: Keychain / Android Keystore via expo-secure-store on devices, a non-extractable
 * key in IndexedDB on web (low trust: such terminals are flagged), safeStorage on Electron.
 */
export interface DeviceVault {
  load: () => Promise<DeviceIdentity | undefined>;
  save: (identity: DeviceIdentity) => Promise<void>;
  clear: () => Promise<void>;
}

export type Platform = "android" | "ios" | "web" | "windows" | "macos" | "linux";

export interface EnrollOptions {
  baseUrl: string;
  /** The one-time code typed or scanned from the owner's console. */
  code: string;
  platform: Platform;
  appVersion: string;
  vault: DeviceVault;
  fetch: FetchLike;
  now?: () => number;
}

export interface EnrolledDevice {
  readonly deviceId: string;
  readonly tenantId: string;
  readonly branchId: string;
  readonly name: string;
  readonly status: string;
}

/**
 * Generates the device key, proves possession by signing the enrollment request with it, and keeps the identity in
 * the vault only after the server accepted it (a failed enrollment leaves nothing behind).
 */
export async function enrollDevice(opts: EnrollOptions): Promise<EnrolledDevice> {
  const keys = generateKeyPair();
  const deviceId = uuidv7();
  const signed = createSignedFetch({
    baseUrl: opts.baseUrl,
    deviceId,
    secretKey: () => keys.secretKey,
    fetch: opts.fetch,
    ...(opts.now ? { now: opts.now } : {}),
  });
  const { body } = await signed<EnrolledDevice>("POST", "/v1/devices/enroll", {
    body: {
      code: opts.code,
      deviceId,
      publicKey: toBase64url(keys.publicKey),
      platform: opts.platform,
      appVersion: opts.appVersion,
    },
  });
  await opts.vault.save({
    deviceId,
    tenantId: body.tenantId,
    branchId: body.branchId,
    secretKey: toBase64(keys.secretKey),
  });
  return body;
}

/** The `KeyStore` the sync package signs commands with, backed by the vault identity. */
export function createKeyStore(identity: DeviceIdentity): KeyStore {
  const secret = fromBase64(identity.secretKey);
  const pub = publicKeyFrom(secret);
  return {
    publicKey: () => Promise.resolve(pub),
    sign: (message) => Promise.resolve(sign(message, secret)),
  };
}

export function signedFetchFor(
  identity: DeviceIdentity,
  baseUrl: string,
  fetchFn: FetchLike,
  now?: () => number,
): SignedFetch {
  const secret = fromBase64(identity.secretKey);
  return createSignedFetch({
    baseUrl,
    deviceId: identity.deviceId,
    secretKey: () => secret,
    fetch: fetchFn,
    ...(now ? { now } : {}),
  });
}
