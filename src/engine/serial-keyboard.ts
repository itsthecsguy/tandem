// The keyboard over Web Serial, for Chrome and Edge.
//
// The browser only shows ports the user has allowed, so a first visit asks
// once per port. A half running Tandem firmware says which half it is. A half
// on other firmware may have no port at all: Kinesis's right half has none,
// and its left half only has ZMK Studio's.
//
// Flashing goes right half first, as the helper does. Each half restarts into
// update mode by itself if it runs Tandem firmware, or with its key combo if
// not. Then the user points the browser at the drive that appears, once: the
// browser can keep that permission, and Tandem tries the same drive first
// next time. After copying, the half must come back reporting the new build.

import type { DevicesStatus, HalfStatus, JobAction, Side } from "../../shared/types";
import type { Build } from "./builds";
import type { Flash } from "./jobs";
import { type KeyboardAccess, emptyHalf, noKeyboard } from "./keyboard";
import { KINESIS_LAYOUT } from "./kinesis";
import { manualFlash } from "./manual";
import { answer, isWaiting, waitFor } from "./prompts";
import { KINESIS_VID, type PortLike, type SerialLike, type TandemInfo, askInfo, readTandemKeymap, restartToBootloader } from "./serial";
import { loadDrive, saveDrive } from "./store";
import { sleep } from "./util";
import { parseKeymap, toKeymap } from "../../shared/keymap";

/** The parts of a FileSystemDirectoryHandle that Tandem uses. */
export interface DriveLike {
  readonly name: string;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<{
    getFile(): Promise<{ text(): Promise<string> }>;
    createWritable(): Promise<{ write(data: Uint8Array): Promise<void>; close(): Promise<void> }>;
  }>;
  queryPermission?(descriptor: { mode: "readwrite" }): Promise<PermissionState>;
}

export interface Deps {
  serial: SerialLike;
  /** window.showDirectoryPicker. Without it, updates end with copying by hand. */
  pickDirectory?: (options: { id: string; mode: "readwrite"; startIn?: DriveLike }) => Promise<DriveLike>;
  loadDrive?: () => Promise<DriveLike | null>;
  saveDrive?: (drive: DriveLike) => Promise<void>;
  /** How long to try the last drive before asking, and to wait for a half to come back. */
  timing?: { savedDriveMs: number; comebackMs: number; newPortMs: number; pollMs: number; infoMs: number };
}

const UNLOCK_WAIT_MS = 120_000;

// The Studio client and its protobuf code are large, and only needed for
// keyboards without Tandem firmware, so they load on first use.
const studio = () => import("./studio-web");
const SIDES: Side[] = ["right", "left"];
const sideOf = (info: TandemInfo): Side => (info.role === "central" ? "left" : "right");

function browserDeps(): Deps | null {
  if (typeof navigator === "undefined" || !("serial" in navigator)) return null;
  const picker = (window as unknown as { showDirectoryPicker?: Deps["pickDirectory"] }).showDirectoryPicker;
  return {
    serial: (navigator as unknown as { serial: SerialLike }).serial,
    pickDirectory: picker && ((options) => picker.call(window, options)),
    loadDrive: () => loadDrive<DriveLike>(),
    saveDrive: (drive) => saveDrive(drive),
  };
}

