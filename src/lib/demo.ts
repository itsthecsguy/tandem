// Fake sessions, keyboards and update runs for reviewing the UI without
// GitHub or a keyboard. Dev server only.
//
//   ?demo=walkthrough  first-time setup from stock firmware, played as you click: keys on the
//                      left half, then Tandem restarts the right half through the left one
//                      (&wrong=half: the first key combo lands on the right half)
//   ?demo=intro        the setup screen before Start
//   ?demo=trust        a keyboard with Tandem firmware in a browser that hasn't updated it yet
//   ?demo=repo, ?demo=install   onboarding's layout step
//   ?demo=outdated     the banners for a newer Tandem and for Kinesis's changes
//   ?demo=held         the banner after undoing a release, and for Kinesis changes that clash
//   ?demo=history      Versions and undo (&beta adds the ZMK 4.1 trial)
//   ?demo=<scenario>   the update sheet frozen at one moment, from `scenarios` below

import infoJson from "../../template/config/info.json?raw";
import keymapText from "../../template/config/adv360.keymap?raw";
import { parseKeymap, toKeymap } from "../../shared/keymap";
import { readLayout } from "../../shared/layout";
import type { AppState, DevicesStatus, HalfStatus, JobAction, JobEvent, JobSnapshot, Session, Side, UpdateHistory } from "../../shared/types";
import { emptyHalf } from "../engine/keyboard";
import type { Engine, LiveEvent } from "../engine/types";

const BUILD = "3f9c2ab";

const base: JobEvent[] = [
  { type: "step", step: "save", state: "done", detail: `Committed ${BUILD}` },
  { type: "run", url: "https://github.com/octocat/Adv360-Pro-ZMK/actions" },
  { type: "step", step: "build", state: "done", detail: `Built ${BUILD}` },
  { type: "step", step: "download", state: "done", detail: "323 KB" },
  { type: "step", step: "prepare", state: "done", detail: "Both halves connected" },
];

/** A half on stock firmware through its key combo and update port, flashed but not yet connected. */
const flashed = (side: Side): JobEvent[] => [
  { type: "manual", side, reason: "no-autoflash" },
  { type: "update-port", side },
  { type: "update-port-done", side },
  { type: "manual-done", side },
  { type: "step", step: `flash-${side}`, state: "done", detail: "Firmware sent" },
];

/** Both halves flashed, and the right half's new port connected. */
const rightConnected: JobEvent[] = [
  ...flashed("right"),
  ...flashed("left"),
  { type: "step", step: "verify", state: "active", detail: "Waiting for the right half's new port" },
  { type: "grant-port", side: "right" },
  { type: "grant-port-done", side: "right" },
  { type: "step", step: "flash-right", state: "done", detail: `Running ${BUILD}` },
];

