/**
 * Object storage behind one small port. Every key is built by `tenantKey`, so an object always lives under
 * `tenants/<tenantId>/` (media-kit has no tenant scoping yet: research gap #8, upstream follow-up in PROGRESS).
 * S3-compatible stores (AWS S3, Cloudflare R2, MinIO) are signed with media-kit's SigV4, no SDK.
 */
export interface ObjectStore {
  /** A URL the client PUTs the file to. content-type and content-length are signed, so both are pinned. */
  presignPut(
    key: string,
    opts: { contentType: string; contentLength: number; expiresSeconds: number },
  ): string;
  /** A short-lived download URL. */
  presignGet(key: string, expiresSeconds: number): string;
  /** The object's bytes as a stream (null when it does not exist). */
  get(key: string): Promise<ReadableStream<Uint8Array> | null>;
  put(key: string, body: Uint8Array | string, contentType: string): Promise<void>;
  /** Removes the object. Deleting one that does not exist is not an error (S3 answers 204 either way). */
  delete(key: string): Promise<void>;
}
