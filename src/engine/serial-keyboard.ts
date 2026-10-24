// The keyboard over Web Serial, for Chrome and Edge.
//
// The browser only shows ports the user has allowed, so a first visit asks
// once per port. A half running Tandem firmware says which half it is. A half
// on other firmware may have no port at all: Kinesis's right half has none,
// and its left half only has ZMK Studio's.
//
// Flashing goes right half first, as the helper does. Each half restarts into
// update mode by itself if it runs Tandem firmware, or with its key combo if
// not. In update mode its bootloader opens a serial port, and Tandem sends the
// firmware over it (see dfu.ts). Chrome asks once per half before a page may
// open that port and remembers the answer, so later updates need no clicks.
// The bootloader's drive is the fallback. After flashing, the half must come
// back reporting the new build.

import type { DevicesStatus, HalfStatus, JobAction, Side } from "../../shared/types";
import type { Build } from "./builds";
import type { Flash } from "./jobs";
import { type KeyboardAccess, emptyHalf, noKeyboard } from "./keyboard";
import { KINESIS_LAYOUT } from "./kinesis";
import { manualFlash } from "./manual";
import { answer, isWaiting, waitFor } from "./prompts";
import { DFU_TIMING, type DfuTiming, dfuFlash } from "./dfu";
import { BOOTLOADER, KINESIS_VID, type PortLike, type SerialLike, type TandemInfo, askInfo, readTandemKeymap, restartToBootloader } from "./serial";
import { loadDrive, loadDriveReuse, saveDrive, saveDriveReuse } from "./store";
import { uf2ToImage } from "./uf2";
import { sleep, withTimeout } from "./util";
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
  saveDrive?: (drive: DriveLike | null) => Promise<void>;
  /** Whether trying the saved drive again is worth it in this browser. */
  driveReuse?: { load(): boolean; save(on: boolean): void };
  /** How long to wait for things: the saved drive, a restarting half, its update port. */
  timing?: Partial<Timing>;
}

interface Timing {
  savedDriveMs: number;
  comebackMs: number;
  newPortMs: number;
  pollMs: number;
  infoMs: number;
  /** How long a restarted half's update port takes to show up. */
  bootMs: number;
  dfu: DfuTiming;
}

const TIMING: Timing = { savedDriveMs: 8000, comebackMs: 25_000, newPortMs: 6000, pollMs: 500, infoMs: 700, bootMs: 6000, dfu: DFU_TIMING };

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
    driveReuse: { load: loadDriveReuse, save: saveDriveReuse },
  };
}