const scenarios: Record<string, { running: boolean; events: JobEvent[] }> = {
  // A build of Tandem's own commit failed, so the sheet offers to undo it.
  buildfailed: {
    running: false,
    events: [
      { type: "step", step: "save", state: "done", detail: `Committed Tandem's update, ${BUILD}` },
      { type: "run", url: "https://github.com/octocat/Adv360-Pro-ZMK/actions" },
      { type: "step", step: "build", state: "active", detail: "On GitHub: West Build (left)" },
      { type: "undoable", commit: { sha: `${BUILD}000000000000000000000000000000000`, title: "Update Tandem to release 4", date: "2026-11-01T10:28:00Z" } },
      { type: "error", message: "The firmware build failed on GitHub (failure). Open the run to see why." },
    ],
  },
  rollback: {
    running: false,
    events: [
      { type: "rollback", build: "8e11c40" },
      { type: "step", step: "save", state: "skipped", detail: "Your repo stays as it is" },
      { type: "step", step: "build", state: "skipped", detail: "Already built 8e11c40" },
      { type: "step", step: "download", state: "skipped", detail: "Kept in this browser" },
      { type: "step", step: "prepare", state: "done", detail: "Both halves run Tandem firmware" },
      { type: "step", step: "flash-right", state: "done", detail: "Running 8e11c40" },
      { type: "step", step: "flash-left", state: "done", detail: "Running 8e11c40" },
      { type: "step", step: "verify", state: "done", detail: "Both halves run 8e11c40" },
      { type: "done", build: "8e11c40", checked: true },
    ],
  },
  left: {
    running: false,
    events: [
      { type: "leaving" },
      { type: "step", step: "save", state: "done", detail: `Committed ${BUILD}` },
      { type: "run", url: "https://github.com/octocat/Adv360-Pro-ZMK/actions" },
      { type: "step", step: "build", state: "done", detail: `Built ${BUILD}` },
      { type: "step", step: "download", state: "done", detail: "323 KB" },
      { type: "step", step: "prepare", state: "done", detail: "Both halves run Tandem firmware" },
      { type: "step", step: "flash-right", state: "done", detail: "Firmware sent" },
      { type: "step", step: "flash-left", state: "done", detail: "Firmware sent" },
      { type: "step", step: "verify", state: "skipped", detail: "Kinesis's firmware can't report its build" },
      { type: "done", build: BUILD, checked: false },
    ],
  },
  setup: {
    running: true,
    events: [...base, { type: "step", step: "flash-left", state: "active", detail: "Waiting for update mode" }, { type: "manual", side: "left", reason: "no-autoflash" }],
  },
  relay: {
    running: true,
    events: [
      ...base,
      ...flashed("left"),
      { type: "step", step: "flash-left", state: "done", detail: `Running ${BUILD}` },
      { type: "step", step: "flash-right", state: "active", detail: "Restarting into update mode through the left half" },
      { type: "update-port", side: "right" },
    ],
  },
  auto: {
    running: true,
    events: [
      ...base,
      { type: "step", step: "flash-right", state: "done", detail: `Running ${BUILD}` },
      { type: "step", step: "flash-left", state: "active", detail: "Restarting into update mode" },
    ],
  },
  drive: {
    running: true,
    events: [...base, { type: "step", step: "flash-right", state: "active", detail: "Waiting for its drive" }, { type: "drive", side: "right" }],
  },
  firsttime: {
    running: true,
    events: [
      ...base,
      { type: "step", step: "flash-left", state: "active", detail: "Waiting for update mode" },
      { type: "manual", side: "left", reason: "no-autoflash" },
      { type: "update-port", side: "left" },
    ],
  },
  updateport: {
    running: true,
    events: [...base, { type: "step", step: "flash-right", state: "active", detail: "Restarting into update mode" }, { type: "update-port", side: "right" }],
  },
  sending: {
    running: true,
    events: [
      ...base,
      { type: "manual", side: "right", reason: "no-autoflash" },
      { type: "update-port", side: "right" },
      { type: "update-port-done", side: "right" },
      { type: "manual-done", side: "right" },
      { type: "step", step: "flash-right", state: "active", detail: "Sending firmware 60%" },
    ],
  },
  port: {
    running: true,
    events: [
      ...base,
      ...flashed("right"),
      ...flashed("left"),
      { type: "step", step: "verify", state: "active", detail: "Waiting for the right half's new port" },
      { type: "grant-port", side: "right" },
    ],
  },
  portleft: {
    running: true,
    events: [
      ...base,
      ...rightConnected,
      { type: "step", step: "verify", state: "active", detail: "Waiting for the left half's new port" },
      { type: "grant-port", side: "left", studioPaired: true },
    ],
  },
  retry: {
    running: true,
    events: [
      ...base,
      ...rightConnected,
      { type: "step", step: "verify", state: "active", detail: "Waiting for the left half's new port" },
      { type: "grant-port", side: "left", studioPaired: false },
      { type: "grant-port-done", side: "left" },
      { type: "grant-port", side: "left", retry: true, studioPaired: true },
    ],
  },
  switched: {
    running: true,
    events: [
      ...base,
      { type: "step", step: "flash-right", state: "active", detail: "Waiting for update mode" },
      { type: "manual", side: "right", reason: "no-autoflash" },
      { type: "update-port", side: "right" },
      { type: "update-port-done", side: "right" },
      { type: "manual-done", side: "right" },
      { type: "step", step: "flash-right", state: "pending", detail: "Next" },
      { type: "switched", from: "right", to: "left" },
      { type: "step", step: "flash-left", state: "active", detail: "Sending firmware 30%" },
    ],
  },
  byhand: {
    running: true,
    events: [
      ...base.slice(0, 4),
      { type: "step", step: "prepare", state: "skipped", detail: "This browser can't reach the keyboard" },
      { type: "step", step: "flash-right", state: "active", detail: "Copy right.uf2 by hand" },
      { type: "step", step: "flash-left", state: "active", detail: "Copy left.uf2 by hand" },
      { type: "manual-flash", left: "#", right: "#" },
    ],
  },
  done: {
    running: false,
    events: [
      ...base,
      ...flashed("left"),
      { type: "step", step: "flash-left", state: "done", detail: `Running ${BUILD}` },
      { type: "step", step: "flash-right", state: "active", detail: "Restarting into update mode through the left half" },
      { type: "update-port", side: "right" },
      { type: "update-port-done", side: "right" },
      { type: "step", step: "flash-right", state: "done", detail: `Running ${BUILD}` },
      { type: "step", step: "verify", state: "done", detail: `Both halves run ${BUILD}` },
      { type: "done", build: BUILD, checked: true },
    ],
  },
};

