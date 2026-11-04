import type { SignedFetch } from "./signed-fetch.ts";
import type {
  BootstrapInfo,
  ChangesPage,
  Dataset,
  PullTransport,
  PushResponse,
  StreamTicket,
  Transport,
  WireCommand,
} from "@wise-biz/sync";

/** `POST /v1/sync/commands`. */
export function createPushTransport(signed: SignedFetch): Transport {
  return {
    push: async (commands: readonly WireCommand[]) =>
      (await signed<PushResponse>("POST", "/v1/sync/commands", { body: { commands } })).body,
  };
}

export interface PullTransportOptions {
  signed: SignedFetch;
  /** Downloads a snapshot from its signed storage URL (no device signature: the URL is the credential). */
  download: (url: string) => Promise<Uint8Array>;
}

/**
 * `GET /v1/sync/changes` with ETag revalidation: the last idle ETag per (dataset, cursor) is sent back as
 * `If-None-Match`, so an idle poll costs one small query on the server and no body.
 */
export function createPullTransport(opts: PullTransportOptions): PullTransport {
  const etags = new Map<string, string>();
  return {
    changes: async (dataset: Dataset, cursor: string | undefined, limit: number) => {
      const query = new URLSearchParams({ dataset, limit: String(limit) });
      if (cursor !== undefined) query.set("cursor", cursor);
      const key = `${dataset}|${cursor ?? ""}`;
      const known = etags.get(key);
      const res = await opts.signed<ChangesPage>("GET", `/v1/sync/changes?${query.toString()}`, {
        ...(known === undefined ? {} : { headers: { "if-none-match": known } }),
        accept304: true,
      });
      if (res.status === 304) return "not_modified";
      // Only the idle answer is worth remembering: a page with changes moves the cursor on.
      if (res.body.changes.length === 0 && res.etag !== null) etags.set(key, res.etag);
      return res.body;
    },
    bootstrap: async (dataset: Dataset): Promise<BootstrapInfo> =>
      (await opts.signed<BootstrapInfo>("GET", `/v1/sync/bootstrap?dataset=${dataset}`)).body,
    download: opts.download,
  };
}

/** `POST /v1/sync/stream-ticket`: a short-lived ticket for the realtime hint stream. */
export function createTicketSource(signed: SignedFetch): () => Promise<StreamTicket> {
  return async () => (await signed<StreamTicket>("POST", "/v1/sync/stream-ticket")).body;
}