/** Web Serial where the browser has it, or nothing to talk to. */
export function keyboardAccess(deps: Deps | null = browserDeps()): KeyboardAccess {
  if (!deps) return noKeyboard();
  const { serial, pickDirectory } = deps;
  const timing: Timing = { ...TIMING, ...deps.timing };

  // What each allowed port said about itself, and when. A port that didn't
  // answer is asked again later: it may be ZMK Studio's, which never will, or
  // a half that was still starting up.
  const known = new Map<PortLike, { info: TandemInfo | null; at: number }>();
  const busy = new Set<PortLike>();
  const watchers = new Set<(d: DevicesStatus) => void>();
  let devices = compute();
  let last = JSON.stringify(devices);
  let drive: DriveLike | null = null;
  const { driveReuse, saveDrive: keepDrive } = deps;
  let reuseDrive = driveReuse?.load() ?? true;
  if (reuseDrive) void deps.loadDrive?.().then((d) => (drive ??= d)).catch(() => {});

  /** Chrome refused to write through the saved drive. Stop trying it, here and next time. */
  function giveUpOnSavedDrive() {
    drive = null;
    reuseDrive = false;
    driveReuse?.save(false);
    void keepDrive?.(null).catch(() => {});
  }

  function tandemPort(side: Side): [PortLike, TandemInfo] | null {
    for (const [port, { info }] of known) if (info && sideOf(info) === side) return [port, info];
    return null;
  }

  function otherPorts(): PortLike[] {
    return [...known].filter(([, { info }]) => !info).map(([port]) => port);
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

  /** Keeps probes off ports a Studio session holds, which can be minutes while it waits for the unlock key. */
  async function withStudioPorts<T>(ports: PortLike[], fn: () => Promise<T>): Promise<T> {
    for (const p of ports) busy.add(p);
    try {
      return await fn();
    } finally {
      for (const p of ports) busy.delete(p);
    }
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
  const REASK_MS = 5000;

  /** Asks new ports what they are, and silent ones again. `force` asks silent ones now. */
  function refresh(force = false): Promise<DevicesStatus> {
    if (force && inflight) return inflight.then(() => refresh(true));
    inflight ??= (async () => {
      const ports = (await serial.getPorts()).filter((p) => p.getInfo().usbVendorId === KINESIS_VID);
      for (const port of [...known.keys()]) if (!ports.includes(port)) known.delete(port);
      for (const port of ports) {
        const seen = known.get(port);
        if (busy.has(port) || seen?.info) continue;
        if (seen && !force && Date.now() - seen.at < REASK_MS) continue;
        const info = seen ? await askInfo(port, timing.infoMs) : await probe(port);
        known.set(port, { info, at: Date.now() });
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

  /** A drive the user just chose may still be mounting. Give it a few seconds. */
  async function becomesUpdateDrive(d: DriveLike, ms = 4000): Promise<boolean> {
    const deadline = Date.now() + ms;
    for (;;) {
      if (await isUpdateDrive(d)) return true;
      if (Date.now() > deadline) return false;
      await sleep(Math.min(timing.pollMs, 400));
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

  interface Found {
    drive: DriveLike;
    /** The user chose it just now, as opposed to the drive saved from before. */
    picked: boolean;
  }

  /** Copies the firmware, asking for the drive again if Chrome won't write through the saved one. */
  async function copyTo(found: Found, side: Side, data: Uint8Array, emit: Parameters<Flash>[1], signal: AbortSignal) {
    try {
      await copyFirmware(found.drive, side, data);
      return;
    } catch (err) {
      if (found.picked) {
        throw new Error(`The browser couldn't write to ${found.drive.name} (${(err as Error).message}). Unplug the ${side} half's cable, plug it back in, and update again.`);
      }
    }
    // Nothing was written: the browser refuses before the first byte.
    giveUpOnSavedDrive();
    emit({ type: "drive", side });
    const picked = await waitFor<DriveLike>({ type: "pick-drive", side }, signal);
    emit({ type: "drive-done", side });
    emit({ type: "step", step: `flash-${side}`, state: "active", detail: "Copying firmware" });
    await copyTo({ drive: picked, picked: true }, side, data, emit, signal);
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
      await withTimeout(refresh(), 5000, "Looking for the half").catch(() => {});
      seen = tandemPort(side)?.[1] ?? seen;
      if (seen?.build === build) return seen;
      await sleep(timing.pollMs, signal);
    }
    return seen;
  }

  /** Ports of halves in update mode that the browser may open. */
  async function bootPorts(): Promise<PortLike[]> {
    const ports = await serial.getPorts().catch(() => []);
    return ports.filter((p) => {
      const info = p.getInfo();
      return info.usbVendorId === BOOTLOADER.usbVendorId && info.usbProductId === BOOTLOADER.usbProductId;
    });
  }

  /** Waits up to `ms` for an update port the browser may open. */
  async function waitForBootPort(ms: number, signal: AbortSignal): Promise<PortLike | null> {
    const deadline = Date.now() + ms;
    for (;;) {
      const [port] = await bootPorts();
      if (port) return port;
      if (Date.now() >= deadline) return null;
      await sleep(timing.pollMs, signal);
    }
  }

  /** A half is visible: its Tandem port, or for the left half, ZMK Studio's. */
  function visible(side: Side): boolean {
    return !!tandemPort(side) || (side === "left" && otherPorts().length > 0);
  }

  type Method = { kind: "serial"; port: PortLike } | { kind: "drive"; found: Found };

  /**
   * How to get the firmware onto a half in update mode. Its update port, if
   * the browser may open it, needs no clicks. Otherwise the user allows that
   * port once, which Chrome remembers, or chooses the drive instead.
   */
  async function updateMethod(side: Side, restarted: boolean, emit: Parameters<Flash>[1], signal: AbortSignal): Promise<Method> {
    const port = await waitForBootPort(restarted ? timing.bootMs : 0, signal);
    if (port) return { kind: "serial", port };

    emit({ type: "update-port", side });
    const done = new AbortController();
    const stop = () => done.abort(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    const never = new Promise<never>(() => {});
    try {
      const allowed = waitFor<boolean>({ type: "grant-update-port", side }, done.signal).then(async () => {
        const p = await waitForBootPort(3000, done.signal);
        return p ? ({ kind: "serial", port: p } as Method) : never;
      });
      const picked = waitFor<DriveLike>({ type: "pick-drive", side }, done.signal).then((d) => ({ kind: "drive", found: { drive: d, picked: true } }) as Method);
      // Allowed before, say on an earlier try: it shows up once the half is in update mode.
      const appears = waitForBootPort(Infinity, done.signal).then((p) => (p ? ({ kind: "serial", port: p } as Method) : never));
      // In browsers that keep drive handles across remounts, the last drive works too.
      const saved = (drive && reuseDrive ? pollSaved(done.signal) : never).then((d) =>
        d ? ({ kind: "drive", found: { drive: d, picked: false } } as Method) : never,
      );
      for (const p of [allowed, picked, appears, saved]) p.catch(() => {});
      return await Promise.race([allowed, picked, appears, saved]);
    } finally {
      signal.removeEventListener("abort", stop);
      done.abort();
      emit({ type: "update-port-done", side });
    }
  }

  /** Sends the firmware over the half's update port, reporting progress. */
  async function sendOverSerial(port: PortLike, side: Side, uf2: Uint8Array, emit: Parameters<Flash>[1]) {
    const step = `flash-${side}` as const;
    let shown = -1;
    await dfuFlash(
      port,
      uf2ToImage(uf2).data,
      (fraction) => {
        const tenth = Math.floor(fraction * 10);
        if (tenth === shown) return;
        shown = tenth;
        emit({ type: "step", step, state: "active", detail: `Sending firmware ${tenth * 10}%` });
      },
      timing.dfu,
    );
  }

  async function flashHalf(
    side: Side,
    build: Build,
    emit: Parameters<Flash>[1],
    signal: AbortSignal,
    /** How to reach the half, when it's already in update mode. */
    ready: Method | null,
    /** Halves that ran Tandem firmware when the update started. */
    tandemAtStart: Side[],
  ): Promise<boolean> {
    const step = `flash-${side}` as const;
    let found = ready ? null : tandemPort(side);
    // The browser can't see a port nobody allowed. When the other half
    // already ran Tandem firmware, this one probably does too, so ask for its
    // port before falling back to a key combo. Not during first-time setup,
    // when neither half had it.
    const other = side === "left" ? "right" : "left";
    if (!ready && !found && tandemAtStart.includes(other)) {
      emit({ type: "step", step, state: "active", detail: "Waiting for its port" });
      emit({ type: "grant-port", side, before: true });
      const granted = await waitFor<boolean>({ type: "grant-port", side }, signal);
      emit({ type: "grant-port-done", side });
      if (granted) found = tandemPort(side) ?? ((await refresh(true)) && tandemPort(side));
    }

    const byHand = !ready && !found;
    const otherWasUp = visible(other);
    if (ready) {
      emit({ type: "step", step, state: "active", detail: "Already in update mode" });
    } else if (found) {
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

    const method = ready ?? (await updateMethod(side, !!found, emit, signal));
    if (byHand) {
      // Both halves' update modes look the same. Make sure the user's key
      // combo went to this half, not the other one.
      await refresh(true);
      if (otherWasUp && !visible(other)) {
        throw new Error(`The ${other} half went into update mode instead of the ${side} half. Press the ${other} half's reset button once, then update again.`);
      }
      emit({ type: "manual-done", side });
    }

    if (method.kind === "serial") {
      emit({ type: "step", step, state: "active", detail: "Sending firmware" });
      try {
        await sendOverSerial(method.port, side, build[side], emit);
      } catch (err) {
        // The half is still in update mode, so its drive works as a fallback.
        emit({ type: "step", step, state: "active", detail: `Sending over the update port failed (${(err as Error).message}). Copy it to the drive instead.` });
        emit({ type: "drive", side });
        const picked = await waitFor<DriveLike>({ type: "pick-drive", side }, signal);
        emit({ type: "drive-done", side });
        emit({ type: "step", step, state: "active", detail: "Copying firmware" });
        await copyTo({ drive: picked, picked: true }, side, build[side], emit, signal);
      }
    } else {
      emit({ type: "step", step, state: "active", detail: "Copying firmware" });
      await copyTo(method.found, side, build[side], emit, signal);
    }
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
    const d = await refresh(true);
    const tandem = SIDES.filter((s) => d[s].autoflash);
    emit({
      type: "step",
      step: "prepare",
      state: "done",
      detail: tandem.length === 2 ? "Both halves run Tandem firmware" : tandem.length ? `The ${tandem[0]} half runs Tandem firmware` : "Neither half runs Tandem firmware yet",
    });

    // A half left in update mode, say by a reload mid-update, shows its update
    // port, or its drive. Both halves look the same in update mode, so it only
    // counts when the other half is plainly running.
    let waiting: { side: Side; method: Method } | null = null;
    const [bootPort] = await bootPorts();
    const savedDrive = !bootPort && drive && reuseDrive && (await isUpdateDrive(drive)) ? drive : null;
    if (bootPort || savedDrive) {
      const silent = SIDES.filter((s) => !d[s].autoflash);
      if (silent.length !== 1) {
        throw new Error("One half is already in update mode, and Tandem can't tell which. Press that half's reset button once so it restarts, then update again.");
      }
      waiting = { side: silent[0], method: bootPort ? { kind: "serial", port: bootPort } : { kind: "drive", found: { drive: savedDrive!, picked: false } } };
    }

    let checked = true;
    const order = waiting ? [waiting.side, ...SIDES.filter((s) => s !== waiting!.side)] : SIDES;
    for (const side of order) {
      checked = (await flashHalf(side, build, emit, signal, side === waiting?.side ? waiting.method : null, tandem)) && checked;
    }
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
      const status = !tandemKeymap && others.length ? await withStudioPorts(others, () => studio().then((s) => s.studioStatus(others))).catch(() => null) : null;
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
      const imported = await withStudioPorts(others, async () => (await studio()).readStudioLayout(others, UNLOCK_WAIT_MS));
      return { layout: { source: "studio", ...imported, layout: KINESIS_LAYOUT.keys } };
    },
    async connect() {
      try {
        await serial.requestPort({ filters: [{ usbVendorId: KINESIS_VID }] });
      } catch (e) {
        if (isMissing(e)) return;
        throw e;
      }
      await refresh(true);
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
        // Only a drive with the right name is worth waiting for.
        if (!(await isUpdateDrive(picked)) && (picked.name !== "ADV360PRO" || !(await becomesUpdateDrive(picked)))) {
          throw new Error(
            picked.name === "ADV360PRO"
              ? "Tandem couldn't read ADV360PRO. The half may still be starting update mode. Wait until the drive shows up in Finder, then choose it again."
              : `"${picked.name}" isn't a keyboard half's update drive. Choose the drive named ADV360PRO.`,
          );
        }
        if (reuseDrive) {
          drive = picked;
          await keepDrive?.(picked).catch(() => {});
        }
        answer(action, picked);
      } else if (action.type === "grant-update-port") {
        if (!isWaiting(action)) return;
        try {
          await serial.requestPort({ filters: [BOOTLOADER] });
          answer(action, true);
        } catch (e) {
          // Nothing picked, say because the half isn't in update mode yet. Keep waiting.
          if (!isMissing(e)) throw e;
        }
      } else if (action.type === "grant-port") {
        if (!isWaiting(action)) return;
        if (action.skip) {
          answer(action, false);
          return;
        }
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
