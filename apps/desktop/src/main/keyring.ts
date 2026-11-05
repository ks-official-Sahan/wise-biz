import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";

import type { createVaultStore } from "./vault.ts";

export class KeyringError extends Error {
  override readonly name = "KeyringError";
}

const KEY_ID = /^[A-Za-z0-9-]{8,64}$/;
/** A signing base is a few hundred bytes; the cap only stops the renderer from feeding the main process a huge buffer. */
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_KEYS = 8;

function keyIdOf(value: unknown): string {
  if (typeof value !== "string" || !KEY_ID.test(value)) throw new KeyringError("Invalid key id.");
  return value;
}

/**
 * Device signing keys that stay in the main process (ADR 0019). The renderer asks for a signature and gets only the
 * signature back; the secret never crosses the IPC boundary, so script in the page can use the key while it runs but
 * cannot copy it out. Keys are PKCS#8 Ed25519, kept in one file encrypted with the OS credential store (the vault
 * store's rules apply: no protected store, no key).
 */
export function createKeyring(o: { store: ReturnType<typeof createVaultStore> }) {
  /** One operation at a time: load-modify-save must not interleave. */
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };

  async function readAll(): Promise<Record<string, string>> {
    const raw = await o.store.load();
    if (raw === undefined) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) return {};
      return Object.fromEntries(
        Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === "string"),
      );
    } catch {
      return {};
    }
  }
  async function writeAll(keys: Record<string, string>): Promise<void> {
    if (Object.keys(keys).length === 0) o.store.clear();
    else await o.store.save(JSON.stringify(keys));
  }

  const publicOf = (pkcs8: string): Uint8Array => {
    const jwk = createPublicKey(
      createPrivateKey({ key: Buffer.from(pkcs8, "base64"), format: "der", type: "pkcs8" }),
    ).export({ format: "jwk" });
    return new Uint8Array(Buffer.from(jwk.x ?? "", "base64url"));
  };

  return {
    /** Makes a key and returns its public half. An existing id is refused: a key is never silently replaced. */
    generate: (id: unknown): Promise<Uint8Array> =>
      serial(async () => {
        const keyId = keyIdOf(id);
        const keys = await readAll();
        if (keys[keyId] !== undefined) throw new KeyringError("That key already exists.");
        if (Object.keys(keys).length >= MAX_KEYS) throw new KeyringError("Too many keys.");
        const { privateKey } = generateKeyPairSync("ed25519");
        const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
        await writeAll({ ...keys, [keyId]: pkcs8 });
        return publicOf(pkcs8);
      }),
    /** The public half of a stored key, or undefined when there is none (the terminal has to enrol again). */
    open: (id: unknown): Promise<Uint8Array | undefined> =>
      serial(async () => {
        const pkcs8 = (await readAll())[keyIdOf(id)];
        return pkcs8 === undefined ? undefined : publicOf(pkcs8);
      }),
    sign: (id: unknown, message: unknown): Promise<Uint8Array> =>
      serial(async () => {
        const keyId = keyIdOf(id);
        if (!(message instanceof Uint8Array) || message.byteLength > MAX_MESSAGE_BYTES)
          throw new KeyringError("Invalid message.");
        const pkcs8 = (await readAll())[keyId];
        if (pkcs8 === undefined) throw new KeyringError("No such key.");
        const key = createPrivateKey({
          key: Buffer.from(pkcs8, "base64"),
          format: "der",
          type: "pkcs8",
        });
        return new Uint8Array(sign(null, message, key));
      }),
    remove: (id: unknown): Promise<void> =>
      serial(async () => {
        const keyId = keyIdOf(id);
        const keys = await readAll();
        if (keys[keyId] === undefined) return;
        await writeAll(Object.fromEntries(Object.entries(keys).filter(([id]) => id !== keyId)));
      }),
  };
}

export type Keyring = ReturnType<typeof createKeyring>;
