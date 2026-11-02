// The connected repo, read and written through GitHub's API. The branch on
// GitHub is the source of truth: Tandem reads the few files it needs at the
// branch's latest commit and commits each save back to it.

import { GitHubApi, GitHubError } from "../../shared/github";
import { keepSpelling, parseKeymap, toKeymap, writeKeymap } from "../../shared/keymap";
import { readLayout } from "../../shared/layout";
import { HOLD_PATH, KEYMAP_PATH, MANIFEST_PATH, WORKFLOW_PATH, setupMessage, setupPlan } from "../../shared/setup";
import { BETA_BRANCH, makeBetaBranch } from "../../shared/beta";
import { applySync, planSync } from "../../shared/sync";
import type { AppState, KinesisStatus, Keymap, LayoutKey, RepoOption, RepoRef, Session, SetupStatus, UpdateCommit } from "../../shared/types";
import { failedUpdate as lastFailedUpdate, removeTandem as commitRemoval, undoCommit, updateCommits } from "../../shared/undo";
import { getToken, ghCliToken, missingScopes, oauthConfig, signOut as dropToken } from "./auth";
import { MODULE_FILES } from "./module";
import { loadState, saveState } from "./store";

export async function github(): Promise<GitHubApi> {
  const auth = await getToken();
  if (!auth) throw new Error("Sign in with GitHub first");
  return new GitHubApi(auth.token);
}

export function connectedRepo(): RepoRef {
  const { repo } = loadState();
  if (!repo) throw new Error("Choose a keyboard repo first");
  return repo;
}

const repoUrl = (r: RepoRef) => `https://github.com/${r.owner}/${r.name}/tree/${r.branch}`;

// Session: who's signed in, which repo, and whether Tandem is set up there.

let setupCache: { key: string; status: SetupStatus; kinesis: KinesisStatus | null } | null = null;

async function readRepoFiles(gh: GitHubApi, repo: RepoRef, ref: string) {
  const [workflow, manifest, keymap, info, hold, ...module] = await Promise.all([
    gh.file(repo.owner, repo.name, WORKFLOW_PATH, ref),
    gh.file(repo.owner, repo.name, MANIFEST_PATH, ref),
    gh.file(repo.owner, repo.name, KEYMAP_PATH, ref),
    gh.file(repo.owner, repo.name, "config/info.json", ref),
    gh.file(repo.owner, repo.name, HOLD_PATH, ref),
    ...MODULE_FILES.map((f) => gh.file(repo.owner, repo.name, f.path, ref)),
  ]);
  return { workflow, manifest, keymap, info, hold, module: new Map(MODULE_FILES.map((f, i) => [f.path, module[i]])) };
}

let whoCache: { token: string; login: string; scopes: string[] } | null = null;

async function whoami(token: string) {
  if (whoCache?.token === token) return whoCache;
  const who = await new GitHubApi(token).whoami();
  whoCache = { token, ...who };
  return whoCache;
}

let ghLoginCache: { login: string | null; at: number } | null = null;

/** The account the GitHub CLI is signed in as, in development. */
async function ghCliLogin(): Promise<string | null> {
  if (!import.meta.env.DEV) return null;
  if (ghLoginCache && Date.now() - ghLoginCache.at < 60_000) return ghLoginCache.login;
  const token = await ghCliToken();
  const login = token ? ((await whoami(token).catch(() => null))?.login ?? null) : null;
  ghLoginCache = { login, at: Date.now() };
  return login;
}

export async function session(): Promise<Session> {
  const s = loadState();
  const [auth, ghLogin, oauth] = await Promise.all([getToken(), ghCliLogin(), oauthConfig()]);

  const base: Session = {
    signedIn: false,
    login: null,
    source: null,
    missingScopes: [],
    privateRepos: false,
    deviceFlow: false,
    oauth: !!oauth,
    ghLogin,
    repo: null,
    setup: null,
    kinesis: null,
    beta: null,
    onboarded: s.onboarded,
  };
  if (!auth) return base;

  let who: { login: string; scopes: string[] };
  try {
    who = await whoami(auth.token);
  } catch {
    // The token was revoked or expired.
    if (auth.source === "oauth") dropToken();
    return base;
  }

  const signedIn: Session = {
    ...base,
    signedIn: true,
    login: who.login,
    source: auth.source,
    missingScopes: missingScopes(who.scopes),
    privateRepos: who.scopes.includes("repo"),
  };
  if (!s.repo) return signedIn;

  const repo = s.repo;
  const gh = new GitHubApi(auth.token);
  const head = await gh.head(repo.owner, repo.name, repo.branch);
  const key = `${repo.owner}/${repo.name}@${head}`;
  if (setupCache?.key !== key) {
    const { status } = setupPlan(await readRepoFiles(gh, repo, head), MODULE_FILES);
    // Only a repo with Tandem syncs, and failing to find out shouldn't stop the page.
    const sync = status.installed || status.outdated ? await planSync(gh, repo, head).catch(() => null) : null;
    setupCache = { key, status, kinesis: sync?.status ?? null };
  }
  const beta = repo.branch === BETA_BRANCH ? { from: s.betaFrom ?? (await gh.repo(repo.owner, repo.name)).defaultBranch } : null;
  return { ...signedIn, repo: { ...repo, url: repoUrl(repo), head }, setup: setupCache.status, kinesis: setupCache.kinesis, beta };
}

