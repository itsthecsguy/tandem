import type { JobSnapshot, Side, StepId, StepState } from "../../shared/types";

export const STEP_ORDER: StepId[] = ["save", "build", "download", "prepare", "flash-right", "flash-left", "verify"];

export const STEP_TITLES: Record<StepId, string> = {
  save: "Commit layout",
  build: "Build on GitHub",
  download: "Download firmware",
  prepare: "Find both halves",
  "flash-right": "Update right half",
  "flash-left": "Update left half",
  verify: "Check both halves",
};

export type Mark = "todo" | "now" | "done";

/** What a first-time setup asks of the user for one half, in order. */
export interface HandSteps {
  /** Put the half in update mode with its key combo. */
  keys: Mark;
  /** Who put it in update mode: the user's key combo, or Tandem through the other half. */
  keysBy: "you" | "tandem" | null;
  /** Connect its update port, ADV360PRO, in Chrome's list. */
  allow: Mark;
  /** Connect its new Tandem port in Chrome's list, once both halves are flashed. */
  port: Mark;
}

const fresh = (): HandSteps => ({ keys: "todo", keysBy: null, allow: "todo", port: "todo" });

export interface JobView {
  steps: Record<StepId, { state: StepState; detail?: string }>;
  manual: { side: Side; reason: "no-autoflash" | "no-response" } | null;
  plugIn: Side | null;
  /** The browser needs the user to choose this half's drive. */
  drive: Side | null;
  /** The browser needs the user's OK, once, to open this half's update port. */
  updatePort: Side | null;
  /** The browser needs the user to allow this half's port, before or after flashing it. */
  grantPort: { side: Side; before: boolean; retry: boolean; studioPaired: boolean; paired: boolean } | null;
  /** First-time setup's steps for each half. */
  hands: Record<Side, HandSteps>;
  /** The key combo landed on the other half, so Tandem updates that one first. */
  switched: { from: Side; to: Side } | null;
  /** The half whose update started first. Setup starts with the left half. */
  firstHalf: Side | null;
  /** This browser can't reach the keyboard: the files to copy by hand. */
  manualFlash: { left: string; right: string } | null;
  logs: string[];
  /** The Actions run building this update. */
  runUrl: string | null;
  done: string | null;
  /** Both halves reported the new build. False when nothing could ask them. */
  checked: boolean;
  error: string | null;
  running: boolean;
  /** Any half needed hands this run, so this was a first-time setup. */
  setup: boolean;
}

export function viewJob(job: JobSnapshot): JobView {
  const view: JobView = {
    steps: Object.fromEntries(STEP_ORDER.map((s) => [s, { state: "pending" }])) as JobView["steps"],
    manual: null,
    plugIn: null,
    drive: null,
    updatePort: null,
    grantPort: null,
    hands: { left: fresh(), right: fresh() },
    switched: null,
    firstHalf: null,
    manualFlash: null,
    logs: [],
    runUrl: null,
    done: null,
    checked: false,
    error: null,
    running: job.running,
    setup: false,
  };

  for (const e of job.events) {
    switch (e.type) {
      case "step":
        view.steps[e.step] = { state: e.state, detail: e.detail };
        if (e.step === "prepare" && e.state === "done") view.plugIn = null;
        if (e.step === "flash-left" || e.step === "flash-right") {
          const side = e.step === "flash-left" ? "left" : "right";
          if (e.state === "active") view.firstHalf ??= side;
          const hands = view.hands[side];
          if (e.state === "active" && e.detail?.startsWith("Restarting into update mode") && hands.keys !== "done") {
            view.hands[side] = { ...hands, keys: "done", keysBy: "tandem" };
          }
          if (e.state === "done") {
            // A half on its first Tandem firmware is done flashing before its new port is connected.
            const answered = !!e.detail?.startsWith("Running");
            view.hands[side] = { ...view.hands[side], keys: "done", allow: "done", port: answered ? "done" : hands.port };
          }
        }
        break;
      case "log":
        view.logs.push(e.line);
        break;
      case "run":
        view.runUrl = e.url;
        break;
      case "manual":
        view.manual = { side: e.side, reason: e.reason };
        view.hands[e.side].keys = "now";
        view.hands[e.side].keysBy = "you";
        view.switched = null;
        if (e.reason === "no-autoflash") view.setup = true;
        break;
      case "manual-done":
        if (view.manual?.side === e.side) view.manual = null;
        view.hands[e.side].keys = "done";
        break;
      case "switched":
        view.switched = { from: e.from, to: e.to };
        view.hands[e.to] = { ...view.hands[e.to], keys: "done", keysBy: "you", allow: "done" };
        view.hands[e.from] = { ...view.hands[e.from], keys: "todo", allow: "todo" };
        break;
      case "plug-in":
        view.plugIn = e.side;
        break;
      case "drive":
        view.drive = e.side;
        break;
      case "drive-done":
        if (view.drive === e.side) view.drive = null;
        if (view.manual?.side === e.side) view.manual = null;
        break;
      case "update-port":
        view.updatePort = e.side;
        view.hands[e.side].allow = "now";
        break;
      case "update-port-done":
        if (view.updatePort === e.side) view.updatePort = null;
        if (view.manual?.side === e.side) view.manual = null;
        view.hands[e.side].keys = "done";
        view.hands[e.side].allow = "done";
        break;
      case "grant-port":
        view.grantPort = { side: e.side, before: !!e.before, retry: !!e.retry, studioPaired: !!e.studioPaired, paired: !!e.paired };
        if (!e.before) view.hands[e.side].port = "now";
        break;
      case "grant-port-done":
        if (view.grantPort?.side === e.side) view.grantPort = null;
        if (view.hands[e.side].port === "now") view.hands[e.side].port = "done";
        break;
      case "manual-flash":
        view.manualFlash = { left: e.left, right: e.right };
        break;
      case "manual-flash-done":
        view.manualFlash = null;
        break;
      case "done":
        view.done = e.build;
        view.checked = e.checked;
        view.manual = null;
        view.drive = null;
        view.updatePort = null;
        view.grantPort = null;
        break;
      case "error":
        view.error = e.message;
        view.manual = null;
        view.plugIn = null;
        view.drive = null;
        view.updatePort = null;
        view.grantPort = null;
        view.manualFlash = null;
        view.switched = null;
        for (const side of ["left", "right"] as const) {
          for (const k of ["keys", "allow", "port"] as const) if (view.hands[side][k] === "now") view.hands[side][k] = "todo";
        }
        for (const s of STEP_ORDER) if (view.steps[s].state === "active") view.steps[s].state = "error";
        break;
    }
  }
  return view;
}

/** The steps in the order this update takes them. */
export function stepOrder(view: JobView): StepId[] {
  if (view.firstHalf !== "left") return STEP_ORDER;
  return STEP_ORDER.map((id) => (id === "flash-right" ? "flash-left" : id === "flash-left" ? "flash-right" : id));
}
