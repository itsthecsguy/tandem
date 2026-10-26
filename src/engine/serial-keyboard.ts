// The keyboard over Web Serial, for Chrome and Edge.
//
// The browser only shows ports the user has allowed, so a first visit asks
// once per port. A half running Tandem firmware says which half it is. A half
// on other firmware may have no port at all: Kinesis's right half has none,
// and its left half only has ZMK Studio's.
//
// Flashing goes right half first, as the helper does. Each half restarts into
// update mode by itself if it runs Tandem firmware, or with its key combo if
// not. The right half needs no port of its own: the left half, on Tandem
// protocol 3, restarts it over the split link and says when it's back. In update mode its bootloader opens a serial port, and Tandem sends the
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
import {
  BOOTLOADER,
  KINESIS_VID,
  type PortLike,
  type SerialLike,
  type TandemInfo,
  askInfo,
  bootRightViaLeft,
  readTandemKeymap,
  restartToBootloader,
} from "./serial";
import { loadDrive, loadDriveReuse, loadRightBuild, loadUpdatePorts, saveDrive, saveDriveReuse, saveRightBuild, saveUpdatePorts } from "./store";
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
  /** The last build sent to the right half through the left half. */
  rightBuild?: { load(): string | null; save(build: string): void };
  /** Halves whose update port this browser has sent firmware over. */
  updatePorts?: { load(): Side[]; save(sides: Side[]): void };
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
  /**
   * How long to leave a half in update mode before sending. macOS mounts its
   * ADV360PRO drive in about 2 seconds, and a transfer that starts sooner
   * stalls the mount behind the flash erase until the bootloader stops
   * answering.
   */
  settleMs: number;
  /**
   * How long the right half may take to go once the left half restarts it.
   * The left half notices it gone after Bluetooth's supervision timeout,
   * about 4 seconds on ZMK.
   */
  relayMs: number;
  dfu: DfuTiming;
}

