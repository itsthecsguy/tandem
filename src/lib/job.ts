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
  logs: string[];
  /** The Actions run building this update. */
  runUrl: string | null;
  done: string | null;
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
    logs: [],
    runUrl: null,
    done: null,
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
      case "done":
        view.done = e.build;
        view.manual = null;
        break;
      case "error":
        view.error = e.message;
        view.manual = null;
        view.plugIn = null;
        for (const s of STEP_ORDER) if (view.steps[s].state === "active") view.steps[s].state = "error";
        break;
    }
  }
  return view;
}
