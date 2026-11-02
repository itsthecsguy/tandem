// Taking back what Tandem committed. Undoing a commit makes a new commit that
// puts back the files that commit changed. Other commits since, such as layout
// saves, stay. Undoing also records the release, so the next update doesn't
// bring it straight back.

import type { CommitSummary, GitHubApi, TreeChange } from "./github";
import { HOLD_PATH, MANIFEST_PATH, VERSION_PATH, WORKFLOW_PATH, moduleVersion, readHold, unpatchManifest, unpatchWorkflow } from "./setup";
import { KINESIS_BASE_PATH, syncedRange } from "./sync";
import type { RepoRef, UpdateCommit } from "./types";

const UPDATE = /^(Update Tandem|Sync with Kinesis)\b/;
const UNDOES = /^Undoes ([0-9a-f]{40})\.?$/m;
const HOW_FAR_BACK = 30;

const text = (data: Uint8Array) => new TextDecoder().decode(data);

const summary = (c: CommitSummary): UpdateCommit => ({ sha: c.sha, title: c.title, date: c.date });

function undone(commits: CommitSummary[]): Set<string> {
  return new Set(commits.flatMap((c) => UNDOES.exec(c.message)?.[1] ?? []));
}

/** Tandem's own commits on the branch that are still in effect, newest first. */
export async function updateCommits(gh: GitHubApi, repo: RepoRef): Promise<UpdateCommit[]> {
  const commits = await gh.history(repo.owner, repo.name, repo.branch, HOW_FAR_BACK);
  const gone = undone(commits);
  return commits.filter((c) => UPDATE.test(c.title) && !gone.has(c.sha)).map(summary);
}

/**
 * The commit to offer undoing when a build fails: Tandem's own, if nothing else
 * came after it. Not when the commit under Tandem's didn't build either, or
 * hasn't yet, since that one may be the trouble. An update commits the layout
 * and Tandem's changes together, so a bad layout can sit right under them.
 */
export async function failedUpdate(gh: GitHubApi, repo: RepoRef): Promise<UpdateCommit | null> {
  const commits = await gh.history(repo.owner, repo.name, repo.branch, HOW_FAR_BACK);
  const gone = undone(commits);
  const standing = commits.filter((c) => !UNDOES.test(c.message) && !gone.has(c.sha));
  const latest = standing[0];
  if (!latest || !UPDATE.test(latest.title)) return null;
  const below = standing.find((c) => !UPDATE.test(c.title));
  if (below) {
    const run = await gh.runFor(repo.owner, repo.name, below.sha);
    if (run && (run.status !== "completed" || run.conclusion !== "success")) return null;
  }
  return summary(latest);
}

/** Commits the undo of one of Tandem's commits. Returns the new head. */
export async function undoCommit(gh: GitHubApi, repo: RepoRef, sha: string): Promise<string> {
  const { owner, name, branch } = repo;
  const head = await gh.head(owner, name, branch);
  const target = await gh.commitOf(owner, name, sha);
  if (!UPDATE.test(target.title)) throw new Error(`Tandem only undoes its own updates, not "${target.title}".`);
  const [before, after, now] = await Promise.all([gh.tree(owner, name, target.parents[0]), gh.tree(owner, name, sha), gh.tree(owner, name, head)]);

  const changes: TreeChange[] = [];
  const clashes: string[] = [];
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(path);
    const then = after.get(path);
    if (was?.sha === then?.sha) continue;
    const current = now.get(path);
    if (current?.sha !== then?.sha) {
      clashes.push(path);
      continue;
    }
    changes.push({ path, mode: was?.mode ?? current?.mode, sha: was?.sha ?? null });
  }
  if (clashes.length) {
    throw new Error(`Tandem can't undo "${target.title}" because these files changed after it: ${clashes.join(", ")}.`);
  }

  const holdEntry = now.get(HOLD_PATH);
  const hold = readHold(holdEntry && text(await gh.blob(owner, name, holdEntry.sha)));
  const version = after.get(VERSION_PATH);
  if (target.title.startsWith("Update Tandem") && version) hold.tandem = moduleVersion(text(await gh.blob(owner, name, version.sha))) ?? undefined;
  const synced = syncedRange(target);
  if (synced) {
    hold.kinesis = synced.to;
    // Where the next sync starts from, so these changes come back with it.
    changes.splice(0, changes.length, ...changes.filter((c) => c.path !== KINESIS_BASE_PATH), { path: KINESIS_BASE_PATH, content: `${synced.from}\n` });
  }
  changes.push({ path: HOLD_PATH, content: `${JSON.stringify(hold)}\n` });

  return gh.commitChanges(owner, name, branch, head, changes, `Undo "${target.title}"\n\nUndoes ${sha}.`);
}

/**
 * Commits Tandem's removal: Kinesis's workflow and manifest back, the module
 * gone. Returns the new head. A retry finds it done already and commits nothing.
 */
export async function removeTandem(gh: GitHubApi, repo: RepoRef): Promise<string> {
  const { owner, name, branch } = repo;
  const head = await gh.head(owner, name, branch);
  const tree = await gh.tree(owner, name, head);
  const changes: TreeChange[] = [...tree.keys()].filter((p) => p.startsWith("tandem/")).map((path) => ({ path, sha: null }));
  for (const [path, unpatch] of [
    [WORKFLOW_PATH, unpatchWorkflow],
    [MANIFEST_PATH, unpatchManifest],
  ] as const) {
    const entry = tree.get(path);
    if (!entry) continue;
    const current = text(await gh.blob(owner, name, entry.sha));
    const content = unpatch(current);
    if (content !== current) changes.push({ path, mode: entry.mode, content });
  }
  if (!changes.length) return head;
  return gh.commitChanges(
    owner,
    name,
    branch,
    head,
    changes,
    "Remove Tandem\n\nPuts the build workflow and west manifest back the way Kinesis wrote them and\nremoves the firmware module. The keymap keeps Tandem's repeat behaviors, which\nare plain ZMK.",
  );
}