const TIMING: Timing = { savedDriveMs: 8000, comebackMs: 25_000, newPortMs: 6000, pollMs: 500, infoMs: 700, bootMs: 6000, settleMs: 3000, relayMs: 10_000, dfu: DFU_TIMING };

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
    rightBuild: { load: loadRightBuild, save: saveRightBuild },
    updatePorts: { load: loadUpdatePorts, save: saveUpdatePorts },
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
  let rightBuild = deps.rightBuild?.load() ?? null;
  const trusted = new Set<Side>(deps.updatePorts?.load() ?? []);
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

  /** The left half's Tandem port, when its firmware can restart the right half. */
  function relayPort(): [PortLike, TandemInfo] | null {
    const left = tandemPort("left");
    return left && left[1].tandem >= 3 ? left : null;
  }

  /** Asks the left half again, for whether the right half is connected to it now. */
  async function leftInfo(): Promise<TandemInfo | null> {
    const left = relayPort();
    if (!left) return null;
    busy.add(left[0]);
    try {
      const info = await askInfo(left[0], timing.infoMs);
      if (info) known.set(left[0], { info, at: Date.now() });
      return info;
    } finally {
      busy.delete(left[0]);
    }
  }

  /** Waits up to `ms` for the left half to say the right half is connected. */
  async function rightBackViaLeft(ms: number, signal: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + ms;
    for (;;) {
      if ((await leftInfo())?.peripheral) return true;
      if (Date.now() >= deadline) return false;
      await sleep(timing.pollMs, signal);
    }
  }

  /** Waits up to `ms` for the right half to go: its update port shows up, or the left half loses it. */
  async function rightWent(ms: number, signal: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + ms;
    for (;;) {
      if ((await bootPorts()).length) return true;
      if ((await leftInfo())?.peripheral === false) return true;
      if (Date.now() >= deadline) return false;
      await sleep(timing.pollMs, signal);
    }
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
      // The right half, through the left half's firmware.
      const left = side === "right" ? relayPort() : null;
      if (left && left[1].peripheral !== false) {
        const [, info] = left;
        return { ...emptyHalf(side), mode: "app", autoflash: true, build: rightBuild ?? info.build, repo: info.repo || null, protocol: info.tandem, port: "left half" };
      }
      return emptyHalf(side);
    };
    const left = half("left");
    const right = half("right");
    return {
      left,
      right,
      unknownBootloaders: [],
      needsAccess: !left.autoflash || !right.autoflash,
      updatePorts: [...trusted],
      scannedAt: new Date().toISOString(),
    };
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
        // The left half's answer includes whether the right half is connected,
        // which changes without any port coming or going, so a forced look asks it again.
        const relay = seen?.info?.role === "central" && seen.info.tandem >= 3;
        if (busy.has(port) || (seen?.info && !(force && relay))) continue;
        if (seen && !force && Date.now() - seen.at < REASK_MS) continue;
        const info = seen ? await askInfo(port, timing.infoMs) : await probe(port);
        known.set(port, { info: info ?? (relay ? seen.info : null), at: Date.now() });
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

  /** When each update port was first seen. A half that restarts brings a new one. */
  const bootSeen = new WeakMap<PortLike, number>();

  /** Ports of halves in update mode that the browser may open. */
  async function bootPorts(): Promise<PortLike[]> {
    const ports = await serial.getPorts().catch(() => []);
    const boot = ports.filter((p) => {
      const info = p.getInfo();
      return info.usbVendorId === BOOTLOADER.usbVendorId && info.usbProductId === BOOTLOADER.usbProductId;
    });
    for (const p of boot) if (!bootSeen.has(p)) bootSeen.set(p, Date.now());
    return boot;
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

  /** Waits up to `ms` for every half to leave update mode. */
  async function waitForNoBootPort(ms: number, signal: AbortSignal) {
    const deadline = Date.now() + ms;
    while ((await bootPorts()).length && Date.now() < deadline) await sleep(timing.pollMs, signal);
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
  async function sendOverSerial(port: PortLike, side: Side, uf2: Uint8Array, emit: Parameters<Flash>[1], signal: AbortSignal) {
    const step = `flash-${side}` as const;
    const wait = (bootSeen.get(port) ?? Date.now()) + timing.settleMs - Date.now();
    if (wait > 0) await sleep(wait, signal);
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
  ): Promise<{ flashed: Side; checked: boolean; newPort: boolean }> {
    let step = `flash-${side}` as const;
    let found = ready ? null : tandemPort(side);
    // Without a port of its own, the right half restarts through the left one,
    // once the two are connected. That works whatever firmware the right half
    // runs, as long as its keymap has &bootloader.
    let viaLeft = false;
    const relay = !ready && !found && side === "right" ? relayPort() : null;
    if (relay) {
      emit({ type: "step", step, state: "active", detail: "Waiting for it to connect to the left half" });
      if ((await leftInfo())?.peripheral || (await rightBackViaLeft(timing.comebackMs, signal))) {
        emit({ type: "step", step, state: "active", detail: "Restarting into update mode through the left half" });
        busy.add(relay[0]);
        try {
          viaLeft = await bootRightViaLeft(relay[0]);
        } finally {
          busy.delete(relay[0]);
        }
        // The left half only queues the restart, so make sure the right half
        // went before asking for anything.
        viaLeft &&= await rightWent(timing.relayMs, signal);
      }
    }
    // The browser can't see a port nobody allowed. When the other half
    // already ran Tandem firmware, this one probably does too, so ask for its
    // port before falling back to a key combo. Not during first-time setup,
    // when neither half had it.
    const other = side === "left" ? "right" : "left";
    if (!ready && !found && !viaLeft && tandemAtStart.includes(other)) {
      emit({ type: "step", step, state: "active", detail: "Waiting for its port" });
      emit({ type: "grant-port", side, before: true });
      const granted = await waitFor<boolean>({ type: "grant-port", side }, signal);
      emit({ type: "grant-port-done", side });
      if (granted) found = tandemPort(side) ?? ((await refresh(true)) && tandemPort(side));
    }

    const byHand = !ready && !found && !viaLeft;
    const thisWasUp = visible(side);
    const otherWasUp = visible(other);
    const otherTandem = tandemPort(other);
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
    } else if (viaLeft) {
      // Already restarting.
    } else {
      emit({ type: "step", step, state: "active", detail: "Waiting for update mode" });
      emit({ type: "manual", side, reason: "no-autoflash" });
    }

    const method = ready ?? (await updateMethod(side, !!found || viaLeft, emit, signal));
    let target = side;
    if (byHand) {
      // Both halves look the same in update mode. If the other half went
      // quiet, or this one is still up, the key combo landed on the other
      // half: update that one now, and the caller comes back for this one.
      // Either check needs a half the browser could see before, which during
      // first-time setup is the left half's ZMK Studio port.
      await refresh(true);
      emit({ type: "manual-done", side });
      if ((otherWasUp && !visible(other)) || (thisWasUp && visible(side))) {
        target = other;
        found = otherTandem;
        emit({ type: "step", step, state: "pending", detail: "Next" });
        step = `flash-${other}`;
        emit({ type: "switched", from: side, to: other });
      }
    }

    if (method.kind === "serial") {
      emit({ type: "step", step, state: "active", detail: "Sending firmware" });
      try {
        await sendOverSerial(method.port, target, build[target], emit, signal);
        // Chrome trusts this half's update port in this browser from now on.
        if (!trusted.has(target)) {
          trusted.add(target);
          deps!.updatePorts?.save([...trusted]);
        }
      } catch (err) {
        // The half is still in update mode, so its drive works as a fallback.
        emit({ type: "step", step, state: "active", detail: `Sending over the update port failed (${(err as Error).message}). Copy it to the drive instead.` });
        emit({ type: "drive", side: target });
        const picked = await waitFor<DriveLike>({ type: "pick-drive", side: target }, signal);
        emit({ type: "drive-done", side: target });
        emit({ type: "step", step, state: "active", detail: "Copying firmware" });
        await copyTo({ drive: picked, picked: true }, target, build[target], emit, signal);
      }
    } else {
      emit({ type: "step", step, state: "active", detail: "Copying firmware" });
      await copyTo(method.found, target, build[target], emit, signal);
    }
    emit({ type: "step", step, state: "active", detail: "Restarting" });
    // Until the half leaves update mode, its update port could pass for the
    // next half's.
    await waitForNoBootPort(timing.bootMs, signal);

    if (viaLeft) {
      // The bootloader checked the image before starting it. Seeing the right
      // half reconnect to the left one says it's running.
      const back = await rightBackViaLeft(timing.comebackMs, signal);
      if (back) keepRightBuild(build.id);
      emit({ type: "step", step, state: "done", detail: back ? `Running ${build.id}` : "Sent, but it hasn't reconnected to the left half" });
      return { flashed: target, checked: back, newPort: false };
    }

    // A half on its first Tandem firmware comes back with a port the browser
    // hasn't been allowed to open. The caller asks for it once every half is
    // flashed. Chrome may allow it already when it allowed another port of
    // the same half, so give a half it could see before a moment to show up.
    const targetWasUp = target === side ? thisWasUp : otherWasUp;
    const back = await comeback(target, build.id, found ? timing.comebackMs : targetWasUp ? timing.newPortMs : 0, signal);
    if (back && back.build !== build.id) throw new Error(`The ${target} half is running build ${back.build}, expected ${build.id}.`);
    const newPort = !back && !found;
    emit({
      type: "step",
      step,
      state: "done",
      detail: back ? `Running ${build.id}` : newPort ? "Firmware sent" : "Copied, but the browser couldn't ask it",
    });
    return { flashed: target, checked: !!back, newPort };
  }

  function keepRightBuild(build: string) {
    rightBuild = build;
    deps!.rightBuild?.save(build);
  }

  /** Waits up to `ms` for any of `sides` to report the build. Returns the ones that did. */
  async function backAmong(sides: Side[], buildId: string, ms: number, signal: AbortSignal): Promise<Side[]> {
    const deadline = Date.now() + ms;
    for (;;) {
      await withTimeout(refresh(), 5000, "Looking for the half").catch(() => {});
      const back = sides.filter((s) => tandemPort(s)?.[1].build === buildId);
      if (back.length || Date.now() >= deadline) return back;
      await sleep(timing.pollMs, signal);
    }
  }

  /**
   * Asks for freshly flashed halves' new ports, one pick at a time, until
   * each reports the build. Chrome lists every new port, so a pick can be the
   * other half's, which counts too. A pick that brings nothing back was
   * likely the left half's ZMK Studio port, so the next ask says so. Returns
   * the halves that came back.
   */
  async function connectNewPorts(sides: Side[], build: Build, emit: Parameters<Flash>[1], signal: AbortSignal): Promise<Side[]> {
    await refresh(true);
    // Left half first: on Tandem protocol 3 it can vouch for the right half,
    // whose own port then isn't needed.
    let pending = (["left", "right"] as Side[]).filter((s) => sides.includes(s) && tandemPort(s)?.[1].build !== build.id);
    let relayTried = false;
    const done = (back: Side[]) => {
      for (const side of back) emit({ type: "step", step: `flash-${side}`, state: "done", detail: `Running ${build.id}` });
      pending = pending.filter((s) => !back.includes(s));
    };
    done(sides.filter((s) => !pending.includes(s)));
    for (let misses = 0, missed = false, paired = false; pending.length && misses < 3; ) {
      const side = pending[0];
      if (side === "right" && !relayTried && relayPort()) {
        relayTried = true;
        emit({ type: "step", step: "verify", state: "active", detail: "Checking the right half through the left half" });
        if (await rightBackViaLeft(timing.comebackMs, signal)) {
          keepRightBuild(build.id);
          done(["right"]);
          continue;
        }
      }
      emit({ type: "step", step: "verify", state: "active", detail: `Waiting for the ${side} half's new port` });
      emit({ type: "grant-port", side, retry: missed, ...(paired && { paired }), ...(side === "left" && { studioPaired: otherPorts().length > 0 }) });
      const granted = await waitFor<boolean | "paired">({ type: "grant-port", side }, signal);
      emit({ type: "grant-port-done", side });
      if (!granted) break;
      paired = granted === "paired";
      const back = paired ? [] : await backAmong(pending, build.id, timing.newPortMs, signal);
      missed = !back.length;
      if (missed) misses++;
      done(back);
    }
    for (const side of pending) {
      const seen = tandemPort(side)?.[1];
      if (seen) throw new Error(`The ${side} half is running build ${seen.build}, expected ${build.id}.`);
    }
    return sides.filter((s) => !pending.includes(s));
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

    // A key combo can land on the other half, which then gets updated first,
    // so keep going until both are done. Each round needs the user's hands.
    const checked: Partial<Record<Side, boolean>> = {};
    const newPorts = new Set<Side>();
    // The right half goes first when something can restart it: its own port,
    // or the left half's firmware. Otherwise the left half goes first, by key
    // combo, so that its new firmware can restart the right half after.
    const order: Side[] = tandemPort("right") || relayPort() ? ["right", "left"] : ["left", "right"];
    let todo = waiting ? [waiting.side, ...order.filter((s) => s !== waiting!.side)] : order;
    for (let round = 0; todo.length; round++) {
      if (round >= 4) throw new Error(`The key combo kept putting the wrong half in update mode. Check which half you press it on, then update again.`);
      const side = todo[0];
      const result = await flashHalf(side, build, emit, signal, side === waiting?.side ? waiting.method : null, tandem);
      waiting = null;
      checked[result.flashed] = result.checked;
      if (result.newPort) newPorts.add(result.flashed);
      else newPorts.delete(result.flashed);
      todo = todo.filter((s) => s !== result.flashed);
      // The right half restarts through the left one, so the left half's new
      // port can't wait for the end.
      if (result.flashed === "left" && result.newPort && todo.includes("right")) {
        checked.left = (await connectNewPorts(["left"], build, emit, signal)).includes("left");
        newPorts.delete("left");
      }
    }
    // New ports last, so setup goes right half, left half, then the ports,
    // instead of stopping between the halves to connect one.
    const fresh = SIDES.filter((s) => newPorts.has(s));
    if (fresh.length) {
      const back = await connectNewPorts(fresh, build, emit, signal);
      for (const side of fresh) checked[side] = back.includes(side);
    }
    const all = !!(checked.left && checked.right);
    emit({ type: "step", step: "verify", state: all ? "done" : "skipped", detail: all ? `Both halves run ${build.id}` : "The browser couldn't ask every half" });
    // Show the right half's new build, which only the left half can vouch for.
    await refresh(true).catch(() => {});
    return all;
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
          const before = new Set(await serial.getPorts());
          const port = await serial.requestPort({ filters: [{ usbVendorId: KINESIS_VID }] });
          // An entry Chrome marks Paired was connected already, so it can't be the new port.
          answer(action, before.has(port) ? "paired" : true);
        } catch (e) {
          if (!isMissing(e)) throw e;
          // Closing Chrome's list without picking leaves the prompt up.
        }
      } else {
        answer(action);
      }
    },
  };
}
