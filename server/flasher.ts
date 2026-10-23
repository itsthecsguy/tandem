// Puts each half into its bootloader, copies its firmware, and checks that it
// comes back running the expected build.
//
// Halves running Tandem firmware reboot into the bootloader on request. Older
// firmware needs the user's key combo, and those combos only work while the
// other half is running: layers live on the left half, and the Mod key is on
// the right. So manual halves go one at a time, right first, and Tandem
// halves go together afterwards.

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { BuildRecord, DevicesStatus, HalfStatus, JobEvent, Side } from "../shared/types";
import { forgetProbes, scanDevices, touchBootloader } from "./devices";
import { loadState, saveState } from "./workspace";

const SIDES: Side[] = ["right", "left"];
const POLL_MS = 400;

type Emit = (e: JobEvent) => void;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason);
    }, { once: true });
  });

type Found<T> = T | null | undefined | false;

async function waitFor<T>(
  check: (d: DevicesStatus) => Found<T> | Promise<Found<T>>,
  signal: AbortSignal,
  timeoutMs = Infinity,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    signal.throwIfAborted();
    const found = await check(await scanDevices());
    if (found) return found;
    if (Date.now() > deadline) throw new Error("timeout");
    await sleep(POLL_MS, signal);
  }
}

/**
 * Waits for a half's bootloader drive. A drive with an unknown serial is
 * taken as this half when it's the only one, and its serial is remembered.
 */
async function waitForBootloader(side: Side, signal: AbortSignal, timeoutMs = Infinity): Promise<HalfStatus> {
  return waitFor(async (d) => {
    if (d[side].mode === "bootloader") return d[side];
    const other = side === "left" ? "right" : "left";
    if (d.unknownBootloaders.length === 1 && d[other].mode !== "bootloader") {
      const { volume, serial } = d.unknownBootloaders[0];
      if (serial) {
        const state = await loadState();
        await saveState({ knownSerials: { ...state.knownSerials, [side]: serial } });
      }
      return { ...d[side], mode: "bootloader" as const, serial, volume };
    }
    return null;
  }, signal, timeoutMs);
}

async function copyFirmware(side: Side, half: HalfStatus, file: string, emit: Emit, signal: AbortSignal) {
  const volume = half.volume!;
  emit({ type: "step", step: `flash-${side}`, state: "active", detail: "Copying firmware" });
  const data = await readFile(file);
  try {
    await writeFile(join(volume, `tandem-${side}.uf2`), data);
  } catch (err) {
    // The bootloader restarts as soon as it has the last block, so the write
    // often fails with EIO. That's success if the drive goes away shortly.
    const deadline = Date.now() + 5000;
    while (existsSync(volume) && Date.now() < deadline) await sleep(200, signal);
    if (existsSync(volume)) throw err;
  }
  const deadline = Date.now() + 30_000;
  while (existsSync(volume)) {
    if (Date.now() > deadline) throw new Error(`The ${side} half took the file but didn't restart`);
    await sleep(POLL_MS, signal);
  }
  emit({ type: "step", step: `flash-${side}`, state: "active", detail: "Restarting" });
}

async function verifyHalf(side: Side, build: BuildRecord, emit: Emit, signal: AbortSignal) {
  forgetProbes();
  let half: HalfStatus;
  try {
    half = await waitFor((d) => d[side].mode === "app" && d[side].autoflash && d[side], signal, 30_000);
  } catch {
    throw new Error(`The ${side} half restarted but didn't report Tandem firmware. Unplug it and plug it back in.`);
  }
  if (half.build !== build.id) {
    throw new Error(`The ${side} half is running build ${half.build}, expected ${build.id}`);
  }
  emit({ type: "step", step: `flash-${side}`, state: "done", detail: `Running ${build.id}` });
}

async function flashHalf(side: Side, build: BuildRecord, emit: Emit, signal: AbortSignal, start: HalfStatus) {
  let half = start;
  if (half.mode === "app") {
    if (half.autoflash && half.port) {
      emit({ type: "step", step: `flash-${side}`, state: "active", detail: "Restarting into update mode" });
      await touchBootloader(half.port).catch(() => {});
      try {
        half = await waitForBootloader(side, signal, 10_000);
      } catch {
        emit({ type: "manual", side, reason: "no-response" });
        half = await waitForBootloader(side, signal);
        emit({ type: "manual-done", side });
      }
    } else {
      emit({ type: "step", step: `flash-${side}`, state: "active", detail: "Waiting for update mode" });
      emit({ type: "manual", side, reason: "no-autoflash" });
      half = await waitForBootloader(side, signal);
      emit({ type: "manual-done", side });
    }
  }
  await copyFirmware(side, half, build[side], emit, signal);
  await verifyHalf(side, build, emit, signal);
}

export async function flashKeyboard(build: BuildRecord, emit: Emit, signal: AbortSignal): Promise<void> {
  emit({ type: "step", step: "prepare", state: "active", detail: "Looking for both halves" });

  let devices = await scanDevices();
  for (const side of SIDES) {
    if (devices[side].mode !== "missing") continue;
    emit({ type: "plug-in", side });
    devices = await waitFor((d) => d[side].mode !== "missing" && d, signal);
  }
  emit({ type: "step", step: "prepare", state: "done", detail: "Both halves connected" });

  // A half already waiting in its bootloader goes first, so the other half's
  // key combo works again afterwards.
  const waiting = SIDES.filter((s) => devices[s].mode === "bootloader");
  const needsHands = SIDES.filter((s) => devices[s].mode === "app" && !devices[s].autoflash);
  const automatic = SIDES.filter((s) => devices[s].mode === "app" && devices[s].autoflash);

  await Promise.all(waiting.map((side) => flashHalf(side, build, emit, signal, devices[side])));

  for (const side of needsHands) {
    const current = (await scanDevices())[side];
    await flashHalf(side, build, emit, signal, current);
  }

  const current = await scanDevices();
  await Promise.all(automatic.map((side) => flashHalf(side, build, emit, signal, current[side])));

  emit({ type: "step", step: "verify", state: "done", detail: `Both halves run ${build.id}` });
}
