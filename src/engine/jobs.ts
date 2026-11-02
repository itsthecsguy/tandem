// An update in the browser: commit the layout and any newer Tandem, build it
// on GitHub, then put it on the keyboard. How it gets onto the keyboard
// depends on what this browser can do, so the engine passes that step in.

import type { JobEvent, JobSnapshot, Keymap } from "../../shared/types";
import { committedDetail } from "../../shared/setup";
import { type Build, BuildFailed, cachedBuild, cloudBuild, keptBuild } from "./builds";
import { loadJob, loadState, saveJob, saveState } from "./store";
import { connectedRepo, failedUpdate, github, openWorkspace, removeTandem, saveKeymap, updateKinesis, updateTandem } from "./workspace";

export type Emit = (e: JobEvent) => void;

/**
 * Puts a build on both halves. Resolves true if it checked that both run it.
 * With `stock`, the build has no Tandem in it, so nothing can ask the halves.
 */
export type Flash = (build: Build, emit: Emit, signal: AbortSignal, options?: { stock?: boolean }) => Promise<boolean>;

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

type Listen = { start: (job: JobSnapshot) => void; event: (e: JobEvent) => void };

/** Runs `work` as the one job, which reports how it ended. */
function runJob(listen: Listen, work: (emit: Emit, signal: AbortSignal) => Promise<void>): JobSnapshot {
  if (current?.running) throw new Error("An update is already running");
  const job = new Job(listen.event);
  current = job;
  listen.start(job.snapshot());

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

  return job.snapshot();
}

export function startUpdate(keymap: Keymap | undefined, flash: Flash, listen: Listen): JobSnapshot {
  return runJob(listen, async (emit, signal) => {
    emit({ type: "step", step: "save", state: "active", detail: "Committing to GitHub" });
    const saved = keymap ? await saveKeymap(keymap) : null;
    let sha = saved ? saved.sha : (await openWorkspace(true)).sha;
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

    const { settings } = loadState();
    let build = await cachedBuild(sha, settings);
    if (build) {
      emit({ type: "step", step: "build", state: "skipped", detail: `Already built ${build.id}` });
      emit({ type: "step", step: "download", state: "skipped", detail: "Downloaded before" });
    } else {
      try {
        build = await cloudBuild(await github(), connectedRepo(), sha, settings, emit, signal);
      } catch (err) {
        const commit = err instanceof BuildFailed ? await failedUpdate().catch(() => null) : null;
        if (commit) emit({ type: "undoable", commit });
        throw err;
      }
    }
    saveState({ lastBuild: { id: build.id, createdAt: build.createdAt, left: "browser", right: "browser" } });

    const checked = await flash(build, emit, signal);
    emit({ type: "done", build: build.id, checked });
  });
}

/** Puts a build this browser kept back on the keyboard. The repo stays as it is. */
export function startRollback(key: string, flash: Flash, listen: Listen): JobSnapshot {
  return runJob(listen, async (emit, signal) => {
    const build = await keptBuild(key);
    if (!build) throw new Error("This browser no longer has that build.");
    emit({ type: "rollback", build: build.id });
    emit({ type: "step", step: "save", state: "skipped", detail: "Your repo stays as it is" });
    emit({ type: "step", step: "build", state: "skipped", detail: `Already built ${build.id}` });
    emit({ type: "step", step: "download", state: "skipped", detail: "Kept in this browser" });
    const checked = await flash(build, emit, signal, { stock: build.stock });
    emit({ type: "done", build: build.id, checked });
  });
}

/** Takes Tandem out of the repo, builds Kinesis's firmware with the user's layout, and puts it on the keyboard. */
export function startLeaving(flash: Flash, listen: Listen): JobSnapshot {
  return runJob(listen, async (emit, signal) => {
    emit({ type: "leaving" });
    emit({ type: "step", step: "save", state: "active", detail: "Removing Tandem from your repo" });
    const sha = await removeTandem();
    emit({ type: "step", step: "save", state: "done", detail: `Tandem is out of your repo, ${sha.slice(0, 7)}` });
    const { settings } = loadState();
    let build = await cachedBuild(sha, settings);
    if (build) {
      emit({ type: "step", step: "build", state: "skipped", detail: `Already built ${build.id}` });
      emit({ type: "step", step: "download", state: "skipped", detail: "Downloaded before" });
    } else {
      build = await cloudBuild(await github(), connectedRepo(), sha, settings, emit, signal, { stock: true });
    }
    saveState({ lastBuild: { id: build.id, createdAt: build.createdAt, left: "browser", right: "browser" } });
    const checked = await flash(build, emit, signal, { stock: true });
    emit({ type: "done", build: build.id, checked });
  });
}