const repo = { owner: "octocat", name: "Adv360-Pro-ZMK", branch: "main" };

const signedIn: Session = {
  signedIn: true,
  login: "octocat",
  source: "gh",
  missingScopes: [],
  privateRepos: true,
  deviceFlow: false,
  oauth: false,
  ghLogin: "octocat",
  repo: null,
  setup: null,
  kinesis: null,
  beta: null,
  onboarded: false,
};

const withRepo = (installed: boolean, onboarded: boolean): Session => ({
  ...signedIn,
  repo: { ...repo, url: "https://github.com/octocat/Adv360-Pro-ZMK/tree/main", head: BUILD },
  setup: installed
    ? { installed: true, outdated: false, changes: [], blocker: null, version: 4, latest: 4, held: false }
    : {
        installed: false,
        outdated: false,
        changes: ["tandem/zmk-tandem/Kconfig", ".github/workflows/build.yml", "config/adv360.keymap"],
        blocker: null,
        version: null,
        latest: 4,
        held: false,
      },
  onboarded,
});

const outdated = (held: boolean): Session => ({
  ...withRepo(true, true),
  setup: { installed: false, outdated: true, changes: ["tandem/zmk-tandem/src/reconnect.c"], blocker: null, version: 3, latest: 4, held },
  kinesis: {
    to: "97f5d7394d36f60754a483bf5551e16d996fe406",
    commits: ["fix(ci): correct cache key path for west manifest (#832)"],
    conflicts: held ? ["config/boards/arm/adv360/adv360_left_defconfig"] : [],
    kept: held ? [] : ["config/adv360.keymap"],
    held: false,
    compareUrl: "https://github.com/KinesisCorporation/Adv360-Pro-ZMK/compare/081b8f9...97f5d73",
  },
});

