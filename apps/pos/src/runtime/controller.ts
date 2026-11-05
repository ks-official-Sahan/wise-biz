import { uuidv7, createHlc } from "@wise-biz/ids";
import { createSyncClient, fetchOpenStream, openLocalDb } from "@wise-biz/sync";
import { gunzipSync } from "fflate";

import {
  createKeyStore,
  createPullTransport,
  createPushTransport,
  createServerClock,
  createTicketSource,
  enrollDevice,
  heartbeat,
  pinLogin,
  pinLogout,
  openSigner,
  signedFetchFor,
} from "../platform/index.ts";
import { sessionSlice } from "../state/slices.ts";

import type {
  DeviceIdentity,
  DeviceVault,
  FetchLike,
  Platform,
  ServerClock,
  SignedFetch,
} from "../platform/index.ts";
import type { PosStore } from "../state/store.ts";
import type { Dataset, StorageAdapter, SyncClient, SyncHealth } from "@wise-biz/sync";

/** Datasets with a producer today; the rest are added as their modules ship. */
export const DATASETS: readonly Dataset[] = [
  "catalog",
  "prices",
  "tax",
  "promotions",
  "stock_branch",
];
const HEARTBEAT_MS = 60_000;
const POLL_MS = 45_000;

export interface ControllerDeps {
  store: PosStore;
  vault: DeviceVault;
  /** Opens the device database (expo-sqlite in the app, better-sqlite3 in tests). */
  openStorage: (deviceId: string) => Promise<StorageAdapter>;
  fetch: FetchLike;
  baseUrl: string;
  platform: Platform;
  appVersion: string;
  lowTrust: boolean;
  /** Realtime hints need a streaming fetch: web and Electron have one, React Native does not (poll only there). */
  streamingFetch?: typeof fetch;
  onError?: (err: unknown) => void;
}

export interface Operator {
  readonly userId: string;
  readonly name: string;
}

