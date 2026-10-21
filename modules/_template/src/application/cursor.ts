import { DomainError } from "@wise-biz/errors";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Opaque keyset cursor: base64url of the last id. */
export function encodeCursor(id: string): string {
  return Buffer.from(id, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): string {
  const id = Buffer.from(cursor, "base64url").toString("utf8");
  if (!UUID.test(id)) {
    throw new DomainError("VALIDATION_FAILED", "invalid cursor", {
      fieldErrors: [{ path: "after", message: "invalid cursor" }],
    });
  }
  return id;
}