const demoHistory: UpdateHistory = {
  builds: [
    { key: `${BUILD}-firmware-clique`, id: BUILD, createdAt: "2026-11-01T10:30:00Z", studio: true, stock: false },
    { key: "8e11c40-firmware-clique", id: "8e11c40", createdAt: "2026-10-29T17:02:00Z", studio: true, stock: false },
    { key: "c04d7aa-firmware-no-clique", id: "c04d7aa", createdAt: "2026-10-23T09:12:00Z", studio: false, stock: false },
  ],
  updates: [
    { sha: `${BUILD}000000000000000000000000000000000`, title: "Update Tandem to release 4", date: "2026-11-01T10:28:00Z" },
    { sha: "b12ee9f000000000000000000000000000000000", title: "Sync with Kinesis 97f5d73", date: "2026-11-01T10:28:00Z" },
  ],
};

/** The demo asked for in the URL, if any. */
export function demoName(): string | null {
  if (!import.meta.env.DEV || typeof location === "undefined") return null;
  return new URLSearchParams(location.search).get("demo");
}

/** Kinesis's stock firmware: the left half shows ZMK Studio's port, the right half nothing. */
const stockLeft = (): HalfStatus => ({ ...emptyHalf("left"), mode: "app", otherPorts: ["web-serial"] });
const tandemHalf = (side: Side): HalfStatus => ({
  ...emptyHalf(side),
  mode: "app",
  autoflash: true,
  build: BUILD,
  repo: "octocat/Adv360-Pro-ZMK",
  protocol: 2,
  version: 4,
  port: "web-serial",
});

function devicesFor(left: HalfStatus, right: HalfStatus, updatePorts: Side[] = []): DevicesStatus {
  return { left, right, unknownBootloaders: [], needsAccess: false, updatePorts, scannedAt: new Date().toISOString() };
}

/**
 * Wraps the real engine, answering from fake data for whatever the demo
 * needs. Returns the real engine when no demo is asked for.
 */
