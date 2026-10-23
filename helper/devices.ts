// Finds the keyboard halves on USB (macOS). Each half is in one of three
// states: running firmware ("app"), in its UF2 bootloader with a drive
// mounted ("bootloader"), or not connected.
//
// Halves are told apart by USB serial number. The bootloader and ZMK both
// derive it from the chip's FICR device ID in the same format, so a half
// keeps its serial across modes.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { parse as parsePlist } from "plist";
import { SerialPort } from "serialport";

import type { DevicesStatus, HalfStatus, Side } from "../shared/types";
import { loadState, saveState } from "./workspace";

const run = promisify(execFile);

/** USB product names ZMK uses for each half, from CONFIG_ZMK_KEYBOARD_NAME. */
const PRODUCT_NAMES: Record<string, Side> = {
  "Adv360 Pro": "left",
  "Adv360 Pro rt": "right",
};

interface UsbDevice {
  name: string;
  serial: string | null;
  session: string;
  callouts: string[];
  bsdNames: string[];
}

type Node = Record<string, unknown> & { IORegistryEntryChildren?: Node[] };

function collect(node: Node, key: string, out: string[]) {
  const v = node[key];
  if (typeof v === "string") out.push(v);
  for (const child of node.IORegistryEntryChildren ?? []) collect(child, key, out);
  return out;
}

async function usbDevices(): Promise<UsbDevice[]> {
  const { stdout } = await run("ioreg", ["-a", "-r", "-c", "IOUSBHostDevice", "-l"], { maxBuffer: 64 * 1024 * 1024 });
  if (!stdout.trim()) return [];
  const roots = parsePlist(stdout) as unknown as Node[];
  return roots.map((d) => ({
    name: String(d["USB Product Name"] ?? ""),
    serial: typeof d["USB Serial Number"] === "string" ? (d["USB Serial Number"] as string) : null,
    session: String(d.sessionID ?? d.locationID ?? ""),
    callouts: collect(d, "IOCalloutDevice", []),
    bsdNames: collect(d, "BSD Name", []),
  }));
}

const diskIds = new Map<string, string[]>();

/** UF2 bootloader drives currently mounted, with their disk identifiers. */
async function bootloaderVolumes(): Promise<{ path: string; disks: string[] }[]> {
  const volumes = [];
  for (const name of await readdir("/Volumes")) {
    const path = join("/Volumes", name);
    if (!existsSync(join(path, "INFO_UF2.TXT"))) {
      diskIds.delete(path);
      continue;
    }
    let disks = diskIds.get(path);
    if (!disks) {
      try {
        const { stdout } = await run("diskutil", ["info", "-plist", path]);
        const info = parsePlist(stdout) as Record<string, unknown>;
        disks = [info.DeviceIdentifier, info.ParentWholeDisk].filter((v): v is string => typeof v === "string");
        diskIds.set(path, disks);
      } catch {
        continue;
      }
    }
    volumes.push({ path, disks });
  }
  return volumes;
}

interface ProbeResult {
  tandem: number;
  role: "central" | "peripheral";
  name: string;
  build: string;
  repo?: string;
}

// Probe results per port and USB session. A port that doesn't answer gets a
// few more tries, since it may not be ready right after the half connects.
const probes = new Map<string, { result: ProbeResult | null; tries: number; at: number }>();
const PROBE_TRIES = 3;
const PROBE_RETRY_MS = 1500;

async function cachedProbe(key: string, port: string): Promise<ProbeResult | null> {
  const prev = probes.get(key);
  if (prev && (prev.result || prev.tries >= PROBE_TRIES || Date.now() - prev.at < PROBE_RETRY_MS)) {
    return prev.result;
  }
  const result = await probePort(port);
  probes.set(key, { result, tries: (prev?.tries ?? 0) + 1, at: Date.now() });
  return result;
}

/** Asks a serial port whether it's Tandem firmware. Other ports ignore the line. */
export function probePort(path: string, timeoutMs = 700): Promise<ProbeResult | null> {
  return new Promise((resolve) => {
    let buffer = "";
    let settled = false;
    const port = new SerialPort({ path, baudRate: 115200, autoOpen: false });
    const finish = (result: ProbeResult | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (port.isOpen) port.close(() => resolve(result));
      else resolve(result);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    port.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const line = buffer.split("\n").find((l) => l.startsWith('{"tandem"'));
      if (!line) return;
      try {
        finish(JSON.parse(line));
      } catch {
        finish(null);
      }
    });
    port.on("error", () => finish(null));
    port.open((err) => {
      if (err) return finish(null);
      port.write("\ninfo\n");
    });
  });
}

