// A simulated Advantage 360 Pro for tests. Each half has Web Serial ports
// that speak Tandem's protocol, and restarts into update mode when its Tandem
// port opens at 1200 baud. In update mode it has a drive that takes a UF2, and
// a bootloader port that takes the same firmware over serial DFU. Ports only
// show up once "the user" has allowed them.

import { crc16 } from "../../src/engine/dfu";
import type { DriveLike } from "../../src/engine/serial-keyboard";
import type { PortLike, SerialLike } from "../../src/engine/serial";
import { uf2ToImage } from "../../src/engine/uf2";

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
          if (command === "boot right" && this.half.side === "left" && this.half.protocol >= 3) {
            const right = this.half.keyboard.right;
            const ok = right.linked && right.mode === "app";
            this.controller?.enqueue(enc(`{"tandem":3,"boot":"right","ok":${ok}}\n`));
            if (ok && !right.ignoresRelay) setTimeout(() => right.enterUpdateMode(), 20);
          }
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

const u32 = (b: number[], at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

/** A half's bootloader port in update mode: SLIP-framed DFU packets, each acknowledged. */
export class FakeBootPort implements PortLike {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  /** Never acknowledge, to test falling back to the drive. */
  silent = false;

  constructor(readonly half: FakeHalf) {}

  getInfo() {
    return { usbVendorId: 0x239a, usbProductId: 0x00b3 };
  }

  async open() {
    if (!this.half.ports().includes(this)) throw new DOMException("The device has been lost.", "NetworkError");
    if (this.readable) throw new DOMException("The port is already open.", "InvalidStateError");
    this.readable = new ReadableStream({ start: (c) => void (this.controller = c) });
    let raw: number[] = [];
    let image: number[] = [];
    let size = 0;
    let expectedCrc = -1;
    this.writable = new WritableStream({
      write: (chunk) => {
        raw.push(...chunk);
        for (;;) {
          const start = raw.indexOf(0xc0);
          const end = start < 0 ? -1 : raw.indexOf(0xc0, start + 1);
          if (end < 0) return;
          const body: number[] = [];
          for (let i = start + 1; i < end; i++) {
            if (raw[i] === 0xdb) body.push(raw[++i] === 0xdc ? 0xc0 : 0xdb);
            else body.push(raw[i]);
          }
          raw = raw.slice(end + 1);
          if (body.length < 6 || this.silent) continue;
          const length = (body[1] >> 4) | (body[2] << 4);
          const payload = body.slice(4, 4 + length);
          const seq = body[0] & 7;
          this.controller?.enqueue(new Uint8Array([0xc0, ((seq + 1) % 8) << 3, 0, 0, 0, 0xc0]));
          const type = u32(payload, 0);
          if (type === 3) {
            size = u32(payload, 16);
            image = [];
          } else if (type === 1) {
            expectedCrc = payload[16] | (payload[17] << 8);
          } else if (type === 4) {
            image.push(...payload.slice(4));
          } else if (type === 5 && image.length === size && crc16(image) === expectedCrc) {
            const data = new Uint8Array(image);
            setTimeout(() => this.half.takeImage(data), 10);
          }
        }
      },
    });
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
  protocol = 3;
  /** The right half's Bluetooth link to the left half. */
  linked = true;
  /** The left half says it sent the restart, but the right half never gets it. */
  ignoresRelay = false;
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
  readonly bootPort = new FakeBootPort(this);

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
    const right = this.keyboard.right;
    const peripheral = this.side === "left" && this.protocol >= 3 ? { peripheral: right.linked && right.mode === "app" } : {};
    return { tandem: this.protocol, role: this.side === "left" ? "central" : "peripheral", name: "Adv360 Pro", build: this.build, repo: "octocat/adv360", ...peripheral };
  }

  ports(): PortLike[] {
    if (this.mode !== "app") return [this.bootPort];
    return [this.tandemPort, this.studioPort].filter((p): p is FakePort => !!p);
  }

  enterUpdateMode() {
    this.mode = "update";
    this.keyboard.mount(this);
    this.keyboard.fire("disconnect");
    setTimeout(() => this.keyboard.fire("connect"), 5);
  }

  /** The user's key combo, for a half without Tandem firmware. */
  pressCombo() {
    this.enterUpdateMode();
  }

  /** A UF2 copied onto the drive. */
  takeFirmware(uf2: Uint8Array) {
    this.takeImage(uf2ToImage(uf2).data);
  }

  /** The plain firmware image, from the drive or over DFU. */
  takeImage(image: Uint8Array) {
    const text = new TextDecoder().decode(image).replace(/\0+$/, "");
    this.flashedWith = text;
    const m = /^(left|right)-\w+:(\w+)/.exec(text);
    if (m && !this.rejectsFirmware) {
      this.build = m[2];
      this.protocol = this.keyboard.newProtocol;
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
  readonly allowed = new Set<PortLike>();
  /** What a drive handle from an earlier update mode can still do. */
  remount: "works" | "fails" | "read-only" = "works";
  refusedWrites = 0;
  mounted: FakeHalf | null = null;
  mountCount = 0;
  pickerOpened = 0;
  /** The next this many port picks land on a port that's already allowed, like a wrong pick in Chrome's list. */
  wrongPicks = 0;
  /** The Tandem protocol that new firmware speaks. 3 lets the left half restart the right half. */
  newProtocol = 3;
  /**
   * Chrome on macOS: allowing one port of a half allows its other ports too,
   * since it matches the USB device, not the port.
   */
  allowsSiblings = false;
  /** The half whose port the user looks for in Chrome's list, by the name Tandem gave. Without it, the first new port. */
  lookingFor: "left" | "right" | null = null;
  private listeners: Record<string, (() => void)[]> = { connect: [], disconnect: [] };

  constructor(options: { left: { build: string | null; studio?: boolean }; right: { build: string | null } }) {
    this.left = new FakeHalf(this, "left", options.left);
    this.right = new FakeHalf(this, "right", options.right);
  }

  /** As if the user allowed every port the halves have right now. */
  allowAll() {
    for (const half of [this.left, this.right]) for (const port of half.ports()) this.allowed.add(port);
  }

  /** As if the user allowed both halves' update ports on an earlier visit. */
  allowUpdatePorts() {
    this.allowed.add(this.left.bootPort);
    this.allowed.add(this.right.bootPort);
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

  isAllowed(p: PortLike): boolean {
    if (this.allowed.has(p)) return true;
    if (!this.allowsSiblings || !(p instanceof FakePort)) return false;
    return p.half.ports().some((q) => q !== p && q instanceof FakePort && this.allowed.has(q));
  }

  async getPorts() {
    return [...this.left.ports(), ...this.right.ports()].filter((p) => this.isAllowed(p));
  }

  async requestPort(options?: { filters?: { usbVendorId?: number; usbProductId?: number }[] }) {
    // Chrome lists the ports that match a filter. The user picks the first one they haven't allowed yet.
    const matches = (p: PortLike) =>
      !options?.filters?.length ||
      options.filters.some((f) => (f.usbVendorId === undefined || f.usbVendorId === p.getInfo().usbVendorId) && (f.usbProductId === undefined || f.usbProductId === p.getInfo().usbProductId));
    let present = [...this.left.ports(), ...this.right.ports()].filter(matches);
    // Chrome keeps its list open and adds ports as they show up. For update
    // ports, which only exist in update mode, wait a moment like a user would.
    const bootloader = options?.filters?.some((f) => f.usbVendorId === 0x239a);
    for (let waited = 0; bootloader && waited < 3000 && !present.some((p) => !this.isAllowed(p)); waited += 5) {
      await new Promise((r) => setTimeout(r, 5));
      present = [...this.left.ports(), ...this.right.ports()].filter(matches);
    }
    if (this.wrongPicks > 0) {
      const paired = present.find((p) => this.isAllowed(p));
      if (paired) {
        this.wrongPicks--;
        return paired;
      }
    }
    const fresh = present.filter((p) => !this.isAllowed(p));
    const wanted = this.lookingFor && this[this.lookingFor].ports();
    const port = fresh.find((p) => wanted?.includes(p)) ?? fresh[0];
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
