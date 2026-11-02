// Brings Kinesis's changes to its config into a user's repo, so nobody has to
// sync a fork or merge by hand. It goes up to the Kinesis commit this release
// of Tandem tested, not Kinesis's latest, so a bad commit there can't reach
// anyone by itself. See shared/pins.json.
//
// Forks and repos made from Tandem's template take the same path. A repo from
// the template shares no history with Kinesis's, and on a fork GitHub's own
// merge would conflict with Tandem's edits to the workflow and the manifest.
// So Tandem merges each file Kinesis changed: it takes its own edits out of
// the workflow and manifest, merges, and puts them back. A file only counts as
// a conflict when it and Kinesis's change overlap.

import { type CommitSummary, type GitHubApi, GitHubError, type TreeChange, type TreeEntry } from "./github";
import { importKeymap } from "./keymap";
import { readLayout } from "./layout";
import { merge3 } from "./merge";
import pins from "./pins.json";
import { HOLD_PATH, KEYMAP_PATH, MANIFEST_PATH, WORKFLOW_PATH, patchManifest, patchWorkflow, readHold, unpatchManifest, unpatchWorkflow } from "./setup";
import type { KinesisStatus, RepoRef } from "./types";

/** Records the Kinesis commit a repo last synced to, since a repo from the template has no history to tell. */
export const KINESIS_BASE_PATH = "tandem/kinesis-base";

// What the template was made from, for repos made before they recorded it.
const TEMPLATE_BASE = "97f5d7394d36f60754a483bf5551e16d996fe406";

const [KINESIS_OWNER, KINESIS_NAME] = pins.kinesis.repo.split("/");

/** A config repo to merge from: Kinesis's, or a port of it. */
export interface Upstream {
  owner: string;
  name: string;
}

const KINESIS: Upstream = { owner: KINESIS_OWNER, name: KINESIS_NAME };

const PATCHED: Record<string, { unpatch: (text: string) => string; patch: (text: string) => string | null }> = {
  [WORKFLOW_PATH]: { unpatch: unpatchWorkflow, patch: patchWorkflow },
  [MANIFEST_PATH]: { unpatch: unpatchManifest, patch: patchManifest },
};

// Nothing builds from these, and the template has its own. A clash isn't worth stopping for.
const NOT_BUILT = /^(README|LICENSE|\.gitignore|docs\/|assets\/)/;

const text = (data: Uint8Array) => new TextDecoder().decode(data);

type Planned = TreeChange | { path: string; mode: string; upstreamBlob: string };

interface Merge {
  changes: Planned[];
  /** Files the merge left as the repo has them, such as a changed layout. */
  kept: string[];
  /** Files both changed in the same place, which stop the merge. */
  conflicts: string[];
}

export interface SyncPlan {
  status: KinesisStatus;
  changes: Planned[];
  message: string;
  /** Kinesis's commit as a second parent, when the repo is a fork and can have one. */
  merged: string[];
}

/**
 * What syncing would change, reading only. Null when the branch has Kinesis's
 * tested commit already.
 */
export async function planSync(gh: GitHubApi, repo: RepoRef, head: string): Promise<SyncPlan | null> {
  const { owner, name, branch } = repo;
  const to = pins.kinesis.sha;
  const marker = (await gh.file(owner, name, KINESIS_BASE_PATH, head))?.trim() || null;
  if (marker === to) return null;

  // The marker comes first, even on a fork. After a sync is undone, the fork's
  // history still has Kinesis's commit, but its changes are gone. Without a
  // marker, a fork's history says where it stands.
  const fork = (await gh.repo(owner, name)).source === pins.kinesis.repo;
  let base = marker ?? TEMPLATE_BASE;
  if (fork && !marker) {
    const position = await gh.compare(KINESIS_OWNER, KINESIS_NAME, to, `${owner}:${branch}`);
    if (position.behindBy === 0) return null;
    base = position.mergeBase;
  }
  if (base === to) return null;

  const upstream = await gh.compare(KINESIS_OWNER, KINESIS_NAME, base, to);
  if (upstream.status !== "ahead") return null;

  const [merge, hold] = await Promise.all([planMerge(gh, repo, head, KINESIS, base, to), gh.file(owner, name, HOLD_PATH, head)]);
  const { changes, conflicts, kept } = merge;
  changes.push({ path: KINESIS_BASE_PATH, content: `${to}\n` });

  const titles = upstream.commits.map((c) => c.title);
  return {
    status: {
      to,
      commits: titles,
      conflicts,
      kept,
      held: readHold(hold).kinesis === to,
      compareUrl: `https://github.com/${pins.kinesis.repo}/compare/${base}...${to}`,
    },
    changes,
    message: syncMessage(base, to, titles),
    merged: fork ? [to] : [],
  };
}

/**
 * What it takes to bring the changes between two of an upstream's commits into
 * a repo at `head`, reading only.
 */