/** Reads the keymap source a half was built from. Needs Tandem protocol 2. */
export function readTandemKeymap(path: string, timeoutMs = 6000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let expected: number | null = null;
    let bodyStart = 0;
    const port = new SerialPort({ path, baudRate: 115200, autoOpen: false });
    const finish = (err: Error | null, text?: string) => {
      clearTimeout(timer);
      const done = () => (err ? reject(err) : resolve(text!));
      if (port.isOpen) port.close(done);
      else done();
    };
    const timer = setTimeout(() => finish(new Error("The keyboard didn't send its keymap")), timeoutMs);
    port.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (expected === null) {
        const text = buffer.toString("latin1");
        const m = /\{"tandem":\d+,"keymap":(\d+)\}\n/.exec(text);
        if (!m) return;
        expected = Number(m[1]);
        bodyStart = m.index + m[0].length;
      }
      if (buffer.length - bodyStart >= expected) {
        finish(null, buffer.subarray(bodyStart, bodyStart + expected).toString("utf8"));
      }
    });
    port.on("error", (e) => finish(e));
    port.open((err) => {
      if (err) return finish(err);
      port.write("\nkeymap\n");
    });
  });
}

/** Sets the Tandem port to 1200 baud, which reboots that half into its bootloader. */
export function touchBootloader(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const port = new SerialPort({ path, baudRate: 1200, autoOpen: false });
    port.open((err) => {
      if (err) return reject(err);
      // The half reboots as soon as it sees the new rate. Closing may fail
      // because the port is already gone, which is fine.
      setTimeout(() => port.close(() => resolve()), 100);
    });
  });
}

function emptyHalf(side: Side): HalfStatus {
  return { side, mode: "missing", serial: null, autoflash: false, build: null, repo: null, protocol: 0, port: null, volume: null, otherPorts: [] };
}

let inflight: Promise<DevicesStatus> | null = null;

/** Scans USB. Callers that arrive mid-scan share the scan in progress. */
export function scanDevices(): Promise<DevicesStatus> {
  inflight ??= scan().finally(() => (inflight = null));
  return inflight;
}

async function scan(): Promise<DevicesStatus> {
  const [devices, volumes, state] = await Promise.all([usbDevices(), bootloaderVolumes(), loadState()]);
  const halves: Record<Side, HalfStatus> = { left: emptyHalf("left"), right: emptyHalf("right") };
  const unknownBootloaders: DevicesStatus["unknownBootloaders"] = [];
  const learned = { ...state.knownSerials };

  for (const dev of devices) {
    const side = PRODUCT_NAMES[dev.name];
    if (side) {
      const half = halves[side];
      half.mode = "app";
      half.serial = dev.serial;
      if (dev.serial) learned[side] = dev.serial;

      for (const port of dev.callouts) {
        const result = await cachedProbe(`${dev.session}:${port}`, port);
        if (result) {
          half.autoflash = true;
          half.build = result.build;
          half.repo = result.repo || null;
          half.protocol = result.tandem;
          half.port = port;
        } else {
          half.otherPorts.push(port);
        }
      }
      continue;
    }

    const volume = volumes.find((v) => v.disks.some((d) => dev.bsdNames.includes(d)));
    if (!volume) continue;
    const owner = (Object.keys(learned) as Side[]).find((s) => learned[s] === dev.serial);
    if (owner && halves[owner].mode === "missing") {
      halves[owner] = { ...emptyHalf(owner), mode: "bootloader", serial: dev.serial, volume: volume.path };
    } else {
      unknownBootloaders.push({ volume: volume.path, serial: dev.serial });
    }
  }

  if (learned.left !== state.knownSerials.left || learned.right !== state.knownSerials.right) {
    await saveState({ knownSerials: learned });
  }

  return { ...halves, unknownBootloaders, needsAccess: false, scannedAt: new Date().toISOString() };
}

/** Forget probe results for a half, e.g. after flashing it. */
export function forgetProbes() {
  probes.clear();
}