/** gzip -> bytes: native `DecompressionStream` where it exists (web, Node), fflate on Hermes. */
async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream !== "undefined") {
    const stream = new Blob([bytes as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return gunzipSync(bytes);
}

/**
 * The app's one stateful object: boots from the vault, enrolls, starts the sync client, unlocks operators, keeps
 * the heartbeat, and turns server verdicts (revoked, quarantined) into session state. Screens only dispatch to it and
 * read the store; nothing else talks to the network.
 */
export function createController(deps: ControllerDeps) {
  const { store, vault } = deps;
  const dispatch = store.dispatch;
  const report = (e: unknown) => deps.onError?.(e);
  const clock: ServerClock = createServerClock();
  let signed: SignedFetch | undefined;
  let client: SyncClient | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let started = false;

  const download = async (url: string): Promise<Uint8Array> => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`snapshot download failed (${String(res.status)})`);
    return new Uint8Array(await res.arrayBuffer());
  };

  async function startSync(id: DeviceIdentity): Promise<void> {
    if (started) return;
    started = true;
    try {
      await begin(id);
    } catch (e) {
      // A terminal that cannot open its database must say so, not sit on "getting ready" for ever.
      started = false;
      report(e);
      dispatch(sessionSlice.actions.blocked("quarantined"));
      throw e;
    }
  }

  async function begin(id: DeviceIdentity): Promise<void> {
    const signer = await openSigner(id, vault);
    if (signer === undefined)
      throw new Error("The device key is gone; this terminal must enrol again.");
    signed = signedFetchFor(id, signer, deps.baseUrl, deps.fetch, clock.now);
    const db = await openLocalDb(await deps.openStorage(id.deviceId));
    client = createSyncClient({
      db,
      keys: createKeyStore(signer),
      hlc: createHlc({ node: id.deviceId, now: clock.now }),
      ids: { uuidv7 },
      push: createPushTransport(signed),
      pull: createPullTransport({ signed, download }),
      gunzip,
      datasets: DATASETS,
      pollMs: POLL_MS,
      now: clock.now,
      onError: report,
      onPushEvent: (e) => {
        if (e.type === "blocked") {
          dispatch(
            sessionSlice.actions.blocked(e.reason === "diverged" ? "diverged" : "quarantined"),
          );
        } else if (e.type === "auth_required") report(new Error("terminal signature rejected"));
      },
      ...(deps.streamingFetch
        ? {
            realtime: {
              ticket: createTicketSource(signed),
              open: fetchOpenStream(deps.streamingFetch),
            },
          }
        : {}),
    });
    // Offline cold start must not wait for the network: the loops retry on their own.
    client.start().catch(report);
    heartbeatTimer = setInterval(() => {
      beat().catch(report);
    }, HEARTBEAT_MS);
    beat().catch(report);
    watchFirstSync().catch(report);
  }

  /** Moves enrolled -> locked once every dataset has its first snapshot. */
  async function watchFirstSync(): Promise<void> {
    for (;;) {
      if (client === undefined) return;
      const h = await client.health();
      if (h.pendingBootstrap.length === 0) {
        dispatch(sessionSlice.actions.ready());
        return;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  async function beat(): Promise<void> {
    if (signed === undefined || client === undefined) return;
    const h = await client.health();
    const operatorId = store.getState().session.operator?.userId;
    const reply = await heartbeat(signed, clock, {
      appVersion: deps.appVersion,
      unsyncedCount: h.unsyncedCount,
      oldestUnsyncedAt:
        h.oldestUnsyncedAt === undefined ? null : new Date(h.oldestUnsyncedAt).toISOString(),
      connection: "unknown",
      ...(operatorId === undefined ? {} : { operatorId }),
    });
    if (reply.status === "revoked" || reply.status === "blacklisted") {
      // The owner removed this terminal. Unsynced commands stay in the local database for a support export.
      try {
        await stop();
        dispatch(sessionSlice.actions.blocked("revoked"));
      } finally {
        await vault.clear();
      }
    } else if (reply.status === "suspended") {
      dispatch(sessionSlice.actions.blocked("suspended"));
    }
  }

  async function stop(): Promise<void> {
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
    await client?.stop();
    client = undefined;
    started = false;
  }

  return {
    clock,
    /** Reads the vault and decides where the app starts. */
    async boot(): Promise<void> {
      let id = await vault.load();
      // An identity whose key is gone (the browser cleared its key store) cannot sign anything: start again at enrolment.
      if (id !== undefined && (await openSigner(id, vault)) === undefined) {
        await vault.clear();
        id = undefined;
      }
      dispatch(
        sessionSlice.actions.booted({
          device:
            id === undefined
              ? null
              : { deviceId: id.deviceId, tenantId: id.tenantId, branchId: id.branchId, name: "" },
          lowTrust: deps.lowTrust,
        }),
      );
      if (id === undefined) return;
      await startSync(id);
      // A terminal that never finished its first sync goes back to the progress screen, not the PIN pad.
      const h = await client?.health();
      if (h !== undefined && h.pendingBootstrap.length > 0) {
        dispatch(
          sessionSlice.actions.enrolled({
            deviceId: id.deviceId,
            tenantId: id.tenantId,
            branchId: id.branchId,
            name: "",
          }),
        );
        watchFirstSync().catch(report);
      }
    },
    async enroll(code: string): Promise<void> {
      const device = await enrollDevice({
        baseUrl: deps.baseUrl,
        code,
        platform: deps.platform,
        appVersion: deps.appVersion,
        vault,
        fetch: deps.fetch,
        now: clock.now,
      });
      dispatch(
        sessionSlice.actions.enrolled({
          deviceId: device.deviceId,
          tenantId: device.tenantId,
          branchId: device.branchId,
          name: device.name,
        }),
      );
      const id = await vault.load();
      if (id !== undefined) await startSync(id);
    },
    /** Operators this terminal knows about (the synced policy snapshot; empty until that dataset has a producer). */
    async operators(): Promise<Operator[]> {
      if (client === undefined) return [];
      const rows = await client.db.all<{ payload: string }>(
        "SELECT payload FROM entities WHERE dataset = 'policy_snapshot' AND entity = 'operator' ORDER BY entity_id",
      );
      const out: Operator[] = [];
      for (const r of rows) {
        try {
          const v = JSON.parse(r.payload) as Partial<Operator>;
          if (typeof v.userId === "string" && typeof v.name === "string")
            out.push({ userId: v.userId, name: v.name });
        } catch (e) {
          report(e);
        }
      }
      return out;
    },
    async unlock(userId: string, pin: string): Promise<void> {
      if (signed === undefined) throw new Error("terminal is not enrolled");
      const s = await pinLogin(signed, userId, pin);
      dispatch(sessionSlice.actions.unlocked(s));
    },
    async lock(): Promise<void> {
      dispatch(sessionSlice.actions.locked());
      if (signed !== undefined) await pinLogout(signed).catch(report);
    },
    /** Refused while commands are unsynced: signing out would strand them. */
    async signOut(): Promise<void> {
      await client?.outbox.assertSafeToSignOut();
      await stop();
      await vault.clear();
      dispatch(sessionSlice.actions.reset());
    },
    health: (): Promise<SyncHealth> =>
      client === undefined
        ? Promise.resolve({
            unsyncedCount: 0,
            oldestUnsyncedAt: undefined,
            lagMs: 0,
            push: "idle",
            pendingBootstrap: DATASETS,
          })
        : client.health(),
    /** Local database and in-memory indexes for the sell screen; undefined until sync has started. */
    sellDeps():
      | {
          db: SyncClient["db"];
          indexes: SyncClient["indexes"];
          branchId: string;
          transaction: SyncClient["transaction"];
        }
      | undefined {
      const branchId = store.getState().session.device?.branchId;
      if (client === undefined || branchId === undefined) return undefined;
      return {
        db: client.db,
        indexes: client.indexes,
        branchId,
        transaction: client.transaction.bind(client),
      };
    },
    nudge: (): void => {
      client?.nudge();
    },
    stop,
  };
}

export type Controller = ReturnType<typeof createController>;
