import type { JobEvent, JobSnapshot, Keymap } from "../shared/types";
import { committedDetail } from "../shared/setup";
import { BuildFailed, cachedBuild, cloudBuild, isStock, keptBuild } from "./cloud";
import { flashKeyboard } from "./flasher";
import { failedUpdate, loadState, removeTandem, saveKeymap, saveState, syncWorkspace, updateKinesis, updateTandem } from "./workspace";

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

/** Runs `work` as the one job, which reports how it ended. */
function runJob(work: (emit: Listener, signal: AbortSignal) => Promise<void>): Job {
  if (current?.running) throw new Error("An update is already running");
  const job = new Job();
  current = job;
  for (const l of jobListeners) l(job);

  const { emit, abort } = job;
  (async () => {
    try {
      await work(emit, abort.signal);
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

/** Commit the layout, Kinesis's changes and any newer Tandem, build it on GitHub, then flash both halves. */
export function startUpdate(keymap?: Keymap): Job {
  return runJob(async (emit, signal) => {
    emit({ type: "step", step: "save", state: "active", detail: "Committing to GitHub" });
    let sha: string;
    const saved = keymap ? await saveKeymap(keymap) : null;
    if (saved) {
      sha = saved.sha;
    } else {
      await syncWorkspace(true);
      sha = (await loadState()).syncedSha!;
    }
    // Kinesis's changes first, then Tandem's, which goes on top of whatever
    // they did to the workflow. Both after the layout, so they plan from the
    // keymap just committed. A sync that fails only means the keyboard updates
    // without it for now.
    const synced = await updateKinesis().catch((err: Error) => {
      emit({ type: "note", text: `Tandem couldn't bring in Kinesis's changes this time. ${err.message}` });
      return null;
    });
    if (synced) sha = synced.sha;
    if (synced?.kept.length) emit({ type: "note", text: `Kinesis changed these files too, and Tandem kept yours: ${synced.kept.join(", ")}.` });
    const updated = await updateTandem();
    if (updated) sha = updated;
    if (synced || updated || saved?.committed) {
      const detail = committedDetail(sha, { layout: !!saved?.committed, kinesis: !!synced, tandem: !!updated });
      emit({ type: "step", step: "save", state: "done", detail });
    } else {
      emit({ type: "step", step: "save", state: "skipped", detail: `No changes, using ${sha.slice(0, 7)}` });
    }

    const state = await loadState();
    let build = cachedBuild(sha, state.settings);
    if (build) {
      emit({ type: "step", step: "build", state: "skipped", detail: `Already built ${build.id}` });
      emit({ type: "step", step: "download", state: "skipped", detail: "Downloaded before" });
    } else {
      try {
        build = await cloudBuild(sha, state.settings, emit, signal);
      } catch (err) {
        const commit = err instanceof BuildFailed ? await failedUpdate().catch(() => null) : null;
        if (commit) emit({ type: "undoable", commit });
        throw err;
      }
      await saveState({ lastBuild: build });
    }

    await flashKeyboard(build, emit, signal);
    emit({ type: "done", build: build.id, checked: true });
  });
}

/** Puts a build kept on disk back on the keyboard. The repo stays as it is. */
export function startRollback(key: string): Job {
  return runJob(async (emit, signal) => {
    const build = keptBuild(key);
    if (!build) throw new Error("That build is no longer on this computer.");
    emit({ type: "rollback", build: build.id });
    emit({ type: "step", step: "save", state: "skipped", detail: "Your repo stays as it is" });
    emit({ type: "step", step: "build", state: "skipped", detail: `Already built ${build.id}` });
    emit({ type: "step", step: "download", state: "skipped", detail: "Kept on this computer" });
    const stock = isStock(key);
    await flashKeyboard(build, emit, signal, { stock });
    emit({ type: "done", build: build.id, checked: !stock });
  });
}

/** Takes Tandem out of the repo, builds Kinesis's firmware with the user's layout, and puts it on the keyboard. */
export function startLeaving(): Job {
  return runJob(async (emit, signal) => {
    emit({ type: "leaving" });
    emit({ type: "step", step: "save", state: "active", detail: "Removing Tandem from your repo" });
    const sha = await removeTandem();
    emit({ type: "step", step: "save", state: "done", detail: `Tandem is out of your repo, ${sha.slice(0, 7)}` });
    const state = await loadState();
    let build = cachedBuild(sha, state.settings);
    if (build) {
      emit({ type: "step", step: "build", state: "skipped", detail: `Already built ${build.id}` });
      emit({ type: "step", step: "download", state: "skipped", detail: "Downloaded before" });
    } else {
      build = await cloudBuild(sha, state.settings, emit, signal, { stock: true });
    }
    await saveState({ lastBuild: build });
    await flashKeyboard(build, emit, signal, { stock: true });
    emit({ type: "done", build: build.id, checked: false });
  });
}
