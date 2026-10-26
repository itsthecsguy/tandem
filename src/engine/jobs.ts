// An update in the browser: commit the layout, build it on GitHub, then put it
// on the keyboard. How it gets onto the keyboard depends on what this browser
// can do, so the engine passes that step in.

import type { JobEvent, JobSnapshot, Keymap } from "../../shared/types";
import { type Build, cachedBuild, cloudBuild } from "./builds";
import { loadJob, loadState, saveJob, saveState } from "./store";
import { connectedRepo, github, openWorkspace, saveKeymap } from "./workspace";

export type Emit = (e: JobEvent) => void;

/** Puts a build on both halves. Resolves true if it checked that both run it. */
export type Flash = (build: Build, emit: Emit, signal: AbortSignal) => Promise<boolean>;

class Job {
  readonly id = Math.random().toString(36).slice(2, 10);
  readonly events: JobEvent[] = [];
  readonly abort = new AbortController();
  running = true;

  constructor(private onEvent: (e: JobEvent) => void) {}

  emit = (e: JobEvent) => {
    this.events.push(e);
    // Kept per tab, so a reload can say where the update stopped.
    saveJob({ ...this.snapshot(), running: e.type !== "done" && e.type !== "error" });
    this.onEvent(e);
  };

  snapshot(): JobSnapshot {
    return { id: this.id, running: this.running, events: [...this.events] };
  }
}

let current: Job | null = null;

/** An update the last page load left running: it stopped when the page went away. */
const interrupted: JobSnapshot | null = (() => {
  const saved = loadJob<JobSnapshot>();
  if (!saved?.running) return null;
  const message =
    "The page reloaded during this update, so it stopped. Run it again. Tandem reuses the build GitHub already made, and a half left in update mode carries on from there.";
  return { ...saved, running: false, interrupted: true, events: [...saved.events, { type: "error", message }] };
})();
saveJob(interrupted);

export function currentJob(): JobSnapshot | null {
  return current?.snapshot() ?? interrupted;
}

export function cancelJob() {
  current?.abort.abort(new Error("Cancelled"));
}

export function startUpdate(
  keymap: Keymap | undefined,
  flash: Flash,
  listen: { start: (job: JobSnapshot) => void; event: (e: JobEvent) => void },
): JobSnapshot {
  if (current?.running) throw new Error("An update is already running");
  const job = new Job(listen.event);
  current = job;
  listen.start(job.snapshot());

  const { emit, abort } = job;
  (async () => {
    try {
      emit({ type: "step", step: "save", state: "active", detail: "Committing to GitHub" });
      let sha: string;
      const saved = keymap ? await saveKeymap(keymap) : null;
      if (saved?.committed) {
        sha = saved.sha;
        emit({ type: "step", step: "save", state: "done", detail: `Committed ${sha.slice(0, 7)}` });
      } else if (saved) {
        sha = saved.sha;
        emit({ type: "step", step: "save", state: "skipped", detail: `No changes, using ${sha.slice(0, 7)}` });
      } else {
        sha = (await openWorkspace(true)).sha;
        emit({ type: "step", step: "save", state: "skipped", detail: `No changes, using ${sha.slice(0, 7)}` });
      }

      const { settings } = loadState();
      let build = await cachedBuild(sha, settings);
      if (build) {
        emit({ type: "step", step: "build", state: "skipped", detail: `Already built ${build.id}` });
        emit({ type: "step", step: "download", state: "skipped", detail: "Downloaded before" });
      } else {
        build = await cloudBuild(await github(), connectedRepo(), sha, settings, emit, abort.signal);
      }
      saveState({ lastBuild: { id: build.id, createdAt: build.createdAt, left: "browser", right: "browser" } });

      const checked = await flash(build, emit, abort.signal);
      emit({ type: "done", build: build.id, checked });
    } catch (err) {
      const message = abort.signal.aborted
        ? "You cancelled the update. Any half left in update mode stays there until you update again or press its reset button."
        : err instanceof Error
          ? err.message
          : String(err);
      emit({ type: "error", message });
    } finally {
      job.running = false;
    }
  })();

  return job.snapshot();
}
