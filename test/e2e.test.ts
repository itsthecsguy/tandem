// The engine against the real GitHub, for what the fake can't promise: tree
// deletions, merge commits on a fork, new branches and GitHub's own answers.
// Skipped unless TANDEM_E2E_TOKEN is set; `npm run e2e` sets it from the
// GitHub CLI. It keeps two throwaway repos under the token's account and
// makes them on the first run:
//
// - tandem-e2e, private, made from Tandem's template as it was published. It
//   stands for a user on whatever release the template had then.
// - tandem-e2e-fork, a fork of Kinesis's config.
//
// Each run works on new branches and deletes them after. Actions stay off in
// both repos, so nothing builds.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BETA_BRANCH } from "../shared/beta";
import { GitHubApi, GitHubError, type TreeChange, type TreeEntry } from "../shared/github";
import { importKeymap } from "../shared/keymap";
import { readLayout } from "../shared/layout";
import pins from "../shared/pins.json";
import { HOLD_PATH, KEYMAP_PATH, MANIFEST_PATH, WORKFLOW_PATH, patchManifest, patchWorkflow, readHold } from "../shared/setup";
import { KINESIS_BASE_PATH, planSync } from "../shared/sync";
import type { RepoRef } from "../shared/types";
import { saveToken } from "../src/engine/store";
import * as ws from "../src/engine/workspace";

const TOKEN = process.env.TANDEM_E2E_TOKEN;
const TEMPLATE = { owner: "itsthecsguy", name: "tandem-config" };
const KINESIS = { owner: "KinesisCorporation", name: "Adv360-Pro-ZMK" };
const PORT = { owner: pins.beta.repo.split("/")[0], name: pins.beta.repo.split("/")[1] };
// Kinesis's config before the Clique update. Since then Kinesis changed the
// workflow, the manifest, the keymap and board files, and added two files.
const OLD = "8988c99";
const PIN = pins.kinesis.sha;
const ROOT = join(__dirname, "..");
const TIMEOUT = 300_000;

const text = (data: Uint8Array) => new TextDecoder().decode(data);
const blobSha = (data: Uint8Array) => createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");

let gh: GitHubApi;
let owner: string;
let old: string;
const made: { repo: string; branch: string }[] = [];
const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);

/** Every file the template ships, by path, as Git would hash it. */
function templateFiles(): Map<string, string> {
  const dir = join(ROOT, "template");
  const files = new Map<string, string>();
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name !== ".DS_Store") files.set(relative(dir, path), blobSha(readFileSync(path)));
    }
  };
  walk(dir);
  return files;
}

