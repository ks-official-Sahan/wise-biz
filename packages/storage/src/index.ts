import { presignS3Url, signS3Request } from "@sahan-sac/media-kit/sigv4";

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
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** `tenants/<tenantId>/<part>/...`: the only way to name an object. Parts are plain names (no slashes, no "..") */
export function tenantKey(tenantId: string, ...parts: string[]): string {
  if (!UUID.test(tenantId)) throw new Error("tenantKey: tenantId must be a UUID");
  if (parts.length === 0) throw new Error("tenantKey: at least one part");
  for (const p of parts) {
    if (!PART.test(p) || p.includes(".."))
      throw new Error(`tenantKey: invalid part ${JSON.stringify(p)}`);
  }
  return `tenants/${tenantId}/${parts.join("/")}`;
}

export interface S3StoreConfig {
  /** e.g. http://localhost:9000 (MinIO) or https://<account>.r2.cloudflarestorage.com; undefined = AWS S3. */
  endpoint?: string | undefined;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Path-style URLs (MinIO). Virtual-host style otherwise. */
  forcePathStyle: boolean;
  fetch?: typeof fetch;
  now?: () => Date;
}

const encodeKey = (key: string) => key.split("/").map(encodeURIComponent).join("/");

export function createS3Store(cfg: S3StoreConfig): ObjectStore {
  const doFetch = cfg.fetch ?? fetch;
  const now = cfg.now ?? (() => new Date());
  const credentials = { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey };
  const scope = { region: cfg.region };
  const base = cfg.endpoint ?? `https://s3.${cfg.region}.amazonaws.com`;
  const url = (key: string) => {
    const u = new URL(base);
    if (cfg.forcePathStyle) return `${u.origin}/${cfg.bucket}/${encodeKey(key)}`;
    return `${u.protocol}//${cfg.bucket}.${u.host}/${encodeKey(key)}`;
  };
  const send = async (
    method: string,
    key: string,
    body?: Uint8Array | string,
    contentType?: string,
  ) => {
    const target = url(key);
    const headers = signS3Request({
      method,
      url: target,
      headers: contentType === undefined ? {} : { "content-type": contentType },
      credentials,
      scope,
      now: now(),
    });
    return doFetch(target, { method, headers, ...(body === undefined ? {} : { body }) });
  };
  return {
    presignPut: (key, o) =>
      presignS3Url({
        method: "PUT",
        url: url(key),
        headers: { "content-type": o.contentType, "content-length": String(o.contentLength) },
        expiresSeconds: o.expiresSeconds,
        credentials,
        scope,
        now: now(),
      }),
    presignGet: (key, expiresSeconds) =>
      presignS3Url({
        method: "GET",
        url: url(key),
        expiresSeconds,
        credentials,
        scope,
        now: now(),
      }),
    get: async (key) => {
      const res = await send("GET", key);
      if (res.status === 404) return null;
      if (!res.ok || res.body === null)
        throw new Error(`storage GET failed: ${String(res.status)}`);
      return res.body;
    },
    put: async (key, body, contentType) => {
      const res = await send("PUT", key, body, contentType);
      if (!res.ok) throw new Error(`storage PUT failed: ${String(res.status)}`);
    },
  };
}

/** Tests and local tools: a Map. Presigned URLs are `memory://` placeholders (nothing serves them). */
export function createMemoryStore(): ObjectStore & { readonly objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    presignPut: (key) => `memory://put/${key}`,
    presignGet: (key) => `memory://get/${key}`,
    get: (key) => {
      const bytes = objects.get(key);
      if (bytes === undefined) return Promise.resolve(null);
      return Promise.resolve(
        new ReadableStream<Uint8Array>({
          start(controller) {
            // Small chunks so consumers exercise their streaming path.
            for (let i = 0; i < bytes.length; i += 4096)
              controller.enqueue(bytes.subarray(i, i + 4096));
            controller.close();
          },
        }),
      );
    },
    put: (key, body) => {
      objects.set(key, typeof body === "string" ? new TextEncoder().encode(body) : body);
      return Promise.resolve();
    },
  };
}

/** The S3 store from the validated STORAGE_* env (@wise-biz/env storageEnv): MinIO in dev, R2/S3 in production. */
export function storeFromEnv(env: {
  STORAGE_ENDPOINT?: string | undefined;
  STORAGE_REGION: string;
  STORAGE_BUCKET: string;
  STORAGE_ACCESS_KEY_ID: string;
  STORAGE_SECRET_ACCESS_KEY: string;
  STORAGE_FORCE_PATH_STYLE: boolean;
}): ObjectStore {
  return createS3Store({
    endpoint: env.STORAGE_ENDPOINT,
    region: env.STORAGE_REGION,
    bucket: env.STORAGE_BUCKET,
    accessKeyId: env.STORAGE_ACCESS_KEY_ID,
    secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY,
    forcePathStyle: env.STORAGE_FORCE_PATH_STYLE,
  });
}