export function useGhLogin() {
  saveState({ useGh: true });
}

export function signOut() {
  dropToken();
  whoCache = null;
  setupCache = null;
  workspace = null;
}

export async function listRepos(): Promise<RepoOption[]> {
  const repos = await (await github()).repos();
  // Kinesis config forks and anything that looks like a ZMK config first.
  const score = (r: RepoOption) => (/adv360|kinesis/i.test(r.name) ? 2 : 0) + (/zmk/i.test(r.name) ? 1 : 0);
  return repos.sort((a, b) => score(b) - score(a));
}

export async function listBranches(owner: string, name: string) {
  const gh = await github();
  const [branches, recent, repo] = await Promise.all([
    gh.branches(owner, name),
    gh.recentBranch(owner, name).catch(() => null),
    gh.repo(owner, name),
  ]);
  return { branches, suggested: recent && branches.includes(recent) ? recent : repo.defaultBranch };
}

export function connectRepo(repo: RepoRef) {
  setupCache = null;
  workspace = null;
  saveState({ repo, syncedSha: null, lastBuild: null });
}

export function disconnectRepo() {
  setupCache = null;
  workspace = null;
  saveState({ repo: null, syncedSha: null, lastBuild: null });
}

/** Makes the setup commit on the connected branch. */
export async function installTandem(): Promise<string> {
  return (await commitSetup(false))!;
}

/**
 * Commits a newer Tandem when the branch has an older one, so a keyboard
 * update installs it. Returns the new head, or null if there's no update or
 * the branch can't take it.
 */
export async function updateTandem(): Promise<string | null> {
  return commitSetup(true);
}

async function commitSetup(onlyUpdate: boolean): Promise<string | null> {
  const gh = await github();
  const repo = connectedRepo();
  // If the branch moves while Tandem commits, plan again from its new head.
  // That head may have the update already, say from another tab.
  for (let attempt = 0; ; attempt++) {
    const head = await gh.head(repo.owner, repo.name, repo.branch);
    const { status, files } = setupPlan(await readRepoFiles(gh, repo, head), MODULE_FILES);
    if (onlyUpdate && (!status.outdated || status.blocker || status.held)) return null;
    if (status.blocker) throw new Error(status.blocker);
    setupCache = null;
    workspace = null;
    if (!files.length) return head;
    try {
      return await gh.commit(repo.owner, repo.name, repo.branch, head, files, setupMessage(status));
    } catch (err) {
      if (attempt > 0 || !(err instanceof GitHubError && err.status === 422)) throw err;
    } finally {
      setupCache = null;
      workspace = null;
    }
  }
}

/**
 * Commits Kinesis's tested changes when the branch lacks them. Returns the new
 * head and the files it left alone, or null if there's nothing to bring in or
 * the changes clash with the user's.
 */
export async function updateKinesis(): Promise<{ sha: string; kept: string[] } | null> {
  const gh = await github();
  const repo = connectedRepo();
  const head = await gh.head(repo.owner, repo.name, repo.branch);
  const plan = await planSync(gh, repo, head);
  if (!plan || plan.status.conflicts.length || plan.status.held) return null;
  const { status } = setupPlan(await readRepoFiles(gh, repo, head), MODULE_FILES);
  if (status.blocker || !(status.installed || status.outdated)) return null;
  try {
    return { sha: await applySync(gh, repo, head, plan), kept: plan.status.kept };
  } finally {
    setupCache = null;
    workspace = null;
  }
}

/** Tandem's commits on this branch that the user can undo, newest first. */
export async function updateHistory(): Promise<UpdateCommit[]> {
  return updateCommits(await github(), connectedRepo());
}

/** Tandem's commit to offer undoing, now that the build at the branch's head failed. */
export async function failedUpdate(): Promise<UpdateCommit | null> {
  return lastFailedUpdate(await github(), connectedRepo());
}

