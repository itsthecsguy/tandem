// The ZMK 4.1 trial: a community port of Kinesis's firmware to ZMK's newer
// Bluetooth stack. Tandem puts it on a branch of its own, so the branch the
// user was on stays as it was, and going back is switching to it. The port's
// config is one commit on top of Kinesis's, so it merges like a sync does. See
// pins.beta in shared/pins.json and Kinesis's issue #860.

import { GitHubError, type GitHubApi } from "./github";
import pins from "./pins.json";
import { planMerge, resolveChanges } from "./sync";
import type { RepoRef } from "./types";

export const BETA_BRANCH = "tandem-zmk-4.1";

const [PORT_OWNER, PORT_NAME] = pins.beta.repo.split("/");
const PORT = { owner: PORT_OWNER, name: PORT_NAME };

/**
 * Makes the trial branch from `repo`'s branch, unless it's there already.
 * Returns the files the port left as the repo has them.
 */
export async function makeBetaBranch(gh: GitHubApi, repo: RepoRef): Promise<string[]> {
  const { owner, name, branch } = repo;
  const trial = { owner, name, branch: BETA_BRANCH };
  const existing = await gh.head(owner, name, BETA_BRANCH).catch((err) => {
    if (err instanceof GitHubError && err.status === 404) return null;
    throw err;
  });
  if (existing) return [];

  const head = await gh.head(owner, name, branch);
  const { changes, kept, conflicts } = await planMerge(gh, repo, head, PORT, pins.beta.base, pins.beta.sha);
  if (conflicts.length) throw new Error(`${pins.beta.name} changes the same lines you changed in ${conflicts.join(", ")}, so Tandem can't make the trial branch.`);

  // The commit first, so a branch that exists always has the port on it.
  const resolved = await resolveChanges(gh, trial, PORT, changes);
  const sha = await gh.makeCommit(owner, name, head, resolved, `Try ${pins.beta.name}\n\nBrings in the port at ${pins.beta.repo}@${pins.beta.sha}.\nThe branch ${branch} stays as it was.`);
  await gh.createBranch(owner, name, BETA_BRANCH, sha);
  return kept;
}
