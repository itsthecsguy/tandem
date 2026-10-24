// A simulated Advantage 360 Pro for tests. Each half has Web Serial ports
// that speak Tandem's protocol, restarts into update mode when its Tandem port
// opens at 1200 baud, and takes new firmware when a UF2 is written to its
// update drive. Ports only show up once "the user" has allowed them.

import type { DriveLike } from "../../src/engine/serial-keyboard";
import type { PortLike, SerialLike } from "../../src/engine/serial";

const enc = (s: string) => new TextEncoder().encode(s);
const gone = (what: string) => new DOMException(`${what} is gone`, "NotFoundError");

export class FakePort implements PortLike {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;

  constructor(
    readonly half: FakeHalf,
    readonly kind: "tandem" | "studio",
  ) {}

  getInfo() {
    return { usbVendorId: 0x29ea, usbProductId: 0x0362 };
  }

  async open({ baudRate }: { baudRate: number }) {
    if (!this.half.ports().includes(this)) throw new DOMException("The device has been lost.", "NetworkError");
    if (this.readable) throw new DOMException("The port is already open.", "InvalidStateError");
    this.readable = new ReadableStream({ start: (c) => void (this.controller = c) });
    let pending = "";
    this.writable = new WritableStream({
      write: (chunk) => {
        // ZMK Studio's port ignores Tandem's text commands, and so does a
        // half that's still starting up.
        if (this.kind !== "tandem" || Date.now() < this.half.silentUntil) return;
        pending += new TextDecoder().decode(chunk);
        for (let i = pending.indexOf("\n"); i >= 0; i = pending.indexOf("\n")) {
          const command = pending.slice(0, i).trim();
          pending = pending.slice(i + 1);
          if (command === "info") this.controller?.enqueue(enc(`${JSON.stringify(this.half.info())}\n`));
          if (command === "keymap" && this.half.protocol >= 2) {
            const body = enc(this.half.keymap);
            this.controller?.enqueue(enc(`{"tandem":2,"keymap":${body.length}}\n`));
            this.controller?.enqueue(body);
          }
        }
      },
    });
    if (this.kind === "tandem" && baudRate === 1200 && this.half.restartsOnRequest) setTimeout(() => this.half.enterUpdateMode(), 20);
  }

  async close() {
    if (!this.readable) throw new DOMException("The port is already closed.", "InvalidStateError");
    if (this.readable.locked || this.writable?.locked) throw new TypeError("Can't close a port while its streams are locked.");
    try {
      this.controller?.close();
    } catch {
      // Already cancelled by a reader.
    }
    this.readable = null;
    this.writable = null;
    this.controller = null;
  }

  async setSignals() {}
}

export class FakeHalf {
  /** Tandem build ID, or null for firmware without Tandem. */
  build: string | null;
  protocol = 2;
  mode: "app" | "update" = "app";
  keymap = "/ { keymap { compatible = \"zmk,keymap\"; }; };";
  restartsOnRequest = true;
  /** Ignore new firmware, to test a flash that doesn't take. */
  rejectsFirmware = false;
  /** Until then, the Tandem port ignores commands, like a half still starting up. */
  silentUntil = 0;
  flashedWith: string | null = null;
  tandemPort: FakePort | null = null;
  studioPort: FakePort | null = null;

  constructor(
    readonly keyboard: FakeKeyboard,
    readonly side: "left" | "right",
    options: { build: string | null; studio?: boolean },
  ) {
    this.build = options.build;
    if (this.build) this.tandemPort = new FakePort(this, "tandem");
    if (options.studio) this.studioPort = new FakePort(this, "studio");
  }

  info() {
    return { tandem: this.protocol, role: this.side === "left" ? "central" : "peripheral", name: "Adv360 Pro", build: this.build, repo: "octocat/adv360" };
  }

  ports(): FakePort[] {
    if (this.mode !== "app") return [];
    return [this.tandemPort, this.studioPort].filter((p): p is FakePort => !!p);
  }

  enterUpdateMode() {
    this.mode = "update";
    this.keyboard.mount(this);
    this.keyboard.fire("disconnect");
  }

  /** The user's key combo, for a half without Tandem firmware. */
  pressCombo() {
    this.enterUpdateMode();
  }

  takeFirmware(data: Uint8Array) {
    const text = new TextDecoder().decode(data);
    this.flashedWith = text;
    const m = /^UF2\n(left|right)-\w+:(\w+)/.exec(text);
    if (m && !this.rejectsFirmware) {
      this.build = m[2];
      this.protocol = 2;
      // New Tandem firmware brings a new port, which nobody has allowed yet.
      this.tandemPort ??= new FakePort(this, "tandem");
    }
    this.mode = "app";
    this.keyboard.unmount();
    setTimeout(() => this.keyboard.fire("connect"), 20);
  }
}