export async function planMerge(gh: GitHubApi, repo: RepoRef, head: string, upstream: Upstream, base: string, to: string): Promise<Merge> {
  const { owner, name } = repo;
  const [before, after, ours] = await Promise.all([gh.tree(upstream.owner, upstream.name, base), gh.tree(upstream.owner, upstream.name, to), gh.tree(owner, name, head)]);
  const upstreamText = async (entry: TreeEntry | undefined) => (entry ? text(await gh.blob(upstream.owner, upstream.name, entry.sha)) : "");
  const oursText = async (entry: TreeEntry) => text(await gh.blob(owner, name, entry.sha));

  const changes: Planned[] = [];
  const conflicts: string[] = [];
  const kept: string[] = [];

  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(path);
    const now = after.get(path);
    const mine = ours.get(path);
    if (was?.sha === now?.sha) continue;

    if (!now) {
      if (mine?.sha === was!.sha) changes.push({ path, sha: null });
      else if (mine) kept.push(path);
      continue;
    }
    if (!mine) {
      // New upstream. A file upstream had and this repo doesn't was removed on purpose.
      if (!was) changes.push({ path, mode: now.mode, upstreamBlob: now.sha });
      continue;
    }
    if (mine.sha === now.sha) continue;

    if (path === KEYMAP_PATH) {
      // The layout is the user's. Upstream's default only replaces one nobody changed.
      const info = ours.get("config/info.json");
      const current = await oursText(mine);
      const merged = info && mergedKeymap(await upstreamText(was), await upstreamText(now), current, await oursText(info));
      if (!merged) kept.push(path);
      else if (merged !== current) changes.push({ path, mode: mine.mode, content: merged });
      continue;
    }

    const patched = PATCHED[path];
    if (!patched && mine.sha === was?.sha) {
      changes.push({ path, mode: mine.mode, upstreamBlob: now.sha });
      continue;
    }

    const current = await oursText(mine);
    const theirs = await upstreamText(now);
    // Text merging would mangle a binary file, so a clash in one keeps the repo's.
    if (current.includes("\0") || theirs.includes("\0")) {
      kept.push(path);
      continue;
    }
    const merged = merge3(await upstreamText(was), patched ? patched.unpatch(current) : current, theirs);
    const final = merged !== null && patched ? patched.patch(merged) : merged;
    if (final === null) {
      if (NOT_BUILT.test(path)) kept.push(path);
      else conflicts.push(path);
    } else if (final !== current) {
      changes.push({ path, mode: mine.mode, content: final });
    }
  }
  return { changes, kept, conflicts };
}

/** Upstream's new default layout, if `mine` is still the old one. */
function mergedKeymap(was: string, now: string, mine: string, info: string): string | null {
  try {
    const { rows } = readLayout(info);
    return importKeymap(was, rows).text === mine ? importKeymap(now, rows).text : null;
  } catch {
    return null;
  }
}

function syncMessage(base: string, to: string, titles: string[]): string {
  const shown = titles.slice(-20).map((t) => `- ${t}`);
  return `Sync with Kinesis ${to.slice(0, 7)}\n\nBrings in Kinesis's ${pins.kinesis.branch} changes, from ${base} up to ${to}:\n\n${shown.join("\n")}\n`;
}

/** The Kinesis commits a sync commit went from and to. */
export function syncedRange(commit: CommitSummary): { from: string; to: string } | null {
  const range = /changes, from ([0-9a-f]{40}) up to ([0-9a-f]{40})/.exec(commit.message);
  return range && { from: range[1], to: range[2] };
}

/** Turns a plan's changes into ones GitHub can commit to `repo`, copying blobs over from upstream. */
export async function resolveChanges(gh: GitHubApi, repo: RepoRef, upstream: Upstream, planned: Planned[]): Promise<TreeChange[]> {
  const changes: TreeChange[] = [];
  for (const change of planned) {
    if ("upstreamBlob" in change) {
      const sha = await gh.putBlob(repo.owner, repo.name, await gh.blob(upstream.owner, upstream.name, change.upstreamBlob));
      changes.push({ path: change.path, mode: change.mode, sha });
    } else {
      changes.push(change);
    }
  }
  return changes;
}

/** Commits a plan. Returns the new head. */
export async function applySync(gh: GitHubApi, repo: RepoRef, head: string, plan: SyncPlan): Promise<string> {
  const { owner, name, branch } = repo;
  const changes = await resolveChanges(gh, repo, KINESIS, plan.changes);
  try {
    return await gh.commitChanges(owner, name, branch, head, changes, plan.message, plan.merged);
  } catch (err) {
    // A fork shares Kinesis's commits, so this shouldn't happen. A plain commit still syncs it.
    if (!plan.merged.length || !(err instanceof GitHubError && err.status === 422)) throw err;
    return gh.commitChanges(owner, name, branch, head, changes, plan.message);
  }
}
