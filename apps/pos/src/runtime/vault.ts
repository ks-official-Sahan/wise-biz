import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

import type { DeviceIdentity, DeviceVault } from "../platform/index.ts";
import type { KeyValue } from "../state/store.ts";

const IDENTITY_KEY = "wb.pos.identity.v1";

const isIdentity = (v: unknown): v is DeviceIdentity => {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.deviceId === "string" &&
    typeof o.tenantId === "string" &&
    typeof o.branchId === "string" &&
    typeof o.secretKey === "string"
  );
};

/**
 * Where the device key lives. Native: Keychain / Android Keystore through expo-secure-store (hardware-backed where the
 * device has it). Web: there is no secure enclave, so the key sits in the browser's local storage and the terminal
 * is flagged low-trust (secondary role, no hardware drawer; the console shows it as a web terminal).
 */
export const isLowTrustPlatform = Platform.OS === "web";

export function createVault(): DeviceVault {
  if (Platform.OS === "web") {
    return {
      load: () => Promise.resolve(parse(globalThis.localStorage.getItem(IDENTITY_KEY))),
      save: (i) => {
        globalThis.localStorage.setItem(IDENTITY_KEY, JSON.stringify(i));
        return Promise.resolve();
      },
      clear: () => {
        globalThis.localStorage.removeItem(IDENTITY_KEY);
        return Promise.resolve();
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
