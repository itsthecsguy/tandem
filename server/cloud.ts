// Firmware builds run in the user's GitHub Actions. Tandem finds the run for
// a commit, follows the job that builds the firmware variant it wants, and
// downloads that job's artifact as soon as the job finishes.

import { existsSync } from "node:fs";
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";

import type { BuildRecord, BuildSettings, JobEvent } from "../shared/types";
import { type RunJob, type WorkflowRun } from "./github";
import { BUILDS_DIR, github, loadState } from "./workspace";

type Emit = (e: JobEvent) => void;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });

// Kinesis's workflow builds two variants. Studio is what Kinesis calls Clique.
function variant(settings: BuildSettings) {
  return settings.studio
    ? { job: /clique/i, artifact: "firmware-clique" }
    : { job: /legacy/i, artifact: "firmware-no-clique" };
}

function buildDir(sha: string, settings: BuildSettings) {
  return join(BUILDS_DIR, `${sha.slice(0, 7)}-${variant(settings).artifact}`);
}

export function cachedBuild(sha: string, settings: BuildSettings): BuildRecord | null {
  const id = sha.slice(0, 7);
  const dir = buildDir(sha, settings);
  const left = join(dir, "left.uf2");
  const right = join(dir, "right.uf2");
  return existsSync(left) && existsSync(right) ? { id, createdAt: "", left, right } : null;
}

function describe(job: RunJob | undefined): string {
  if (!job || job.status === "queued") return "Waiting for a GitHub runner";
  const step = job.steps?.find((s) => s.status === "in_progress");
  return step ? `On GitHub: ${step.name}` : "Running on GitHub";
}

export async function cloudBuild(sha: string, settings: BuildSettings, emit: Emit, signal: AbortSignal): Promise<BuildRecord> {
  const gh = await github();
  const { repo } = await loadState();
  if (!repo) throw new Error("Choose a keyboard repo first");
  const { owner, name } = repo;
  const want = variant(settings);
  const id = sha.slice(0, 7);

  emit({ type: "step", step: "build", state: "active", detail: "Waiting for GitHub to start the build" });
  let run: WorkflowRun | null = null;
  const startBy = Date.now() + 120_000;
  while (!run) {
    run = await gh.runFor(owner, name, sha);
    if (run) break;
    if (Date.now() > startBy) {
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
      if (conclusion !== "success") {
        throw new Error(`The firmware build failed on GitHub (${conclusion}). Open the run to see why.`);
      }
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

  const dir = buildDir(sha, settings);
  const files = await gh.downloadArtifact(owner, name, artifact.id, dir);
  for (const side of ["left", "right"] as const) {
    const file = files.find((f) => f.endsWith(`-${side}.uf2`)) ?? files.find((f) => f === `${side}.uf2`);
    if (!file) throw new Error(`The artifact has no ${side} firmware.`);
    if (file !== `${side}.uf2`) await rename(join(dir, file), join(dir, `${side}.uf2`));
    const head = (await readFile(join(dir, `${side}.uf2`))).subarray(0, 4).toString("latin1");
    if (head !== "UF2\n") throw new Error(`The ${side} firmware isn't a UF2 file.`);
  }
  emit({ type: "step", step: "download", state: "done", detail: `${Math.round(artifact.size_in_bytes / 1024)} KB` });

  return { id, createdAt: new Date().toISOString(), left: join(dir, "left.uf2"), right: join(dir, "right.uf2") };
}