async function waitFor<T>(what: string, check: () => Promise<T | null>): Promise<T> {
  for (let i = 0; i < 30; i++) {
    const value = await check().catch((err) => {
      if (err instanceof GitHubError && (err.status === 404 || err.status === 409)) return null;
      throw err;
    });
    if (value) return value;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Gave up waiting for ${what}`);
}

/** The repo, made the first time. */
async function throwaway(name: string, make: () => Promise<unknown>): Promise<string> {
  try {
    return (await gh.repo(owner, name)).defaultBranch;
  } catch (err) {
    if (!(err instanceof GitHubError && err.status === 404)) throw err;
  }
  await make();
  const repo = await waitFor(`${owner}/${name}`, () => gh.repo(owner, name));
  await waitFor(`${owner}/${name} to have files`, () => gh.head(owner, name, repo.defaultBranch));
  await gh.json("PUT", `/repos/${owner}/${name}/actions/permissions`, { enabled: false });
  return repo.defaultBranch;
}

/** A new branch for this run, at `sha`. */
async function branch(name: string, label: string, sha: string): Promise<RepoRef> {
  const ref = { owner, name, branch: `e2e-${stamp}-${label}` };
  await gh.createBranch(owner, name, ref.branch, sha);
  made.push({ repo: name, branch: ref.branch });
  return ref;
}

async function deleteBranch(repo: string, name: string) {
  await gh.json("DELETE", `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(name)}`).catch((err) => {
    if (!(err instanceof GitHubError && (err.status === 404 || err.status === 422))) throw err;
  });
}

const tree = (ref: RepoRef, sha: string) => gh.tree(ref.owner, ref.name, sha);
const file = async (ref: RepoRef, path: string, sha: string) => (await gh.file(ref.owner, ref.name, path, sha)) ?? "";
const kinesisText = async (entry: TreeEntry) => text(await gh.blob(KINESIS.owner, KINESIS.name, entry.sha));

/** Paths whose files differ between two trees. */
function differences(a: Map<string, TreeEntry>, b: Map<string, TreeEntry>): string[] {
  return [...new Set([...a.keys(), ...b.keys()])].filter((p) => a.get(p)?.sha !== b.get(p)?.sha).sort();
}

/**
 * Turns a branch of the template repo back to how a repo made from Kinesis's
 * older config would look with Tandem added: each file Kinesis changed since
 * goes back, with Tandem's edits where Tandem makes them.
 */
async function backdate(ref: RepoRef): Promise<string> {
  const head = await gh.head(ref.owner, ref.name, ref.branch);
  const [then, now, ours] = await Promise.all([gh.tree(KINESIS.owner, KINESIS.name, old), gh.tree(KINESIS.owner, KINESIS.name, PIN), tree(ref, head)]);
  const { rows } = readLayout(await file(ref, "config/info.json", head));
  const changes: TreeChange[] = [];
  for (const path of differences(then, now)) {
    const was = then.get(path);
    // The template keeps its own readme, and leaves out what doesn't build.
    // GitHub refuses to delete a file a tree doesn't have.
    if (path === "README.md" || !ours.has(path)) continue;
    if (!was) changes.push({ path, sha: null });
    else if (path === WORKFLOW_PATH) changes.push({ path, content: patchWorkflow(await kinesisText(was))! });
    else if (path === MANIFEST_PATH) changes.push({ path, content: patchManifest(await kinesisText(was)) });
    else if (path === KEYMAP_PATH) changes.push({ path, content: importKeymap(await kinesisText(was), rows).text });
    else changes.push({ path, mode: was.mode, sha: await gh.putBlob(ref.owner, ref.name, await gh.blob(KINESIS.owner, KINESIS.name, was.sha)) });
  }
  changes.push({ path: KINESIS_BASE_PATH, content: `${old}\n` });
  return gh.commitChanges(ref.owner, ref.name, ref.branch, head, changes, `Back to Kinesis ${OLD}, for a test`);
}

/** Connects the engine to a branch and runs an update's GitHub half, Kinesis first like startUpdate. */
async function update(ref: RepoRef) {
  ws.connectRepo(ref);
  const kinesis = await ws.updateKinesis();
  const tandem = await ws.updateTandem();
  return { kinesis, tandem };
}

describe.skipIf(!TOKEN)("real GitHub", () => {
  let template: string;
  let fork: string;

  beforeAll(async () => {
    gh = new GitHubApi(TOKEN!);
    owner = (await gh.whoami()).login;
    saveToken({ token: TOKEN!, scope: "repo workflow" });
    old = (await gh.commitOf(KINESIS.owner, KINESIS.name, OLD)).sha;

    const templateBranch = await throwaway("tandem-e2e", () =>
      gh.generate(TEMPLATE, { owner, name: "tandem-e2e", private: true, description: "Tandem's end-to-end tests. Safe to delete." }),
    );
    template = await gh.head(owner, "tandem-e2e", templateBranch);
    await throwaway("tandem-e2e-fork", () =>
      gh.json("POST", `/repos/${KINESIS.owner}/${KINESIS.name}/forks`, { name: "tandem-e2e-fork", default_branch_only: true }),
    );
    fork = old;

    // Branches an earlier run kept, or didn't get to delete.
    for (const repo of ["tandem-e2e", "tandem-e2e-fork"]) {
      for (const name of await gh.branches(owner, repo)) if (name.startsWith("e2e-")) await deleteBranch(repo, name);
    }
  }, TIMEOUT);

  afterAll(async () => {
    if (process.env.TANDEM_E2E_KEEP) return;
    for (const { repo, branch } of made) await deleteBranch(repo, branch);
  }, TIMEOUT);

  it("brings an older repo up to Kinesis's tested commit and this release, then leaves Tandem", async () => {
    const ref = await branch("tandem-e2e", "update", template);
    const before = await tree(ref, await backdate(ref));
    const kinesisThen = await gh.tree(KINESIS.owner, KINESIS.name, old);
    const added = [...(await gh.tree(KINESIS.owner, KINESIS.name, PIN)).keys()].filter((p) => !kinesisThen.has(p));
    expect(added.length).toBeGreaterThan(0);
    for (const path of added) expect(before.has(path), path).toBe(false);

    const { kinesis, tandem } = await update(ref);
    // The template has its own readme.
    expect(kinesis?.kept).toEqual(["README.md"]);
    expect(tandem).toBeTruthy();
    expect((await gh.commitOf(owner, ref.name, kinesis!.sha)).title).toBe(`Sync with Kinesis ${PIN.slice(0, 7)}`);
    expect((await gh.commitOf(owner, ref.name, tandem!)).title).toMatch(/^Update Tandem to release \d+$/);

    // Every file is the template's, as a new repo would get it, apart from the
    // readme, which stays the user's, and files Kinesis added that the
    // template leaves out, such as scripts for building on a computer.
    const after = await tree(ref, tandem!);
    const expected = templateFiles();
    const mismatched = [...new Set([...expected.keys(), ...after.keys()])].filter((p) => expected.get(p) !== after.get(p)?.sha);
    expect(mismatched).toEqual(["README.md", ...added.filter((p) => !expected.has(p))].sort());

    // Nothing left to do.
    expect(await update(ref)).toEqual({ kinesis: null, tandem: null });

    // The ZMK 4.1 trial, from here.
    await deleteBranch(ref.name, BETA_BRANCH);
    made.push({ repo: ref.name, branch: BETA_BRANCH });
    const kept = await ws.startBeta();
    expect(kept).toEqual(["README.md"]);
    const trialHead = await gh.head(owner, ref.name, BETA_BRANCH);
    const trial = await gh.commitOf(owner, ref.name, trialHead);
    expect(trial.title).toBe(`Try ${pins.beta.name}`);
    expect(trial.parents).toEqual([tandem]);
    expect(await gh.head(owner, ref.name, ref.branch)).toBe(tandem);
    const [portBase, port, trialTree] = await Promise.all([gh.tree(PORT.owner, PORT.name, pins.beta.base), gh.tree(PORT.owner, PORT.name, pins.beta.sha), tree(ref, trialHead)]);
    for (const path of differences(portBase, port)) {
      const want = port.get(path);
      if (path === "README.md") expect(trialTree.get(path)?.sha).toBe(after.get(path)?.sha);
      // Gone from the port, or something the template never had, like the Dockerfile.
      else if (!want || (!after.has(path) && portBase.has(path))) expect(trialTree.has(path), path).toBe(false);
      else if (path === WORKFLOW_PATH) expect(await file(ref, path, trialHead)).toContain("tandem/zmk-tandem");
      else expect(trialTree.get(path)?.sha, path).toBe(want.sha);
    }
    ws.connectRepo(ref);
    expect(await ws.startBeta()).toEqual([]);
    expect(await gh.head(owner, ref.name, BETA_BRANCH)).toBe(trialHead);

    // Leaving puts back Kinesis's workflow and manifest and takes out the module.
    ws.connectRepo(ref);
    const left = await ws.removeTandem();
    const gone = await tree(ref, left);
    const kinesisNow = await gh.tree(KINESIS.owner, KINESIS.name, PIN);
    expect([...gone.keys()].filter((p) => p.startsWith("tandem/"))).toEqual([]);
    expect(gone.get(WORKFLOW_PATH)?.sha).toBe(kinesisNow.get(WORKFLOW_PATH)?.sha);
    expect(gone.get(MANIFEST_PATH)?.sha).toBe(kinesisNow.get(MANIFEST_PATH)?.sha);
    // A second try finds nothing to do and commits nothing.
    expect(await ws.removeTandem()).toBe(left);
  }, TIMEOUT);

  it("undoes Tandem's update and Kinesis's sync, and holds both back", async () => {
    const ref = await branch("tandem-e2e", "undo", template);
    await backdate(ref);
    // The user changed their layout, so Kinesis's new default doesn't replace it.
    const head = await gh.head(owner, ref.name, ref.branch);
    const edited = `${await file(ref, KEYMAP_PATH, head)}// my change\n`;
    const mine = await gh.commit(owner, ref.name, ref.branch, head, [{ path: KEYMAP_PATH, content: edited }], "Change my layout");

    const { kinesis, tandem } = await update(ref);
    expect(kinesis?.kept).toEqual(["README.md", KEYMAP_PATH]);
    expect(await file(ref, KEYMAP_PATH, tandem!)).toBe(edited);

    const history = await ws.updateHistory();
    expect(history.map((c) => c.sha)).toEqual([tandem, kinesis!.sha]);

    // Undoing Tandem's update gives back the synced files, holding this release.
    const undoTandem = await ws.undoUpdate(tandem!);
    expect(differences(await tree(ref, kinesis!.sha), await tree(ref, undoTandem))).toEqual([HOLD_PATH]);
    const release = readHold(await file(ref, HOLD_PATH, undoTandem)).tandem;
    expect(release).toBeGreaterThan(0);

    // Undoing the sync deletes what it added and puts the old files back.
    const undoSync = await ws.undoUpdate(kinesis!.sha);
    expect(differences(await tree(ref, mine), await tree(ref, undoSync))).toEqual([HOLD_PATH]);
    expect(readHold(await file(ref, HOLD_PATH, undoSync))).toEqual({ tandem: release, kinesis: PIN });
    expect((await file(ref, KINESIS_BASE_PATH, undoSync)).trim()).toBe(old);

    // Both stay out of the next update, and there's nothing left to undo.
    expect(await update(ref)).toEqual({ kinesis: null, tandem: null });
    expect(await ws.updateHistory()).toEqual([]);
  }, TIMEOUT);

  it("syncs a fork with a merge commit, and undoes it", async () => {
    const ref = await branch("tandem-e2e-fork", "fork", fork);
    ws.connectRepo(ref);
    const installed = await ws.installTandem();
    expect((await gh.commitOf(owner, ref.name, installed)).title).toBe("Add Tandem automatic updates");

    const { kinesis, tandem } = await update(ref);
    expect(tandem).toBeNull();
    const merge = await gh.commitOf(owner, ref.name, kinesis!.sha);
    expect(merge.parents).toEqual([installed, PIN]);
    expect((await gh.compare(KINESIS.owner, KINESIS.name, PIN, `${owner}:${ref.branch}`)).behindBy).toBe(0);

    // Kinesis's files as they are now, with Tandem's edits where Tandem makes them.
    const [kinesisNow, synced] = await Promise.all([gh.tree(KINESIS.owner, KINESIS.name, PIN), tree(ref, kinesis!.sha)]);
    const { rows } = readLayout(await file(ref, "config/info.json", kinesis!.sha));
    for (const [path, entry] of kinesisNow) {
      if (path === WORKFLOW_PATH) expect(await file(ref, path, kinesis!.sha)).toBe(patchWorkflow(await kinesisText(entry)));
      else if (path === MANIFEST_PATH) expect(await file(ref, path, kinesis!.sha)).toBe(patchManifest(await kinesisText(entry)));
      else if (path === KEYMAP_PATH) expect(await file(ref, path, kinesis!.sha)).toBe(importKeymap(await kinesisText(entry), rows).text);
      else expect(synced.get(path)?.sha, path).toBe(entry.sha);
    }

    // Undoing keeps the merge in history but takes its changes out, and the
    // marker says where the next sync starts.
    const undone = await ws.undoUpdate(kinesis!.sha);
    expect(differences(await tree(ref, installed), await tree(ref, undone))).toEqual([HOLD_PATH, KINESIS_BASE_PATH]);
    expect((await file(ref, KINESIS_BASE_PATH, undone)).trim()).toBe(old);
    const plan = await planSync(gh, ref, undone);
    expect(plan?.status.held).toBe(true);
    expect(plan?.merged).toEqual([PIN]);
    expect(await update(ref)).toEqual({ kinesis: null, tandem: null });
  }, TIMEOUT);
});
