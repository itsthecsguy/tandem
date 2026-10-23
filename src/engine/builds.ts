// Firmware builds run in the user's GitHub Actions. Tandem finds the run for a
// commit, follows the job for the firmware variant it wants, and downloads
// that job's artifact as soon as the job finishes. Downloads are kept in
// IndexedDB, so updating to a build already downloaded skips GitHub.

import { unzipSync } from "fflate";

import type { GitHubApi, RunJob, WorkflowRun } from "../../shared/github";
import type { BuildSettings, JobEvent, RepoRef, Side } from "../../shared/types";
import { getBuild, putBuild } from "./store";
import { sleep } from "./util";

type Emit = (e: JobEvent) => void;

export interface Build {
  id: string;
  createdAt: string;
  left: Uint8Array;
  right: Uint8Array;
}

// Kinesis's workflow builds two variants. Studio is what Kinesis calls Clique.
function variant(settings: BuildSettings) {
  return settings.studio ? { job: /clique/i, artifact: "firmware-clique" } : { job: /legacy/i, artifact: "firmware-no-clique" };
}

const cacheKey = (sha: string, settings: BuildSettings) => `${sha.slice(0, 7)}-${variant(settings).artifact}`;

export async function cachedBuild(sha: string, settings: BuildSettings): Promise<Build | null> {
  const stored = await getBuild(cacheKey(sha, settings)).catch(() => null);
  return stored && { id: stored.id, createdAt: stored.createdAt, left: stored.left, right: stored.right };
}

function describe(job: RunJob | undefined): string {
  if (!job || job.status === "queued") return "Waiting for a GitHub runner";
  const step = job.steps?.find((s) => s.status === "in_progress");
  return step ? `On GitHub: ${step.name}` : "Running on GitHub";
}

const isUf2 = (data: Uint8Array) => new TextDecoder().decode(data.subarray(0, 4)) === "UF2\n";

/** Picks each half's firmware out of an artifact's zip. */
export function firmwareFromZip(zip: Uint8Array): Record<Side, Uint8Array> {
  const files = unzipSync(zip);
  const names = Object.keys(files);
  const pick = (side: Side) => {
    const name = names.find((n) => n.endsWith(`-${side}.uf2`)) ?? names.find((n) => n === `${side}.uf2`);
    if (!name) throw new Error(`The artifact has no ${side} firmware.`);
    if (!isUf2(files[name])) throw new Error(`The ${side} firmware isn't a UF2 file.`);
    return files[name];
  };
  return { left: pick("left"), right: pick("right") };
}

export async function cloudBuild(
  gh: GitHubApi,
  repo: RepoRef,
  sha: string,
  settings: BuildSettings,
  emit: Emit,
  signal: AbortSignal,
): Promise<Build> {
  const { owner, name } = repo;
  const want = variant(settings);
  const id = sha.slice(0, 7);

  emit({ type: "step", step: "build", state: "active", detail: "Waiting for GitHub to start the build" });
  let run: WorkflowRun | null = null;
  const started = Date.now();
  let dispatched = false;
  while (!run) {
    run = await gh.runFor(owner, name, sha);
    if (run) break;
    // A repo created from the template starts without a push, so nothing
    // built its first commit. Start the build by hand.
    if (!dispatched && Date.now() - started > 15_000) {
      dispatched = true;
      await gh.dispatch(owner, name, "build.yml", repo.branch).catch(() => {});
    }
    if (Date.now() - started > 120_000) {
      throw new Error(`GitHub didn't start a build for ${id}. Check that Actions is turned on for ${owner}/${name}.`);
    }
    await sleep(3000, signal);
  }
  emit({ type: "run", url: run.html_url });

  // Follow the job for our variant. Fall back to the whole run if the
  // workflow names its jobs differently.
  for (;;) {
    signal.throwIfAborted();
    const jobs = await gh.jobs(owner, name, run.id);
    const job = jobs.find((j) => want.job.test(j.name));
    if (job?.status === "completed" || (!job && run.status === "completed")) {
      const conclusion = job ? job.conclusion : run.conclusion;
      if (conclusion !== "success") throw new Error(`The firmware build failed on GitHub (${conclusion}). Open the run to see why.`);
      break;
    }
    emit({ type: "step", step: "build", state: "active", detail: describe(job) });
    await sleep(4000, signal);
    run = await gh.getRun(owner, name, run.id);
  }
  emit({ type: "step", step: "build", state: "done", detail: `Built ${id}` });

  emit({ type: "step", step: "download", state: "active", detail: want.artifact });
  let artifact = null;
  for (let i = 0; i < 10 && !artifact; i++) {
    artifact = (await gh.artifacts(owner, name, run.id)).find((a) => a.name === want.artifact && !a.expired) ?? null;
    if (!artifact) await sleep(2000, signal);
  }
  if (!artifact) throw new Error(`The build finished but has no ${want.artifact} artifact.`);

  const { left, right } = firmwareFromZip(await gh.artifactZip(owner, name, artifact.id));
  const build: Build = { id, createdAt: new Date().toISOString(), left, right };
  await putBuild({ key: cacheKey(sha, settings), ...build }).catch(() => {
    // Not being able to keep it only means downloading it again next time.
  });
  emit({ type: "step", step: "download", state: "done", detail: `${Math.round(artifact.size_in_bytes / 1024)} KB` });
  return build;
}