export function demoEngine(real: Engine): Engine {
  const name = demoName();
  if (!name) return real;
  const wrong = new URLSearchParams(location.search).get("wrong");
  const trust = name === "trust";
  const walkthrough = name === "walkthrough" || name === "intro" || trust;

  // Onboarding remembers the keyboard step per tab. Skip it for the setup demos.
  if (walkthrough) {
    try {
      sessionStorage.setItem("tandem-onboarding-keyboard", "1");
    } catch {}
  }

  let session: Session =
    name === "repo"
      ? signedIn
      : name === "install"
        ? withRepo(false, false)
        : walkthrough
          ? withRepo(true, false)
          : name === "outdated" || name === "held"
            ? outdated(name === "held")
            : withRepo(true, true);

  const layout = readLayout(infoJson);
  const state: AppState = {
    repo: { ...repo, url: "https://github.com/octocat/Adv360-Pro-ZMK" },
    layout: layout.keys,
    rows: layout.rows,
    keymap: toKeymap(parseKeymap(keymapText)),
    settings: { studio: true },
    buildId: BUILD,
    lastBuild: null,
  };

  const listeners = new Set<(e: LiveEvent) => void>();
  const emitLive = (e: LiveEvent) => listeners.forEach((l) => l(e));
  let devices = trust
    ? devicesFor(tandemHalf("left"), tandemHalf("right"))
    : walkthrough
      ? devicesFor(stockLeft(), emptyHalf("right"))
      : devicesFor(tandemHalf("left"), tandemHalf("right"), ["left", "right"]);
  const setDevices = (d: DevicesStatus) => {
    devices = d;
    emitLive({ type: "devices", devices });
  };

  const scenario = scenarios[name];
  let job: JobSnapshot | null = scenario ? { id: `demo-${name}`, ...scenario } : null;

  // Chrome's list opened by the click that started the walkthrough. The demo
  // picks ADV360PRO a few seconds in, as if the user had pressed the keys.
  let earlyPick: Promise<boolean> | null = null;
  let earlyPicked = false;

  // The walkthrough plays a job a step at a time, pausing where the user acts.
  let waiting: { action: JobAction["type"]; side: Side; resolve: (a: JobAction) => void } | null = null;
  let stopped = false;
  const sleep = (ms: number) => new Promise<void>((resolve, reject) => setTimeout(() => (stopped ? reject(new Error("Cancelled")) : resolve()), ms));
  const emit = (event: JobEvent) => {
    if (!job) return;
    job = { ...job, events: [...job.events, event], running: event.type === "done" || event.type === "error" ? false : job.running };
    emitLive({ type: "job-event", event });
  };
  const until = (action: JobAction["type"], side: Side) => new Promise<JobAction>((resolve) => (waiting = { action, side, resolve }));

  /** Sends a half its firmware once it's in update mode. */
  async function send(side: Side, answer: JobAction) {
    const step = `flash-${side}` as const;
    if (answer.type === "pick-drive") {
      emit({ type: "step", step, state: "active", detail: "Copying firmware" });
      await sleep(1500);
    } else {
      for (let pct = 0; pct <= 100; pct += 10) {
        emit({ type: "step", step, state: "active", detail: `Sending firmware ${pct}%` });
        await sleep(250);
      }
    }
    emit({ type: "step", step, state: "active", detail: "Restarting" });
    await sleep(1200);
    emit({ type: "step", step, state: "done", detail: `Running ${BUILD}` });
    setDevices(side === "left" ? devicesFor(tandemHalf("left"), devices.right) : devicesFor(devices.left, tandemHalf("right")));
  }

  /** A half by its key combo, the way serial-keyboard.ts runs it. Returns the half it updated. */
  async function byHand(side: Side, first: boolean): Promise<Side> {
    const step = `flash-${side}` as const;
    if (first && earlyPicked && wrong !== "half") {
      emit({ type: "step", step, state: "active", detail: "Already in update mode" });
      await send(side, { type: "grant-update-port", side });
      return side;
    }
    emit({ type: "step", step, state: "active", detail: "Waiting for update mode" });
    emit({ type: "manual", side, reason: "no-autoflash" });
    emit({ type: "update-port", side });
    const answer = await until("grant-update-port", side);
    emit({ type: "update-port-done", side });
    emit({ type: "manual-done", side });
    let target = side;
    if (first && wrong === "half" && side === "left") {
      target = "right";
      emit({ type: "step", step, state: "pending", detail: "Next" });
      emit({ type: "switched", from: side, to: target });
    }
    await send(target, answer);
    return target;
  }

  /** The right half, restarted by the left half's new firmware. */
  async function throughLeft() {
    emit({ type: "step", step: "flash-right", state: "active", detail: "Waiting for it to connect to the left half" });
    await sleep(1200);
    emit({ type: "step", step: "flash-right", state: "active", detail: "Restarting into update mode through the left half" });
    await sleep(1000);
    emit({ type: "update-port", side: "right" });
    const answer = await until("grant-update-port", "right");
    emit({ type: "update-port-done", side: "right" });
    await send("right", answer);
  }

  /** Trusting a new browser: each half restarts by itself, and Chrome asks about its update port. */
  async function playTrust() {
    emit({ type: "step", step: "save", state: "skipped", detail: `No changes, using ${BUILD}` });
    emit({ type: "step", step: "build", state: "skipped", detail: `Already built ${BUILD}` });
    emit({ type: "step", step: "download", state: "skipped", detail: "Downloaded before" });
    emit({ type: "step", step: "prepare", state: "done", detail: "Both halves run Tandem firmware" });
    for (const side of ["right", "left"] as Side[]) {
      emit({ type: "step", step: `flash-${side}`, state: "active", detail: side === "right" ? "Restarting into update mode through the left half" : "Restarting into update mode" });
      await sleep(1000);
      // The first half shows up in the list the click opened.
      if (side === "right" && earlyPick && (await earlyPick)) {
        await send(side, { type: "grant-update-port", side });
        continue;
      }
      emit({ type: "update-port", side });
      const answer = await until("grant-update-port", side);
      emit({ type: "update-port-done", side });
      await send(side, answer);
    }
    setDevices(devicesFor(devices.left, devices.right, ["left", "right"]));
    emit({ type: "step", step: "verify", state: "done", detail: `Both halves run ${BUILD}` });
    emit({ type: "done", build: BUILD, checked: true });
  }

  async function play() {
    emit({ type: "step", step: "save", state: "skipped", detail: `No changes, using ${BUILD}` });
    emit({ type: "step", step: "build", state: "active", detail: "Building on GitHub" });
    emit({ type: "run", url: "https://github.com/octocat/Adv360-Pro-ZMK/actions" });
    // Long enough to show the left half done from the open list while GitHub builds.
    await sleep(earlyPick ? 7000 : 2500);
    emit({ type: "step", step: "build", state: "done", detail: `Built ${BUILD}` });
    emit({ type: "step", step: "download", state: "active", detail: "Downloading" });
    await sleep(600);
    emit({ type: "step", step: "download", state: "done", detail: "323 KB" });
    emit({ type: "step", step: "prepare", state: "done", detail: "Neither half runs Tandem firmware yet" });
    // With &wrong=half the right half gets its firmware by hand, and the left half comes after.
    if ((await byHand("left", true)) === "right") await byHand("left", false);
    else await throughLeft();
    emit({ type: "step", step: "verify", state: "done", detail: `Both halves run ${BUILD}` });
    emit({ type: "done", build: BUILD, checked: true });
  }

  return {
    ...real,
    caps: { engine: "browser", keyboard: true, flash: true },
    session: async () => session,
    completeOnboarding: async () => (session = { ...session, onboarded: true }),
    restartOnboarding: async () => (session = { ...session, onboarded: false }),
    keyboard: async () => ({
      left: devices.left,
      right: devices.right,
      tandemKeymap: devices.left.autoflash,
      tandemRepo: devices.left.repo,
      studio: devices.left.autoflash ? null : { available: true, name: "Adv360 Pro", locked: false },
      layout: layout.keys,
    }),
    state: async () => state,
    saveKeymap: async (keymap) => ({ ...state, keymap }),
    history: async () => demoHistory,
    flashBuild: async () => {
      throw new Error("Demo mode doesn't send changes.");
    },
    undoUpdate: async () => {
      throw new Error("Demo mode doesn't send changes.");
    },
    leaveTandem: async () => {
      throw new Error("Demo mode doesn't send changes.");
    },
    startBeta: async () => {
      throw new Error("Demo mode doesn't send changes.");
    },
    leaveBeta: async () => {
      throw new Error("Demo mode doesn't send changes.");
    },
    connectKeyboard: async () => {},
    allowUpdatePort: () => {
      earlyPick = new Promise((resolve) =>
        setTimeout(() => {
          earlyPicked = true;
          resolve(true);
        }, trust ? 2500 : 4000),
      );
      return earlyPick;
    },
    update: async () => {
      if (!walkthrough) throw new Error("This demo shows one moment of an update. Open ?demo=walkthrough to click through one.");
      stopped = false;
      job = { id: `demo-${Date.now()}`, running: true, events: [] };
      emitLive({ type: "job", job });
      (trust ? playTrust() : play()).catch((e: Error) => emit({ type: "error", message: e.message }));
      return { id: job.id };
    },
    cancel: async () => {
      stopped = true;
      waiting = null;
      emit({ type: "error", message: "Cancelled" });
      return { ok: true };
    },
    act: async (action) => {
      const w = waiting;
      if (!w) return;
      // Choosing the drive is the other way through the update port's prompt.
      const fits = action.type === w.action || (w.action === "grant-update-port" && action.type === "pick-drive");
      if (!fits || ("side" in action && action.side !== w.side)) return;
      waiting = null;
      w.resolve(action);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      listener({ type: "connected", connected: true });
      listener({ type: "devices", devices });
      if (job) listener({ type: "job", job });
      return () => listeners.delete(listener);
    },
  };
}