/** ADV360PRO as the browser hands it to the page. */
export class FakeDrive implements DriveLike {
  readonly name = "ADV360PRO";
  constructor(
    readonly keyboard: FakeKeyboard,
    private mount: number,
  ) {}

  /** A handle from an earlier mount, which browsers treat differently. */
  private get stale() {
    return this.mount !== this.keyboard.mountCount;
  }

  private half(): FakeHalf {
    const half = this.keyboard.mounted;
    if (!half || (this.stale && this.keyboard.remount === "fails")) throw gone("The drive");
    return half;
  }

  async queryPermission() {
    return "granted" as PermissionState;
  }

  async getFileHandle(name: string, options?: { create?: boolean }) {
    const half = this.half();
    if (name === "INFO_UF2.TXT") {
      return {
        getFile: async () => ({
          text: async () => "UF2 Bootloader 0.4.0\nModel: ADV360PRO\nBoard-ID: nRF52840-ADV360PRO-v1\n",
        }),
        createWritable: async () => {
          throw new DOMException("read only", "NoModificationAllowedError");
        },
      };
    }
    if (!options?.create) throw gone(name);
    return {
      getFile: async () => ({ text: async () => "" }),
      createWritable: async () => {
        // Chrome on macOS reads through a stale handle but won't write.
        if (this.stale && this.keyboard.remount === "read-only") {
          this.keyboard.refusedWrites++;
          throw new DOMException(
            "An operation that depends on state cached in an interface object was made but the state had changed since it was read from disk.",
            "InvalidStateError",
          );
        }
        return this.writable(half);
      },
    };
  }

  private writable(half: FakeHalf) {
    return {
        write: async (data: Uint8Array) => {
          // The bootloader restarts as soon as it has the last block.
          setTimeout(() => half.takeFirmware(data), 5);
        },
        close: async () => {
          await new Promise((r) => setTimeout(r, 10));
          throw gone("The file");
        },
    };
  }
}

/** Some other folder the user might pick by mistake. */
export const notADrive: DriveLike = {
  name: "Downloads",
  async getFileHandle() {
    throw gone("INFO_UF2.TXT");
  },
};

export class FakeKeyboard implements SerialLike {
  readonly left: FakeHalf;
  readonly right: FakeHalf;
  readonly allowed = new Set<FakePort>();
  /** What a drive handle from an earlier update mode can still do. */
  remount: "works" | "fails" | "read-only" = "works";
  refusedWrites = 0;
  mounted: FakeHalf | null = null;
  mountCount = 0;
  pickerOpened = 0;
  private listeners: Record<string, (() => void)[]> = { connect: [], disconnect: [] };

  constructor(options: { left: { build: string | null; studio?: boolean }; right: { build: string | null } }) {
    this.left = new FakeHalf(this, "left", options.left);
    this.right = new FakeHalf(this, "right", options.right);
  }

  /** As if the user allowed every port the halves have right now. */
  allowAll() {
    for (const half of [this.left, this.right]) for (const port of half.ports()) this.allowed.add(port);
  }

  mount(half: FakeHalf) {
    this.mounted = half;
    this.mountCount++;
  }

  unmount() {
    this.mounted = null;
  }

  fire(type: "connect" | "disconnect") {
    for (const l of this.listeners[type]) l();
  }

  // SerialLike

  async getPorts() {
    return [...this.left.ports(), ...this.right.ports()].filter((p) => this.allowed.has(p));
  }

  async requestPort() {
    // The user picks the first port they haven't allowed yet.
    const port = [...this.left.ports(), ...this.right.ports()].find((p) => !this.allowed.has(p));
    if (!port) throw new DOMException("No port selected by the user.", "NotFoundError");
    this.allowed.add(port);
    setTimeout(() => this.fire("connect"), 1);
    return port;
  }

  addEventListener(type: "connect" | "disconnect", listener: () => void) {
    this.listeners[type].push(listener);
  }

  /** window.showDirectoryPicker: the user picks ADV360PRO, or `instead`. */
  picker(instead?: () => DriveLike) {
    return async () => {
      this.pickerOpened++;
      if (instead) return instead();
      if (!this.mounted) throw new DOMException("The user aborted a request.", "AbortError");
      return new FakeDrive(this, this.mountCount);
    };
  }
}