/** Web Serial where the browser has it, or nothing to talk to. */
export function keyboardAccess(deps: Deps | null = browserDeps()): KeyboardAccess {
  if (!deps) return noKeyboard();
  const { serial, pickDirectory } = deps;
  const timing = deps.timing ?? { savedDriveMs: 8000, comebackMs: 25_000, newPortMs: 6000, pollMs: 500, infoMs: 700 };

  // What each allowed port said about itself. Ports that didn't answer are
  // other firmware's, such as ZMK Studio's.
  const known = new Map<PortLike, TandemInfo | null>();
  const busy = new Set<PortLike>();
  const watchers = new Set<(d: DevicesStatus) => void>();
  let devices = compute();
  let last = JSON.stringify(devices);
  let drive: DriveLike | null = null;
  void deps.loadDrive?.().then((d) => (drive ??= d)).catch(() => {});

  function tandemPort(side: Side): [PortLike, TandemInfo] | null {
    for (const [port, info] of known) if (info && sideOf(info) === side) return [port, info];
    return null;
  }

  function otherPorts(): PortLike[] {
    return [...known].filter(([, info]) => !info).map(([port]) => port);
  }

  function compute(): DevicesStatus {
    const half = (side: Side): HalfStatus => {
      const found = tandemPort(side);
      if (found) {
        const [, info] = found;
        return { ...emptyHalf(side), mode: "app", autoflash: true, build: info.build, repo: info.repo || null, protocol: info.tandem, port: "web-serial" };
      }
      // Only the left half has a second port, for ZMK Studio.
      if (side === "left" && otherPorts().length) return { ...emptyHalf(side), mode: "app", otherPorts: otherPorts().map(() => "web-serial") };
      return emptyHalf(side);
    };
    const left = half("left");
    const right = half("right");
    return { left, right, unknownBootloaders: [], needsAccess: !left.autoflash || !right.autoflash, scannedAt: new Date().toISOString() };
  }

  /** A port that just connected may need a moment before it answers. */
  async function probe(port: PortLike): Promise<TandemInfo | null> {
    for (let i = 0; i < 3; i++) {
      const info = await askInfo(port, timing.infoMs);
      if (info) return info;
      await sleep(timing.pollMs);
    }
    return null;
  }

  let inflight: Promise<DevicesStatus> | null = null;

  function refresh(): Promise<DevicesStatus> {
    inflight ??= (async () => {
      const ports = (await serial.getPorts()).filter((p) => p.getInfo().usbVendorId === KINESIS_VID);
      for (const port of [...known.keys()]) if (!ports.includes(port)) known.delete(port);
      for (const port of ports) {
        if (known.has(port) || busy.has(port)) continue;
        known.set(port, await probe(port));
      }
      devices = compute();
      const now = JSON.stringify({ ...devices, scannedAt: "" });
      if (now !== last) {
        last = now;
        for (const w of watchers) w(devices);
      }
      return devices;
    })().finally(() => (inflight = null));
    return inflight;
  }

  serial.addEventListener("connect", () => void refresh());
  serial.addEventListener("disconnect", () => void refresh());
  void refresh();

  // Drives.

  async function isUpdateDrive(d: DriveLike): Promise<boolean> {
    try {
      if (d.queryPermission && (await d.queryPermission({ mode: "readwrite" })) !== "granted") return false;
      const info = await (await (await d.getFileHandle("INFO_UF2.TXT")).getFile()).text();
      return /ADV360PRO/.test(info);
    } catch {
      return false;
    }
  }

  async function pollSaved(signal: AbortSignal, ms = Infinity): Promise<DriveLike | null> {
    const deadline = Date.now() + ms;
    while (drive && Date.now() < deadline) {
      if (await isUpdateDrive(drive)) return drive;
      await sleep(timing.pollMs, signal);
    }
    return null;
  }

  /** The half's update drive: the last one if the browser still allows it, or whichever the user picks. */
  async function findDrive(side: Side, restarted: boolean, emit: Parameters<Flash>[1], signal: AbortSignal): Promise<DriveLike> {
    if (restarted && drive) {
      const saved = await pollSaved(signal, timing.savedDriveMs);
      if (saved) return saved;
    }
    emit({ type: "drive", side });
    const done = new AbortController();
    const stop = () => done.abort(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    const never = new Promise<never>(() => {});
    try {
      const picked = waitFor<DriveLike>({ type: "pick-drive", side }, done.signal);
      const saved = pollSaved(done.signal).then((d) => d ?? never);
      // Whichever loses is abandoned below. Keep its rejection quiet.
      picked.catch(() => {});
      saved.catch(() => {});
      return await Promise.race([picked, saved]);
    } finally {
      signal.removeEventListener("abort", stop);
      done.abort();
      emit({ type: "drive-done", side });
    }
  }

  async function copyFirmware(d: DriveLike, side: Side, data: Uint8Array) {
    const file = await d.getFileHandle(`tandem-${side}.uf2`, { create: true });
    const writable = await file.createWritable();
    await writable.write(data);
    // The half restarts as soon as it has every block, which can cut the
    // browser's last step short. The check that follows tells if it worked.
    await writable.close().catch(() => {});
  }

  /** Waits for the half to report a build. Returns what it last said, if anything. */
  async function comeback(side: Side, build: string, ms: number, signal: AbortSignal): Promise<TandemInfo | null> {
    const deadline = Date.now() + ms;
    let seen: TandemInfo | null = null;
    while (Date.now() < deadline) {
      await refresh();
      seen = tandemPort(side)?.[1] ?? seen;
      if (seen?.build === build) return seen;
      await sleep(timing.pollMs, signal);
    }
    return seen;
  }

  async function flashHalf(side: Side, build: Build, emit: Parameters<Flash>[1], signal: AbortSignal): Promise<boolean> {
    const step = `flash-${side}` as const;
    const found = tandemPort(side);
    if (found) {
      emit({ type: "step", step, state: "active", detail: "Restarting into update mode" });
      busy.add(found[0]);
      try {
        await restartToBootloader(found[0]);
      } finally {
        busy.delete(found[0]);
      }
    } else {
      emit({ type: "step", step, state: "active", detail: "Waiting for update mode" });
      emit({ type: "manual", side, reason: "no-autoflash" });
    }

    const d = await findDrive(side, !!found, emit, signal);
    if (!found) emit({ type: "manual-done", side });
    emit({ type: "step", step, state: "active", detail: "Copying firmware" });
    await copyFirmware(d, side, build[side]);
    emit({ type: "step", step, state: "active", detail: "Restarting" });

    // A half that had no Tandem port comes back with one the browser hasn't
    // been allowed to open, so don't wait long before asking.
    let back = await comeback(side, build.id, found ? timing.comebackMs : timing.newPortMs, signal);
    if (!back && !found) {
      emit({ type: "grant-port", side });
      const granted = await waitFor<boolean>({ type: "grant-port", side }, signal);
      emit({ type: "grant-port-done", side });
      if (granted) back = await comeback(side, build.id, timing.comebackMs, signal);
    }
    if (back && back.build !== build.id) throw new Error(`The ${side} half is running build ${back.build}, expected ${build.id}.`);
    emit({ type: "step", step, state: "done", detail: back ? `Running ${build.id}` : "Copied, but the browser couldn't ask it" });
    return !!back;
  }

  const flash: Flash = async (build, emit, signal) => {
    emit({ type: "step", step: "prepare", state: "active", detail: "Looking for both halves" });
    const d = await refresh();
    const tandem = SIDES.filter((s) => d[s].autoflash);
    emit({
      type: "step",
      step: "prepare",
      state: "done",
      detail: tandem.length === 2 ? "Both halves run Tandem firmware" : tandem.length ? `The ${tandem[0]} half runs Tandem firmware` : "Neither half runs Tandem firmware yet",
    });
    let checked = true;
    for (const side of SIDES) checked = (await flashHalf(side, build, emit, signal)) && checked;
    emit({ type: "step", step: "verify", state: checked ? "done" : "skipped", detail: checked ? `Both halves run ${build.id}` : "The browser couldn't ask every half" });
    return checked;
  };

  const isMissing = (e: unknown) => e instanceof Error && (e.name === "NotFoundError" || e.name === "AbortError");

  return {
    caps: { keyboard: true, flash: !!pickDirectory },
    devices: () => devices,
    watch(listener) {
      watchers.add(listener);
      return () => watchers.delete(listener);
    },
    async info() {
      const d = await refresh();
      const tandemKeymap = d.left.autoflash && d.left.protocol >= 2;
      const others = otherPorts();
      const status = !tandemKeymap && others.length ? await studio().then((s) => s.studioStatus(others)).catch(() => null) : null;
      return { left: d.left, right: d.right, tandemKeymap, tandemRepo: d.left.repo, studio: status, layout: KINESIS_LAYOUT.keys };
    },
    async readLayout() {
      await refresh();
      const left = tandemPort("left");
      if (left && left[1].tandem >= 2) {
        const text = await readTandemKeymap(left[0]);
        const layers = toKeymap(parseKeymap(text)).layers.map(({ name, bindings }) => ({ name, bindings }));
        return { layout: { source: "tandem", layers, unknown: [], layout: KINESIS_LAYOUT.keys }, keymapText: text };
      }
      const others = otherPorts();
      if (!others.length) throw new Error("Connect the left half and allow its port first.");
      const imported = await (await studio()).readStudioLayout(others, UNLOCK_WAIT_MS);
      return { layout: { source: "studio", ...imported, layout: KINESIS_LAYOUT.keys } };
    },
    async connect() {
      try {
        await serial.requestPort({ filters: [{ usbVendorId: KINESIS_VID }] });
      } catch (e) {
        if (isMissing(e)) return;
        throw e;
      }
      await refresh();
    },
    flash: pickDirectory ? flash : manualFlash,
    async act(action: JobAction) {
      if (action.type === "pick-drive") {
        if (!isWaiting(action) || !pickDirectory) return;
        let picked: DriveLike;
        try {
          picked = await pickDirectory({ id: "adv360-drive", mode: "readwrite", ...(drive ? { startIn: drive } : {}) });
        } catch (e) {
          if (isMissing(e)) return;
          // A saved drive that's gone can make startIn fail. Ask without it.
          picked = await pickDirectory({ id: "adv360-drive", mode: "readwrite" });
        }
        if (!(await isUpdateDrive(picked))) {
          throw new Error(`"${picked.name}" isn't a keyboard half's update drive. Choose the drive named ADV360PRO.`);
        }
        drive = picked;
        await deps.saveDrive?.(picked).catch(() => {});
        answer(action, picked);
      } else if (action.type === "grant-port") {
        if (!isWaiting(action)) return;
        try {
          await serial.requestPort({ filters: [{ usbVendorId: KINESIS_VID }] });
          answer(action, true);
        } catch (e) {
          if (!isMissing(e)) throw e;
          answer(action, false);
        }
      } else {
        answer(action);
      }
    },
  };
}
