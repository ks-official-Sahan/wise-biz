/**
 * Device I/O as ports. The app depends on these interfaces only; each platform brings its implementation (TCP and
 * Bluetooth printers on React Native, USB and serial on Electron, a local bridge on the web). Nothing here touches the
 * network or the OS, so it runs in every runtime and in tests.
 */

export type HardwareStatus = "ready" | "offline" | "paper_out" | "cover_open" | "error";

export interface Printer {
  /** Sends raw bytes (ESC/POS) and resolves when the device accepted them. Rejects with `HardwareError`. */
  readonly write: (bytes: Uint8Array) => Promise<void>;
  /** Best-effort device status; `ready` when the transport cannot tell. */
  readonly status: () => Promise<HardwareStatus>;
}

export interface CashDrawer {
  readonly kick: () => Promise<void>;
}

export interface Scanner {
  /** Subscribes to scanned codes; returns the unsubscribe function. */
  readonly onScan: (handler: (code: string) => void) => () => void;
}

export interface CustomerDisplayState {
  readonly lines: readonly {
    readonly name: string;
    readonly qty: string;
    readonly totalMinor: number;
  }[];
  readonly totalMinor: number;
  readonly changeMinor: number;
  readonly currency: string;
  readonly qrUrl?: string | undefined;
  readonly message?: string | undefined;
}

export interface CustomerDisplay {
  readonly show: (state: CustomerDisplayState) => Promise<void>;
  readonly clear: () => Promise<void>;
}

export interface Scale {
  /** One stable weight reading in grams, or undefined while the platter is moving. */
  readonly read: () => Promise<{ readonly grams: number; readonly stable: boolean }>;
}

export class HardwareError extends Error {
  override readonly name = "HardwareError";
  readonly kind: "offline" | "timeout" | "rejected";
  constructor(kind: "offline" | "timeout" | "rejected", message: string) {
    super(message);
    this.kind = kind;
  }
}

/** The ESC p pulse that opens a drawer wired to the printer's drawer port (pin 2). */
export const DRAWER_KICK_BYTES = Uint8Array.from([0x1b, 0x70, 0x00, 0x19, 0xfa]);

/** A drawer that opens by sending the kick pulse through a printer: the common wiring. */
export function drawerViaPrinter(printer: Printer): CashDrawer {
  return { kick: () => printer.write(DRAWER_KICK_BYTES) };
}

/** The minimal socket a network printer needs (react-native-tcp-socket and Node's `net.Socket` both fit behind it). */
export interface TcpSocketLike {
  readonly write: (bytes: Uint8Array, done: (err?: Error | null) => void) => void;
  readonly destroy: () => void;
  /** Half-close after the last write so the printer receives everything before the socket goes away. */
  readonly end?: () => void;
  readonly on: (event: "error" | "close" | "connect", handler: (err?: Error) => void) => void;
}

export interface NetworkPrinterOptions {
  readonly connect: (host: string, port: number) => TcpSocketLike;
  readonly host: string;
  readonly port?: number;
  /** Gives up when the printer does not take the job in time: this plus 1 ms per 20 bytes. Default 3000 ms. */
  readonly timeoutMs?: number;
}

/**
 * ESC/POS over TCP port 9100. One short connection per job: receipt printers drop idle sockets, so a cached socket
 * would fail the first print after a pause. Failure is reported, never swallowed: the sale is already committed and the
 * cashier must see that the receipt did not print.
 */
export function createNetworkPrinter(options: NetworkPrinterOptions): Printer {
  const port = options.port ?? 9100;
  const timeoutMs = options.timeoutMs ?? 3000;
  return {
    write: (bytes) =>
      new Promise<void>((resolve, reject) => {
        let settled = false;
        let socket: TcpSocketLike | undefined;
        const finish = (err?: HardwareError) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket?.destroy();
          if (err === undefined) resolve();
          else reject(err);
        };
        const timer = setTimeout(
          () => {
            finish(new HardwareError("timeout", `printer at ${options.host} did not answer`));
          },
          timeoutMs + Math.ceil(bytes.length / 20),
        );
        try {
          socket = options.connect(options.host, port);
        } catch {
          finish(new HardwareError("offline", `cannot reach printer at ${options.host}`));
          return;
        }
        const conn = socket;
        conn.on("error", () => {
          finish(new HardwareError("offline", `cannot reach printer at ${options.host}`));
        });
        conn.on("connect", () => {
          conn.write(bytes, (err) => {
            if (err) {
              finish(new HardwareError("rejected", "printer refused the job"));
            } else if (conn.end === undefined) {
              finish();
            } else {
              // Wait for the close: destroying right after the flush can drop bytes still in flight.
              conn.on("close", () => {
                finish();
              });
              conn.end();
            }
          });
        });
      }),
    status: () => Promise.resolve("ready"),
  };
}

/** In-memory devices for tests and for running the app without hardware (the "no printer" setting). */
export function createMemoryPrinter(): Printer & {
  readonly jobs: Uint8Array[];
  fail: HardwareError | undefined;
} {
  const printer = {
    jobs: [] as Uint8Array[],
    fail: undefined as HardwareError | undefined,
    write(bytes: Uint8Array): Promise<void> {
      if (printer.fail !== undefined) return Promise.reject(printer.fail);
      printer.jobs.push(bytes);
      return Promise.resolve();
    },
    status: () => Promise.resolve<HardwareStatus>(printer.fail === undefined ? "ready" : "offline"),
  };
  return printer;
}

export function createMemoryScanner(): Scanner & { readonly emit: (code: string) => void } {
  const handlers = new Set<(code: string) => void>();
  return {
    onScan: (h) => {
      handlers.add(h);
      return () => {
        handlers.delete(h);
      };
    },
    emit: (code) => {
      for (const h of handlers) h(code);
    },
  };
}
