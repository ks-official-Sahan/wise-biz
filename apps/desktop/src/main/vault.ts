/** Electron's `safeStorage`, as far as the vault needs it. */
export interface SafeStorage {
  /** False when the OS offers no real protection (no keyring on Linux, plaintext fallback backend). */
  isStrong: () => Promise<boolean>;
  encryptString: (plain: string) => Promise<Uint8Array>;
  decryptString: (cipher: Uint8Array) => Promise<string>;
}

export interface VaultFiles {
  read: (file: string) => Uint8Array | undefined;
  /** Writes through a temporary file and renames it, so a crash never leaves half a key. */
  write: (file: string, data: Uint8Array) => void;
  remove: (file: string) => void;
}

export class VaultError extends Error {
  override readonly name = "VaultError";
}

/**
 * The device identity (the Ed25519 secret key included) is encrypted with the OS credential store through
 * `safeStorage` and kept in one file. If the OS cannot protect it, nothing is written: a terminal without a protected
 * key cannot enrol, which is better than a signing key lying in a plain file.
 */
export function createVaultStore(o: { file: string; safe: SafeStorage; files: VaultFiles }) {
  return {
    async load(): Promise<string | undefined> {
      const raw = o.files.read(o.file);
      if (raw === undefined) return undefined;
      // With a plaintext-grade backend the ciphertext can be decrypted by anyone: do not hand it out.
      if (!(await o.safe.isStrong())) return undefined;
      try {
        return await o.safe.decryptString(raw);
      } catch {
        // A file the OS cannot decrypt (profile moved, keyring reset) is as good as absent: the terminal re-enrols.
        return undefined;
      }
    },
    async save(value: unknown): Promise<void> {
      if (typeof value !== "string" || value === "" || value.length > 16 * 1024)
        throw new VaultError("Invalid vault value.");
      if (!(await o.safe.isStrong()))
        throw new VaultError(
          "This computer has no protected key store. Unlock the system keyring and restart the app.",
        );
      o.files.write(o.file, await o.safe.encryptString(value));
    },
    clear(): void {
      o.files.remove(o.file);
    },
  };
}
