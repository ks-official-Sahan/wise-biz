// Software WebAuthn authenticator for tests. ES256 keypair from node:crypto, "none" attestation, UP|UV|AT flags on
// registration, UP|UV on assertion. Only the CBOR shapes WebAuthn needs (maps, byte strings, text strings, ints) are
// encoded. Test-only: a real authenticator keeps its private key in hardware.
import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign } from "node:crypto";

import type { KeyObject } from "node:crypto";

type CborInput = number | string | Uint8Array | Map<number | string, CborInput>;

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

function head(major: number, value: number): Buffer {
  if (value < 24) return Buffer.from([(major << 5) | value]);
  if (value < 0x100) return Buffer.from([(major << 5) | 24, value]);
  if (value < 0x10000) {
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(value, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(value, 1);
  return b;
}

/** Deterministic CBOR (RFC 8949) for the subset above. Map entries keep insertion order. */
export function cbor(value: CborInput): Buffer {
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array)
    return Buffer.concat([head(2, value.length), Buffer.from(value)]);
  const parts: Buffer[] = [head(5, value.size)];
  for (const [k, v] of value) parts.push(cbor(k), cbor(v));
  return Buffer.concat(parts);
}

const sha256 = (data: Uint8Array): Buffer => createHash("sha256").update(data).digest();
const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
};
const b64u = (data: Uint8Array): string => Buffer.from(data).toString("base64url");

export interface PublicKeyCredentialJSON {
  id: string;
  rawId: string;
  type: "public-key";
  response: Record<string, string | string[]>;
  clientExtensionResults: Record<string, never>;
  authenticatorAttachment?: "platform";
}

export class SoftAuthenticator {
  readonly credentialId = randomBytes(32);
  private readonly privateKey: KeyObject;
  private readonly x: Buffer;
  private readonly y: Buffer;
  private signCount = 0;

  private readonly rpId: string;
  private readonly origin: string;

  constructor(rpId: string, origin: string) {
    this.rpId = rpId;
    this.origin = origin;
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = pair.privateKey;
    const jwk = pair.publicKey.export({ format: "jwk" });
    if (jwk.x === undefined || jwk.y === undefined)
      throw new Error("EC public key missing coordinates");
    this.x = Buffer.from(jwk.x, "base64url");
    this.y = Buffer.from(jwk.y, "base64url");
  }

  /** navigator.credentials.create() answer for a registration challenge (from generate-register-options). */
  register(challenge: string, origin = this.origin): PublicKeyCredentialJSON {
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: "webauthn.create", challenge, origin, crossOrigin: false }),
    );
    const coseKey = cbor(
      new Map<number | string, CborInput>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, this.x],
        [-3, this.y],
      ]),
    );
    const aaguid = Buffer.alloc(16);
    const credentialIdLength = Buffer.alloc(2);
    credentialIdLength.writeUInt16BE(this.credentialId.length, 0);
    const authData = Buffer.concat([
      sha256(Buffer.from(this.rpId)),
      Buffer.from([FLAG_UP | FLAG_UV | FLAG_AT]),
      u32(0),
      aaguid,
      credentialIdLength,
      this.credentialId,
      coseKey,
    ]);
    const attestationObject = cbor(
      new Map<number | string, CborInput>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]),
    );
    const id = b64u(this.credentialId);
    return {
      id,
      rawId: id,
      type: "public-key",
      response: {
        clientDataJSON: b64u(clientDataJSON),
        attestationObject: b64u(attestationObject),
        transports: ["internal"],
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  /** navigator.credentials.get() answer for an authentication challenge. Each call bumps the signature counter. */
  assert(challenge: string, origin = this.origin, userVerified = true): PublicKeyCredentialJSON {
    this.signCount += 1;
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: "webauthn.get", challenge, origin, crossOrigin: false }),
    );
    const authenticatorData = Buffer.concat([
      sha256(Buffer.from(this.rpId)),
      Buffer.from([userVerified ? FLAG_UP | FLAG_UV : FLAG_UP]),
      u32(this.signCount),
    ]);
    // ES256 over authData || sha256(clientDataJSON); node returns the DER encoding WebAuthn requires.
    const signature = cryptoSign(
      "sha256",
      Buffer.concat([authenticatorData, sha256(clientDataJSON)]),
      this.privateKey,
    );
    const id = b64u(this.credentialId);
    return {
      id,
      rawId: id,
      type: "public-key",
      response: {
        authenticatorData: b64u(authenticatorData),
        clientDataJSON: b64u(clientDataJSON),
        signature: b64u(signature),
      },
      clientExtensionResults: {},
    };
  }
}
