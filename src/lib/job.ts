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

export interface JobView {
  steps: Record<StepId, { state: StepState; detail?: string }>;
  manual: { side: Side; reason: "no-autoflash" | "no-response" } | null;
  plugIn: Side | null;
  /** The browser needs the user to choose this half's drive. */
  drive: Side | null;
  /** The browser needs the user's OK, once, to open this half's update port. */
  updatePort: Side | null;
  /** The browser needs the user to allow this half's port, before or after flashing it. */
  grantPort: { side: Side; before: boolean } | null;
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
        break;
      case "log":
        view.logs.push(e.line);
        break;
      case "run":
        view.runUrl = e.url;
        break;
      case "manual":
        view.manual = { side: e.side, reason: e.reason };
        if (e.reason === "no-autoflash") view.setup = true;
        break;
      case "manual-done":
        if (view.manual?.side === e.side) view.manual = null;
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
        break;
      case "update-port-done":
        if (view.updatePort === e.side) view.updatePort = null;
        if (view.manual?.side === e.side) view.manual = null;
        break;
      case "grant-port":
        view.grantPort = { side: e.side, before: !!e.before };
        break;
      case "grant-port-done":
        if (view.grantPort?.side === e.side) view.grantPort = null;
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
        for (const s of STEP_ORDER) if (view.steps[s].state === "active") view.steps[s].state = "error";
        break;
    }
  }
  return view;
}
