import type { JobEvent, JobSnapshot, Keymap } from "../shared/types";
import { cachedBuild, cloudBuild } from "./cloud";
import { flashKeyboard } from "./flasher";
import { loadState, saveKeymap, saveState, syncWorkspace, updateTandem } from "./workspace";

type Listener = (e: JobEvent) => void;

class Job {
  readonly id = Math.random().toString(36).slice(2, 10);
  readonly events: JobEvent[] = [];
  readonly abort = new AbortController();
  running = true;
  private listeners = new Set<Listener>();

  emit = (e: JobEvent) => {
    this.events.push(e);
    for (const l of this.listeners) l(e);
  };

  subscribe(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  snapshot(): JobSnapshot {
    return { id: this.id, running: this.running, events: this.events };
  }
}

let current: Job | null = null;
const jobListeners = new Set<(job: Job) => void>();

export function currentJob() {
  return current;
}

export function onJobStart(l: (job: Job) => void) {
  jobListeners.add(l);
  return () => jobListeners.delete(l);
}

export function cancelJob() {
  current?.abort.abort(new Error("Cancelled"));
}

/** Commit the layout and any newer Tandem, build it on GitHub, then flash both halves. */
export function startUpdate(keymap?: Keymap): Job {
  if (current?.running) throw new Error("An update is already running");
  const job = new Job();
  current = job;
  for (const l of jobListeners) l(job);

  const { emit, abort } = job;
  (async () => {
    try {
      emit({ type: "step", step: "save", state: "active", detail: "Committing to GitHub" });
      let sha: string;
      const saved = keymap ? await saveKeymap(keymap) : null;
      if (saved) {
        sha = saved.sha;
      } else {
        await syncWorkspace(true);
        sha = (await loadState()).syncedSha!;
      }
      // After the layout, so the update plans from the keymap just committed.
      const updated = await updateTandem();
      if (updated) {
        sha = updated;
        const what = saved?.committed ? "your layout and Tandem's update" : "Tandem's update";
        emit({ type: "step", step: "save", state: "done", detail: `Committed ${what}, ${sha.slice(0, 7)}` });
      } else if (saved?.committed) {
        emit({ type: "step", step: "save", state: "done", detail: `Committed ${sha.slice(0, 7)}` });
      } else {
        emit({ type: "step", step: "save", state: "skipped", detail: `No changes, using ${sha.slice(0, 7)}` });
      }

      const state = await loadState();
      let build = cachedBuild(sha, state.settings);
      if (build) {
        emit({ type: "step", step: "build", state: "skipped", detail: `Already built ${build.id}` });
        emit({ type: "step", step: "download", state: "skipped", detail: "Downloaded before" });
      } else {
        build = await cloudBuild(sha, state.settings, emit, abort.signal);
        await saveState({ lastBuild: build });
      }

      await flashKeyboard(build, emit, abort.signal);
      emit({ type: "done", build: build.id, checked: true });
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

  return job;
}
