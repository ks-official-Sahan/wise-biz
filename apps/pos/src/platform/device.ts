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
  /** Raw 32-byte Ed25519 secret, base64. Absent when the key lives in the vault's keyring (see `keyId`). */
  readonly secretKey?: string;
  /** Names a key the keyring holds and never hands out; the identity then carries no secret at all. */
  readonly keyId?: string;
}

/** Signs for the device without exposing the key. */
export interface DeviceSigner {
  readonly publicKey: Uint8Array;
  readonly sign: (message: Uint8Array) => Promise<Uint8Array>;
}

/**
 * Keys that never leave their holder: a non-extractable WebCrypto key on the web, the main process on desktop. Script
 * running in the page can ask for signatures while it runs, but cannot copy the key out and use it elsewhere.
 */
export interface DeviceKeyring {
  /** Rejects when the platform cannot keep a key this way (the caller then falls back to the plain secret). */
  readonly generate: (keyId: string) => Promise<DeviceSigner>;
  readonly open: (keyId: string) => Promise<DeviceSigner | undefined>;
  readonly remove: (keyId: string) => Promise<void>;
}

/**
 * Secure storage for the identity: Keychain / Android Keystore via expo-secure-store on devices, a non-extractable
 * key in IndexedDB on web (low trust: such terminals are flagged), safeStorage on Electron.
 */
export interface DeviceVault {
  /** When present, new enrollments keep their key here and the identity stores no secret. */
  keyring?: DeviceKeyring;
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
  const deviceId = uuidv7();
  // A key the platform keeps to itself if it can; otherwise the plain secret in the vault (the previous behaviour).
  const held = await opts.vault.keyring?.generate(deviceId).catch(() => undefined);
  const plain = held === undefined ? generateKeyPair() : undefined;
  const publicKey = held?.publicKey ?? plain?.publicKey;
  if (publicKey === undefined) throw new Error("no device key");
  const signed = createSignedFetch({
    baseUrl: opts.baseUrl,
    deviceId,
    ...(held === undefined
      ? { secretKey: () => (plain ?? generateKeyPair()).secretKey }
      : { sign: held.sign }),
    fetch: opts.fetch,
    ...(opts.now ? { now: opts.now } : {}),
  });
  const { body } = await signed<EnrolledDevice>("POST", "/v1/devices/enroll", {
    body: {
      code: opts.code,
      deviceId,
      publicKey: toBase64url(publicKey),
      platform: opts.platform,
      appVersion: opts.appVersion,
    },
  });
  try {
    await opts.vault.save({
      deviceId,
      tenantId: body.tenantId,
      branchId: body.branchId,
      ...(held === undefined
        ? { secretKey: toBase64(plain?.secretKey ?? new Uint8Array()) }
        : { keyId: deviceId }),
    });
  } catch (err) {
    await opts.vault.keyring?.remove(deviceId).catch(() => undefined);
    throw err;
  }
  return body;
}

/**
 * The signer for a stored identity: the keyring's held key, or the plain secret from the vault. Undefined means the key
 * is gone (the keyring was cleared): the terminal has to enrol again.
 */
export async function openSigner(
  identity: DeviceIdentity,
  vault: DeviceVault,
): Promise<DeviceSigner | undefined> {
  if (identity.keyId !== undefined) return vault.keyring?.open(identity.keyId);
  if (identity.secretKey === undefined) return undefined;
  const secret = fromBase64(identity.secretKey);
  return {
    publicKey: publicKeyFrom(secret),
    sign: (message) => Promise.resolve(sign(message, secret)),
  };
}

/** The `KeyStore` the sync package signs commands with. */
export function createKeyStore(signer: DeviceSigner): KeyStore {
  return {
    publicKey: () => Promise.resolve(signer.publicKey),
    sign: (message) => signer.sign(message),
  };
}

export function signedFetchFor(
  identity: DeviceIdentity,
  signer: DeviceSigner,
  baseUrl: string,
  fetchFn: FetchLike,
  now?: () => number,
): SignedFetch {
  return createSignedFetch({
    baseUrl,
    deviceId: identity.deviceId,
    sign: signer.sign,
    fetch: fetchFn,
    ...(now ? { now } : {}),
  });
}
