# ADR 0019: The terminal's signing key is held by the platform and never handed to page script

Status: accepted · 2026-11-05

## Context
Every terminal request and every synced command is signed with the device's Ed25519 key. The web build kept the raw secret in `localStorage`, readable by any script that runs on the page (an XSS, a malicious extension). The desktop vault encrypted the identity with the OS store but returned the plain secret to the renderer.

## Decision
- A vault may offer a **keyring**: keys that are generated, kept and used for signing by their holder, and never exported. The identity then stores a `keyId` and no secret.
- **Web:** a non-extractable WebCrypto Ed25519 key in IndexedDB. Page script can request signatures while it runs but cannot copy the key and sign elsewhere. Where the browser has no Ed25519 in WebCrypto, enrolment falls back to the plain secret as before, and the terminal stays flagged low-trust.
- **Signing** goes through `signRequestWith` (a signer callback) with the same signature format, so the server verifies it unchanged.
- An identity whose key is gone (the browser cleared its key store) is cleared at boot and the terminal enrols again; a failed save removes the key it just generated.
- **Desktop:** the same interface backs onto the main process (`safeStorage`), so the renderer asks for signatures and never holds the secret. Done 2026-11-05: `apps/desktop/src/main/keyring.ts` keeps PKCS#8 Ed25519 keys in `device-keys.bin`, encrypted with `safeStorage` (the vault store rules apply: no protected store, no key). The preload exposes `keyring.generate/open/sign/remove`; the renderer gets public keys and signatures only. A terminal enrolled before this keeps its plain secret in the identity file and works as before; a new enrolment uses the main-process key.

## Consequences
- Existing web terminals keep working: an identity with a `secretKey` is still accepted. New enrolments use the keyring where the browser supports it.
- A stolen page script can still sign while it runs on the page; the gain is that the key cannot be exfiltrated and reused later or elsewhere.
- Browsers without WebCrypto Ed25519 stay on the weaker path; that is acceptable only because web terminals are already secondary and low-trust.
