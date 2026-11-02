import { DRAWER_KICK_BYTES, HardwareError, createNetworkPrinter } from "@wise-biz/hardware";

import type {
  HardwareConfig,
  PortInfo,
  PrinterConfig,
  ScaleConfig,
  ScaleReading,
} from "../shared/channels.ts";
import type { TcpSocketLike } from "@wise-biz/hardware";

const MAX_JOB_BYTES = 512 * 1024;
const HOST =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const BAUDS = new Set([1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200]);

export const DEFAULT_CONFIG: HardwareConfig = {
  printer: { kind: "none" },
  scale: { kind: "none" },
};

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function serialOf(v: Record<string, unknown>): { path: string; baudRate: number } {
  const { path, baudRate } = v;
  // A device path or COM name only: no shell syntax, no traversal.
  if (
    typeof path !== "string" ||
    !/^(?:COM\d{1,3}|\/dev\/[A-Za-z0-9._/-]{1,60})$/.test(path) ||
    path.includes("..")
  )
    throw new ConfigError("Invalid serial port.");
  if (typeof baudRate !== "number" || !BAUDS.has(baudRate))
    throw new ConfigError("Invalid baud rate.");
  return { path, baudRate };
}

/** Validates what the renderer sends; anything unexpected is refused rather than coerced. */
export function parseHardwareConfig(raw: unknown): HardwareConfig {
  if (!isObj(raw) || !isObj(raw.printer) || !isObj(raw.scale))
    throw new ConfigError("Invalid configuration.");
  const p = raw.printer;
  let printer: PrinterConfig;
  if (p.kind === "none") printer = { kind: "none" };
  else if (p.kind === "network") {
    const { host, port } = p;
    if (typeof host !== "string" || host.length > 253 || !HOST.test(host))
      throw new ConfigError("Invalid printer address.");
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)
      throw new ConfigError("Invalid printer port.");
    printer = { kind: "network", host, port };
  } else if (p.kind === "serial") printer = { kind: "serial", ...serialOf(p) };
  else throw new ConfigError("Invalid printer type.");
  const s = raw.scale;
  let scale: ScaleConfig;
  if (s.kind === "none") scale = { kind: "none" };
  else if (s.kind === "serial") scale = { kind: "serial", ...serialOf(s) };
  else throw new ConfigError("Invalid scale type.");
  return { printer, scale };
}

/** The slice of a serial port the service needs. */
export interface SerialLike {
  write: (bytes: Uint8Array, done: (err?: Error | null) => void) => void;
  drain: (done: (err?: Error | null) => void) => void;
  close: (done: (err?: Error | null) => void) => void;
  on: (event: "data" | "error", handler: (arg: never) => void) => void;
}

export interface HardwareDeps {
  readonly loadConfig: () => HardwareConfig | undefined;
  readonly saveConfig: (c: HardwareConfig) => void;
  readonly connect: (host: string, port: number) => TcpSocketLike;
  readonly openSerial: (path: string, baudRate: number) => Promise<SerialLike>;
  readonly listSerial: () => Promise<PortInfo[]>;
}

/**
 * Printers, the cash drawer and the scale, owned by the main process. Config is validated on the way in and persisted;
 * one print job runs at a time (a second one waits), so two receipts never interleave on a serial line.
 */
export function createHardwareService(deps: HardwareDeps) {
  let config: HardwareConfig = deps.loadConfig() ?? DEFAULT_CONFIG;
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };

  const writeSerial = async (path: string, baudRate: number, bytes: Uint8Array): Promise<void> => {
    let port: SerialLike;
    try {
      port = await deps.openSerial(path, baudRate);
    } catch {
      throw new HardwareError("offline", `cannot open ${path}`);
    }
    const step = (fn: (done: (err?: Error | null) => void) => void) =>
      new Promise<void>((resolve, reject) => {
        fn((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    try {
      await step((d) => {
        port.write(bytes, d);
      });
      await step((d) => {
        port.drain(d);
      });
    } catch {
      throw new HardwareError("rejected", "printer refused the job");
    } finally {
      await step((d) => {
        port.close(d);
      }).catch(() => undefined);
    }
  };

  const print = (bytes: unknown): Promise<void> => {
    if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > MAX_JOB_BYTES)
      return Promise.reject(new HardwareError("rejected", "Invalid print job."));
    const p = config.printer;
    if (p.kind === "none")
      return Promise.reject(new HardwareError("offline", "No printer is set up on this terminal."));
    if (p.kind === "network")
      return serial(() =>
        createNetworkPrinter({ connect: deps.connect, host: p.host, port: p.port }).write(bytes),
      );
    return serial(() => writeSerial(p.path, p.baudRate, bytes));
  };

  return {
    config: (): HardwareConfig => config,
    setConfig(raw: unknown): HardwareConfig {
      config = parseHardwareConfig(raw);
      deps.saveConfig(config);
      return config;
    },
    print,
    kick: (): Promise<void> => print(DRAWER_KICK_BYTES),
    ports: (): Promise<PortInfo[]> => deps.listSerial(),
    async scale(): Promise<ScaleReading | undefined> {
      const s = config.scale;
      if (s.kind === "none")
        throw new HardwareError("offline", "No scale is set up on this terminal.");
      return serial(() => readScale(deps, s.path, s.baudRate));
    },
  };
}

export type HardwareService = ReturnType<typeof createHardwareService>;

/**
 * One weight from a line-based scale (continuous output such as `ST,GS,  1.250kg`, `  0.480 kg` or `US,GS, 0.002 kg`).
 * `US` marks an unstable reading; lines without a marker count as stable. Grams, rounded.
 */
export function parseScaleLine(line: string): ScaleReading | undefined {
  const m =
    /^\s*(?:(ST|US)\s*,\s*)?(?:(?:GS|NT|G|N)\s*,?\s*)?([+-]?\d+(?:\.\d+)?)\s*(kg|g)\b/i.exec(line);
  if (m === null) return undefined;
  const n = Number(m[2]);
  const grams = Math.round(m[3]?.toLowerCase() === "kg" ? n * 1000 : n);
  return { grams, stable: m[1]?.toUpperCase() !== "US" };
}

async function readScale(
  deps: HardwareDeps,
  path: string,
  baudRate: number,
): Promise<ScaleReading | undefined> {
  let port: SerialLike;
  try {
    port = await deps.openSerial(path, baudRate);
  } catch {
    throw new HardwareError("offline", `cannot open ${path}`);
  }
  return new Promise<ScaleReading | undefined>((resolve) => {
    let buf = "";
    let last: ScaleReading | undefined;
    const done = (r: ScaleReading | undefined) => {
      clearTimeout(timer);
      port.close(() => {
        resolve(r);
      });
    };
    const timer = setTimeout(() => {
      done(last);
    }, 1200);
    port.on("error", () => {
      done(undefined);
    });
    port.on("data", (chunk: never) => {
      buf += Buffer.from(chunk).toString("ascii");
      const lines = buf.split(/\r?\n|\r/);
      buf = lines.pop() ?? "";
      for (const l of lines) {
        const r = parseScaleLine(l);
        if (r === undefined) continue;
        last = r;
        if (r.stable) {
          done(r);
          return;
        }
      }
      if (buf.length > 256) buf = "";
    });
  });
}
