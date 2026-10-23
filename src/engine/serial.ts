// Tandem's serial protocol over Web Serial. A half running Tandem firmware has
// a port that answers `info` with one JSON line and `keymap` with the keymap
// file it was built from, and restarts into its bootloader when it's opened at
// 1200 baud. See tandem/zmk-tandem/src/autoflash.c.

export const KINESIS_VID = 0x29ea;

/** The parts of Web Serial's SerialPort that Tandem uses. */
export interface PortLike {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  setSignals?(signals: { dataTerminalReady?: boolean; requestToSend?: boolean }): Promise<void>;
  getInfo(): { usbVendorId?: number; usbProductId?: number };
}

/** The parts of navigator.serial that Tandem uses. */
export interface SerialLike {
  getPorts(): Promise<PortLike[]>;
  requestPort(options?: { filters?: { usbVendorId?: number }[] }): Promise<PortLike>;
  addEventListener(type: "connect" | "disconnect", listener: () => void): void;
}

export interface TandemInfo {
  tandem: number;
  role: "central" | "peripheral";
  name: string;
  build: string;
  repo?: string;
}

const locks = new WeakMap<PortLike, Promise<unknown>>();

/** Runs `fn` with the port to itself. Web Serial won't open a port that's already open. */
export function exclusive<T>(port: PortLike, fn: () => Promise<T>): Promise<T> {
  const next = (locks.get(port) ?? Promise.resolve()).catch(() => {}).then(fn);
  locks.set(
    port,
    next.catch(() => {}),
  );
  return next;
}

async function withPort<T>(port: PortLike, baudRate: number, fn: (port: PortLike) => Promise<T>): Promise<T> {
  return exclusive(port, async () => {
    await port.open({ baudRate });
    try {
      // ZMK's USB serial only sends once the host says it's listening.
      await port.setSignals?.({ dataTerminalReady: true, requestToSend: true }).catch(() => {});
      return await fn(port);
    } finally {
      await port.close().catch(() => {});
    }
  });
}

async function send(port: PortLike, text: string) {
  const writer = port.writable!.getWriter();
  try {
    await writer.write(new TextEncoder().encode(text));
  } finally {
    writer.releaseLock();
  }
}

/** Reads until `enough(bytes)` says so, the port closes, or `ms` passes. */
async function readUntil(port: PortLike, ms: number, enough: (bytes: Uint8Array) => boolean): Promise<Uint8Array> {
  const reader = port.readable!.getReader();
  const timer = setTimeout(() => reader.cancel().catch(() => {}), ms);
  let bytes = new Uint8Array(0);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value?.length) {
        const next = new Uint8Array(bytes.length + value.length);
        next.set(bytes);
        next.set(value, bytes.length);
        bytes = next;
      }
      if (enough(bytes)) break;
    }
  } catch {
    // Timed out, or the half went away.
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
  return bytes;
}

/** Asks a port whether it's Tandem firmware. Other ports ignore the line, so they time out. */
export async function askInfo(port: PortLike, ms = 700): Promise<TandemInfo | null> {
  try {
    return await withPort(port, 115200, async (p) => {
      await send(p, "\ninfo\n");
      let info: TandemInfo | null = null;
      await readUntil(p, ms, (bytes) => {
        const lines = new TextDecoder().decode(bytes).split("\n");
        // The last piece has no newline yet, so it may be incomplete.
        const line = lines.slice(0, -1).find((l) => l.startsWith('{"tandem"'));
        if (!line) return false;
        try {
          const parsed = JSON.parse(line);
          if (parsed.role) info = parsed;
        } catch {
          // Not ours after all.
        }
        return true;
      });
      return info;
    });
  } catch {
    return null;
  }
}

/** Reads the keymap file a half was built from. Needs Tandem protocol 2. */
export async function readTandemKeymap(port: PortLike, ms = 6000): Promise<string> {
  return withPort(port, 115200, async (p) => {
    await send(p, "\nkeymap\n");
    let header = null as { start: number; length: number } | null;
    const bytes = await readUntil(p, ms, (b) => {
      if (!header) {
        // Latin-1 keeps one character per byte, so string offsets are byte offsets.
        const m = /\{"tandem":\d+,"keymap":(\d+)\}\n/.exec(new TextDecoder("latin1").decode(b));
        if (!m) return false;
        header = { start: m.index + m[0].length, length: Number(m[1]) };
      }
      return b.length - header.start >= header.length;
    });
    if (!header || bytes.length - header.start < header.length) throw new Error("The keyboard didn't send its keymap.");
    return new TextDecoder().decode(bytes.subarray(header.start, header.start + header.length));
  });
}

/** Opens the port at 1200 baud, which restarts that half into its bootloader. */
export async function restartToBootloader(port: PortLike): Promise<boolean> {
  try {
    await exclusive(port, async () => {
      await port.open({ baudRate: 1200 });
      await new Promise((r) => setTimeout(r, 100));
      // The half may already be gone, so closing can fail.
      await port.close().catch(() => {});
    });
    return true;
  } catch {
    return false;
  }
}