export async function undoUpdate(sha: string): Promise<string> {
  try {
    return await undoCommit(await github(), connectedRepo(), sha);
  } finally {
    setupCache = null;
    workspace = null;
  }
}

/** Takes Tandem out of the branch. Returns the new head. */
export async function removeTandem(): Promise<string> {
  try {
    return await commitRemoval(await github(), connectedRepo());
  } finally {
    setupCache = null;
    workspace = null;
  }
}

/** Makes the trial branch from the connected branch, and switches to it. Returns files the port left alone. */
export async function startBeta(): Promise<string[]> {
  const repo = connectedRepo();
  const kept = await makeBetaBranch(await github(), repo);
  connectRepo({ ...repo, branch: BETA_BRANCH });
  saveState({ betaFrom: repo.branch });
  return kept;
}

export async function leaveBeta(from: string) {
  connectRepo({ ...connectedRepo(), branch: from });
  saveState({ betaFrom: null });
}

// Workspace: the keymap and layout at the branch's latest commit.

interface Workspace {
  sha: string;
  keymapPath: string;
  keymap: string;
  layout: LayoutKey[];
  rows: number[];
}

let workspace: Workspace | null = null;
let checkedAt = 0;

/** Kinesis's config keeps the keymap in config/adv360.keymap. Other repos may name it differently. */
async function findKeymap(gh: GitHubApi, repo: RepoRef, ref: string): Promise<{ path: string; text: string }> {
  const hasKeymap = (text: string | null) => !!text && /\bkeymap\s*\{/.test(text);
  const usual = await gh.file(repo.owner, repo.name, KEYMAP_PATH, ref);
  if (hasKeymap(usual)) return { path: KEYMAP_PATH, text: usual! };
  for (const name of await gh.listFolder(repo.owner, repo.name, "config", ref)) {
    if (!name.endsWith(".keymap")) continue;
    const text = await gh.file(repo.owner, repo.name, `config/${name}`, ref);
    if (hasKeymap(text)) return { path: `config/${name}`, text: text! };
  }
  throw new Error(`No keymap file found in ${repo.owner}/${repo.name}'s config folder.`);
}

/** Reads the keymap and layout again if the branch moved on GitHub. */
export async function openWorkspace(force = false): Promise<Workspace> {
  if (!force && workspace && Date.now() - checkedAt < 10_000) return workspace;
  const gh = await github();
  const repo = connectedRepo();
  const head = await gh.head(repo.owner, repo.name, repo.branch);
  checkedAt = Date.now();
  if (!force && workspace?.sha === head) return workspace;

  const [keymap, info] = await Promise.all([findKeymap(gh, repo, head), gh.file(repo.owner, repo.name, "config/info.json", head)]);
  if (!info) throw new Error(`${repo.owner}/${repo.name} has no config/info.json, so Tandem can't draw the keyboard.`);
  const { keys, rows } = readLayout(info);
  workspace = { sha: head, keymapPath: keymap.path, keymap: keymap.text, layout: keys, rows };
  saveState({ syncedSha: head });
  return workspace;
}

/** Writes the keymap and commits it. Returns the new commit SHA. */
/** Commits the keymap. When it matches what's on the branch, commits nothing and says so. */
export async function saveKeymap(keymap: Keymap): Promise<{ sha: string; committed: boolean }> {
  const ws = await openWorkspace();
  const gh = await github();
  const repo = connectedRepo();
  const head = await gh.head(repo.owner, repo.name, repo.branch);
  if (head !== ws.sha) {
    await openWorkspace(true);
    throw new Error("The branch changed on GitHub since Tandem last loaded it. Tandem reloaded it, so check your keys and save again.");
  }
  const text = writeKeymap(ws.keymap, keepSpelling(toKeymap(parseKeymap(ws.keymap)), keymap), ws.rows);
  if (text === ws.keymap) return { sha: head, committed: false };
  const sha = await gh.commit(repo.owner, repo.name, repo.branch, head, [{ path: ws.keymapPath, content: text }], "Update layout with Tandem");
  workspace = { ...ws, sha, keymap: text };
  checkedAt = Date.now();
  saveState({ syncedSha: sha });
  return { sha, committed: true };
}

export async function appState(): Promise<AppState> {
  const ws = await openWorkspace();
  const s = loadState();
  const repo = connectedRepo();
  return {
    repo: { ...repo, url: repoUrl(repo) },
    layout: ws.layout,
    rows: ws.rows,
    keymap: toKeymap(parseKeymap(ws.keymap)),
    settings: s.settings,
    buildId: ws.sha.slice(0, 7),
    lastBuild: s.lastBuild,
  };
}
