// Fake sessions, keyboards and update runs for reviewing the UI without
// GitHub or a keyboard. Dev server only.
//
//   ?demo=walkthrough  first-time setup from stock firmware, played as you click
//                      (&wrong=half: the first key combo lands on the left half;
//                       &wrong=port: the first pick for the left half's port is ZMK Studio's)
//   ?demo=intro        the setup screen before Start
//   ?demo=repo, ?demo=install   onboarding's layout step
//   ?demo=<scenario>   the update sheet frozen at one moment, from `scenarios` below

import infoJson from "../../template/config/info.json?raw";
import keymapText from "../../template/config/adv360.keymap?raw";
import { parseKeymap, toKeymap } from "../../shared/keymap";
import { readLayout } from "../../shared/layout";
import type { AppState, DevicesStatus, HalfStatus, JobAction, JobEvent, JobSnapshot, Session, Side } from "../../shared/types";
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
  setup: {
    running: true,
    events: [...base, { type: "step", step: "flash-right", state: "active", detail: "Waiting for update mode" }, { type: "manual", side: "right", reason: "no-autoflash" }],
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
      { type: "step", step: "flash-right", state: "active", detail: "Waiting for update mode" },
      { type: "manual", side: "right", reason: "no-autoflash" },
      { type: "update-port", side: "right" },
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
      ...rightConnected,
      { type: "grant-port", side: "left", studioPaired: true },
      { type: "grant-port-done", side: "left" },
      { type: "step", step: "flash-left", state: "done", detail: `Running ${BUILD}` },
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
  onboarded: false,
};

const withRepo = (installed: boolean, onboarded: boolean): Session => ({
  ...signedIn,
  repo: { ...repo, url: "https://github.com/octocat/Adv360-Pro-ZMK/tree/main", head: BUILD },
  setup: installed
    ? { installed: true, outdated: false, changes: [], blocker: null }
    : { installed: false, outdated: false, changes: ["tandem/zmk-tandem/Kconfig", ".github/workflows/build.yml", "config/adv360.keymap"], blocker: null },
  onboarded,
});

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
  port: "web-serial",
});

function devicesFor(left: HalfStatus, right: HalfStatus): DevicesStatus {
  return { left, right, unknownBootloaders: [], needsAccess: false, scannedAt: new Date().toISOString() };
}

/**
 * Wraps the real engine, answering from fake data for whatever the demo
 * needs. Returns the real engine when no demo is asked for.
 */
export function demoEngine(real: Engine): Engine {
  const name = demoName();
  if (!name) return real;
  const wrong = new URLSearchParams(location.search).get("wrong");
  const walkthrough = name === "walkthrough" || name === "intro";

  // Onboarding remembers the keyboard step per tab. Skip it for the setup demos.
  if (walkthrough) {
    try {
      sessionStorage.setItem("tandem-onboarding-keyboard", "1");
    } catch {}
  }

  let session: Session =
    name === "repo" ? signedIn : name === "install" ? withRepo(false, false) : walkthrough ? withRepo(true, false) : withRepo(true, true);

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
  let devices = walkthrough ? devicesFor(stockLeft(), emptyHalf("right")) : devicesFor(tandemHalf("left"), tandemHalf("right"));
  const setDevices = (d: DevicesStatus) => {
    devices = d;
    emitLive({ type: "devices", devices });
  };

  const scenario = scenarios[name];
  let job: JobSnapshot | null = scenario ? { id: `demo-${name}`, ...scenario } : null;

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

  /** One half, the way serial-keyboard.ts runs it. Returns the half it updated. */
  async function half(side: Side, first: boolean): Promise<Side> {
    const step = `flash-${side}` as const;
    const other: Side = side === "left" ? "right" : "left";
    emit({ type: "step", step, state: "active", detail: "Waiting for update mode" });
    emit({ type: "manual", side, reason: "no-autoflash" });
    emit({ type: "update-port", side });
    const answer = await until("grant-update-port", side);
    emit({ type: "update-port-done", side });
    emit({ type: "manual-done", side });
    let target = side;
    if (first && wrong === "half" && side === "right") {
      target = other;
      emit({ type: "step", step, state: "pending", detail: "Next" });
      emit({ type: "switched", from: side, to: other });
      setDevices(devicesFor(emptyHalf("left"), devices.right));
    }
    const targetStep = `flash-${target}` as const;
    if (answer.type === "pick-drive") {
      emit({ type: "step", step: targetStep, state: "active", detail: "Copying firmware" });
      await sleep(1500);
    } else {
      for (let pct = 0; pct <= 100; pct += 10) {
        emit({ type: "step", step: targetStep, state: "active", detail: `Sending firmware ${pct}%` });
        await sleep(250);
      }
    }
    emit({ type: "step", step: targetStep, state: "active", detail: "Restarting" });
    await sleep(1200);
    emit({ type: "step", step: targetStep, state: "done", detail: "Firmware sent" });
    return target;
  }

  /** The last step: each half's new port, the way serial-keyboard.ts asks for them. */
  async function connectPorts() {
    let studioPaired = wrong !== "port";
    for (const side of ["right", "left"] as Side[]) {
      let skipped = false;
      for (let missed = false; ; ) {
        emit({ type: "step", step: "verify", state: "active", detail: `Waiting for the ${side} half's new port` });
        emit({ type: "grant-port", side, retry: missed, ...(side === "left" && { studioPaired }) });
        const reply = await until("grant-port", side);
        emit({ type: "grant-port-done", side });
        skipped = reply.type === "grant-port" && !!reply.skip;
        if (skipped) break;
        await sleep(600);
        // With &wrong=port, the first pick for the left half is ZMK Studio's port, which Chrome then marks Paired.
        missed = side === "left" && !studioPaired;
        if (!missed) break;
        studioPaired = true;
      }
      if (skipped) continue;
      emit({ type: "step", step: `flash-${side}`, state: "done", detail: `Running ${BUILD}` });
      setDevices(side === "left" ? devicesFor(tandemHalf("left"), devices.right) : devicesFor(devices.left, tandemHalf("right")));
    }
  }

  async function play() {
    emit({ type: "step", step: "save", state: "skipped", detail: `No changes, using ${BUILD}` });
    emit({ type: "step", step: "build", state: "active", detail: "Building on GitHub" });
    emit({ type: "run", url: "https://github.com/octocat/Adv360-Pro-ZMK/actions" });
    await sleep(2500);
    emit({ type: "step", step: "build", state: "done", detail: `Built ${BUILD}` });
    emit({ type: "step", step: "download", state: "active", detail: "Downloading" });
    await sleep(600);
    emit({ type: "step", step: "download", state: "done", detail: "323 KB" });
    emit({ type: "step", step: "prepare", state: "done", detail: "Neither half runs Tandem firmware yet" });
    let todo: Side[] = ["right", "left"];
    for (let round = 0; todo.length; round++) {
      const done = await half(todo[0], round === 0);
      todo = todo.filter((s) => s !== done);
    }
    await connectPorts();
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
    connectKeyboard: async () => {},
    update: async () => {
      if (!walkthrough) throw new Error("This demo shows one moment of an update. Open ?demo=walkthrough to click through one.");
      stopped = false;
      job = { id: `demo-${Date.now()}`, running: true, events: [] };
      emitLive({ type: "job", job });
      play().catch((e: Error) => emit({ type: "error", message: e.message }));
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
