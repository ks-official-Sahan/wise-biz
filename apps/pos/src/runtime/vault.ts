import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

import type {
  DeviceIdentity,
  DeviceKeyring,
  DeviceSigner,
  DeviceVault,
} from "../platform/index.ts";
import type { KeyValue } from "../state/store.ts";

const IDENTITY_KEY = "wb.pos.identity.v1";

const isIdentity = (v: unknown): v is DeviceIdentity => {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.deviceId === "string" &&
    typeof o.tenantId === "string" &&
    typeof o.branchId === "string" &&
    (typeof o.secretKey === "string" || typeof o.keyId === "string")
  );
};

const KEY_DB = "wb-device-keys";
const KEY_STORE = "keys";

function keyDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = globalThis.indexedDB.open(KEY_DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(KEY_STORE);
    };
    req.onsuccess = () => {
      resolve(req.result);
    };
    req.onerror = () => {
      reject(req.error ?? new Error("key store unavailable"));
    };
  });
}

async function keyTx<T>(
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await keyDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(KEY_STORE, mode);
      const req = run(tx.objectStore(KEY_STORE));
      const failed = (): void => {
        reject(req.error ?? tx.error ?? new Error("key store failed"));
      };
      if (mode === "readonly") {
        req.onsuccess = () => {
          resolve(req.result);
        };
        req.onerror = failed;
      } else {
        // A write is done when its transaction commits, not when the request succeeds: a commit can still fail (quota)
        // and roll the write back, and enrolment must not go on with a key that was never stored.
        tx.oncomplete = () => {
          resolve(req.result);
        };
        tx.onerror = failed;
        tx.onabort = failed;
      }
    });
  } finally {
    db.close();
  }
}

async function signerOf(pair: CryptoKeyPair): Promise<DeviceSigner> {
  const publicKey = new Uint8Array(await globalThis.crypto.subtle.exportKey("raw", pair.publicKey));
  return {
    publicKey,
    sign: async (message) =>
      new Uint8Array(
        await globalThis.crypto.subtle.sign("Ed25519", pair.privateKey, message as BufferSource),
      ),
  };
}

/**
 * The web terminal's key as a non-extractable WebCrypto Ed25519 key in IndexedDB: script on the page can ask it to sign
 * while it runs, but nothing can read the key out and carry it away (unlike a secret in localStorage). Where the browser
 * has no Ed25519 in WebCrypto, `generate` rejects and enrolment keeps the plain secret as before.
 */
export function createWebKeyring(): DeviceKeyring {
  return {
    generate: async (keyId) => {
      const pair = await globalThis.crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"]);
      await keyTx("readwrite", (s) => s.put(pair, keyId));
      return signerOf(pair);
    },
    open: async (keyId) => {
      const found: unknown = await keyTx("readonly", (s) => s.get(keyId) as IDBRequest<unknown>);
      return found === undefined ? undefined : signerOf(found as CryptoKeyPair);
    },
    remove: async (keyId) => {
      await keyTx("readwrite", (s) => s.delete(keyId));
    },
  };
}

const hasWebKeys = (): boolean =>
  typeof globalThis.indexedDB !== "undefined" && typeof globalThis.crypto.subtle !== "undefined";

/**
 * Where the device key lives. Native: Keychain / Android Keystore through expo-secure-store (hardware-backed where the
 * device has it). Web: there is no secure enclave, so the key sits in the browser's local storage and the terminal
 * is flagged low-trust (secondary role, no hardware drawer; the console shows it as a web terminal).
 */
export const isLowTrustPlatform = Platform.OS === "web";

export function createVault(): DeviceVault {
  if (Platform.OS === "web") {
    const keyring = hasWebKeys() ? createWebKeyring() : undefined;
    return {
      ...(keyring === undefined ? {} : { keyring }),
      load: () => Promise.resolve(parse(globalThis.localStorage.getItem(IDENTITY_KEY))),
      save: (i) => {
        globalThis.localStorage.setItem(IDENTITY_KEY, JSON.stringify(i));
        return Promise.resolve();
      },
      clear: async () => {
        const id = parse(globalThis.localStorage.getItem(IDENTITY_KEY));
        globalThis.localStorage.removeItem(IDENTITY_KEY);
        if (id?.keyId !== undefined) await keyring?.remove(id.keyId).catch(() => undefined);
      },
    };
  }
  return {
    load: async () => parse(await SecureStore.getItemAsync(IDENTITY_KEY)),
    save: (i) =>
      SecureStore.setItemAsync(IDENTITY_KEY, JSON.stringify(i), {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      }),
    clear: () => SecureStore.deleteItemAsync(IDENTITY_KEY),
  };
}

function parse(raw: string | null): DeviceIdentity | undefined {
  if (raw === null) return undefined;
  try {
    const v: unknown = JSON.parse(raw);
    return isIdentity(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** UI preferences and the device summary: localStorage on web, the app's SQLite key-value store on native. */
export function createKeyValue(): KeyValue {
  if (Platform.OS === "web") {
    return {
      getItem: (k) => Promise.resolve(globalThis.localStorage.getItem(k)),
      setItem: (k, v) => {
        globalThis.localStorage.setItem(k, v);
        return Promise.resolve();
      },
      removeItem: (k) => {
        globalThis.localStorage.removeItem(k);
        return Promise.resolve();
      },
    };
  }
  // Loaded lazily so web bundles never touch the native module.
  const kv = () => import("expo-sqlite/kv-store").then((m) => m.default);
  return {
    getItem: async (k) => (await kv()).getItem(k),
    setItem: async (k, v) => {
      await (await kv()).setItem(k, v);
    },
    removeItem: async (k) => {
      await (await kv()).removeItem(k);
    },
  };
}
