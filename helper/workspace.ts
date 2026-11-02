// Tandem's working copy of the keyboard config. The user's GitHub branch is
// the source of truth: Tandem downloads its config/ folder, edits it here, and
// commits each save back to the branch. Saved state and downloaded firmware
// live in ~/Library/Application Support/Tandem.

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import type { BuildRecord, BuildSettings, KinesisStatus, Keymap, LayoutKey, RepoRef, Session, SetupStatus, Side, UpdateCommit } from "../shared/types";
import { BETA_BRANCH, makeBetaBranch } from "../shared/beta";
import { applySync, planSync } from "../shared/sync";
import { failedUpdate as lastFailedUpdate, removeTandem as commitRemoval, undoCommit, updateCommits } from "../shared/undo";
import { CLIENT_ID, GitHub, REQUIRED_SCOPES, forgetToken, getToken, ghCliToken, signOut as dropToken } from "./github";
import { keepSpelling, parseKeymap, toKeymap, writeKeymap } from "../shared/keymap";
import { readLayout } from "../shared/layout";
import { type NewRepoOptions, createRepo } from "./newrepo";
import { HOLD_PATH, KEYMAP_PATH, MANIFEST_PATH, WORKFLOW_PATH, moduleFiles, setupMessage, setupPlan } from "./setup";

export const APP_DIR = process.env.TANDEM_HOME ?? join(homedir(), "Library", "Application Support", "Tandem");
export const WORKSPACE_DIR = join(APP_DIR, "workspace");
export const CONFIG_DIR = join(WORKSPACE_DIR, "config");
export const BUILDS_DIR = join(APP_DIR, "builds");
const STATE_FILE = join(APP_DIR, "state.json");

export interface SavedState {
  knownSerials: Partial<Record<Side, string>>;
  settings: BuildSettings;
  lastBuild: BuildRecord | null;
  /** The user chose to sign in with the GitHub CLI's login. */
  useGhLogin: boolean;
  repo: RepoRef | null;
  /** Commit the local config was downloaded from or last committed as. */
  syncedSha: string | null;
  /** The user finished onboarding, including the first flash. */
  onboarded: boolean;
  /** The branch the ZMK 4.1 trial started from. */
  betaFrom: string | null;
}

const DEFAULT_STATE: SavedState = {
  knownSerials: {},
  settings: { studio: true },
  lastBuild: null,
  useGhLogin: false,
  repo: null,
  syncedSha: null,
  onboarded: false,
  betaFrom: null,
};

let state: SavedState | null = null;

export async function loadState(): Promise<SavedState> {
  if (state) return state;
  try {
    state = { ...DEFAULT_STATE, ...JSON.parse(await readFile(STATE_FILE, "utf8")) };
  } catch {
    state = structuredClone(DEFAULT_STATE);
  }
  return state!;
}

export async function saveState(patch: Partial<SavedState>): Promise<SavedState> {
  const current = await loadState();
  state = { ...current, ...patch };
  await mkdir(APP_DIR, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
  return state;
}

export async function github(): Promise<GitHub> {
  const s = await loadState();
  const auth = await getToken(s.useGhLogin);
  if (!auth) throw new Error("Sign in with GitHub first");
  return new GitHub(auth.token);
}

async function connectedRepo(): Promise<RepoRef> {
  const { repo } = await loadState();
  if (!repo) throw new Error("Choose a keyboard repo first");
  return repo;
}

// Session: who's signed in, which repo, and whether Tandem is set up there.

let setupCache: { key: string; status: SetupStatus; kinesis: KinesisStatus | null } | null = null;

async function readRepoFiles(gh: GitHub, repo: RepoRef, ref: string) {
  const mine = await moduleFiles();
  const [workflow, manifest, keymap, info, hold, ...module] = await Promise.all([
    gh.file(repo.owner, repo.name, WORKFLOW_PATH, ref),
    gh.file(repo.owner, repo.name, MANIFEST_PATH, ref),
    gh.file(repo.owner, repo.name, KEYMAP_PATH, ref),
    gh.file(repo.owner, repo.name, "config/info.json", ref),
    gh.file(repo.owner, repo.name, HOLD_PATH, ref),
    ...mine.map((f) => gh.file(repo.owner, repo.name, f.path, ref)),
  ]);
  return { workflow, manifest, keymap, info, hold, module: new Map(mine.map((f, i) => [f.path, module[i]])) };
}

let ghLoginCache: { login: string | null; at: number } | null = null;

/** The account the GitHub CLI is signed in as, if it is. */
async function ghCliLogin(): Promise<string | null> {
  if (ghLoginCache && Date.now() - ghLoginCache.at < 60_000) return ghLoginCache.login;
  const token = await ghCliToken();
  const login = token ? ((await new GitHub(token).whoami().catch(() => null))?.login ?? null) : null;
  ghLoginCache = { login, at: Date.now() };
  return login;
}

export async function session(): Promise<Session> {
  const s = await loadState();
  const auth = await getToken(s.useGhLogin);
  const ghLogin = await ghCliLogin();

  const base: Session = {
    signedIn: false,
    login: null,
    source: null,
    missingScopes: [],
    privateRepos: false,
    deviceFlow: !!CLIENT_ID,
    oauth: false,
    ghLogin,
    repo: null,
    setup: null,
    kinesis: null,
    beta: null,
    onboarded: s.onboarded,
  };
  if (!auth) return base;

  const gh = new GitHub(auth.token);
  let who: { login: string; scopes: string[] };
  try {
    who = await gh.whoami();
  } catch {
    forgetToken();
    return base;
  }

  const signedIn = { ...base, signedIn: true, login: who.login, source: auth.source };
  signedIn.missingScopes = REQUIRED_SCOPES.filter((sc) => !who.scopes.includes(sc));
  signedIn.privateRepos = who.scopes.includes("repo");
  if (!s.repo) return signedIn;

  const repo = s.repo;
  const head = await gh.head(repo.owner, repo.name, repo.branch);
  const key = `${repo.owner}/${repo.name}@${head}`;
  if (setupCache?.key !== key) {
    const { status } = await setupPlan(await readRepoFiles(gh, repo, head));
    // Only a repo with Tandem syncs, and failing to find out shouldn't stop the page.
    const sync = status.installed || status.outdated ? await planSync(gh, repo, head).catch(() => null) : null;
    setupCache = { key, status, kinesis: sync?.status ?? null };
  }
  return {
    ...signedIn,
    repo: { ...repo, url: `https://github.com/${repo.owner}/${repo.name}/tree/${repo.branch}`, head },
    setup: setupCache.status,
    kinesis: setupCache.kinesis,
    beta: repo.branch === BETA_BRANCH ? { from: s.betaFrom ?? (await gh.repo(repo.owner, repo.name)).defaultBranch } : null,
  };
}

export async function useGhLogin(): Promise<void> {
  forgetToken();
  await saveState({ useGhLogin: true });
}

export async function signOut(): Promise<void> {
  await dropToken();
  await saveState({ useGhLogin: false });
}

export async function listRepos() {
  const gh = await github();
  const repos = await gh.repos();
  // Kinesis config forks and anything that looks like a ZMK config first.
  const score = (r: (typeof repos)[number]) =>
    (/adv360|kinesis/i.test(r.name) ? 2 : 0) + (/zmk/i.test(r.name) ? 1 : 0);
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

export async function connectRepo(repo: RepoRef): Promise<void> {
  setupCache = null;
  workspace = null;
  await saveState({ repo, syncedSha: null, lastBuild: null });
}

export async function disconnectRepo(): Promise<void> {
  setupCache = null;
  workspace = null;
  await saveState({ repo: null, syncedSha: null, lastBuild: null });
}

/** Creates a new config repo from Kinesis's, with Tandem added, and connects it. */
export async function createNewRepo(options: NewRepoOptions): Promise<RepoRef> {
  const repo = await createRepo(await github(), options);
  await connectRepo(repo);
  return repo;
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
  const repo = await connectedRepo();
  const head = await gh.head(repo.owner, repo.name, repo.branch);
  const { status, files } = await setupPlan(await readRepoFiles(gh, repo, head));
  if (onlyUpdate && (!status.outdated || status.blocker || status.held)) return null;
  if (status.blocker) throw new Error(status.blocker);
  if (!files.length) return head;
  const sha = await gh.commit(repo.owner, repo.name, repo.branch, head, files, setupMessage(status));
  setupCache = null;
  await syncWorkspace(true);
  return sha;
}

/**
 * Reads the branch again after a commit. The commit is made either way, so
 * failing here mustn't look like it failed. A later save notices the branch
 * moved and reads it then.
 */
async function refreshAfterCommit(): Promise<void> {
  setupCache = null;
  await syncWorkspace(true).catch(() => {});
}

/**
 * Commits Kinesis's tested changes when the branch lacks them. Returns the new
 * head and the files it left alone, or null if there's nothing to bring in or
 * the changes clash with the user's.
 */
export async function updateKinesis(): Promise<{ sha: string; kept: string[] } | null> {
  const gh = await github();
  const repo = await connectedRepo();
  const head = await gh.head(repo.owner, repo.name, repo.branch);
  const plan = await planSync(gh, repo, head);
  if (!plan || plan.status.conflicts.length || plan.status.held) return null;
  const { status } = await setupPlan(await readRepoFiles(gh, repo, head));
  if (status.blocker || !(status.installed || status.outdated)) return null;
  const sha = await applySync(gh, repo, head, plan);
  await refreshAfterCommit();
  return { sha, kept: plan.status.kept };
}

/** Tandem's commits on this branch that the user can undo, newest first. */
export async function updateHistory(): Promise<UpdateCommit[]> {
  return updateCommits(await github(), await connectedRepo());
}

/** Tandem's commit to offer undoing, now that the build at the branch's head failed. */
export async function failedUpdate(): Promise<UpdateCommit | null> {
  return lastFailedUpdate(await github(), await connectedRepo());
}

export async function undoUpdate(sha: string): Promise<string> {
  const head = await undoCommit(await github(), await connectedRepo(), sha);
  await refreshAfterCommit();
  return head;
}

/** Takes Tandem out of the branch. Returns the new head. */
export async function removeTandem(): Promise<string> {
  const head = await commitRemoval(await github(), await connectedRepo());
  await refreshAfterCommit();
  return head;
}

/** Makes the trial branch from the connected branch, and switches to it. Returns files the port left alone. */
export async function startBeta(): Promise<string[]> {
  const repo = await connectedRepo();
  const kept = await makeBetaBranch(await github(), repo);
  await connectRepo({ ...repo, branch: BETA_BRANCH });
  await saveState({ betaFrom: repo.branch });
  return kept;
}

export async function leaveBeta(from: string): Promise<void> {
  await connectRepo({ ...(await connectedRepo()), branch: from });
  await saveState({ betaFrom: null });
}

// Workspace: the downloaded config folder.

export interface Workspace {
  keymapFile: string;
  layout: LayoutKey[];
  rows: number[];
}

let workspace: Workspace | null = null;
let lastSyncCheck = 0;

async function findKeymapFile(dir: string): Promise<string> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".keymap"));
  for (const f of files) {
    if (/\bkeymap\s*\{/.test(await readFile(join(dir, f), "utf8"))) return join(dir, f);
  }
  throw new Error(`No keymap file found in ${dir}`);
}

/** Downloads config/ again if the branch moved on GitHub. */
export async function syncWorkspace(force = false): Promise<void> {
  if (!force && Date.now() - lastSyncCheck < 10_000 && existsSync(CONFIG_DIR)) return;
  lastSyncCheck = Date.now();
  const gh = await github();
  const repo = await connectedRepo();
  const s = await loadState();
  const head = await gh.head(repo.owner, repo.name, repo.branch);
  if (!force && head === s.syncedSha && existsSync(CONFIG_DIR)) return;
  await gh.downloadFolder(repo.owner, repo.name, head, "config", CONFIG_DIR);
  workspace = null;
  await saveState({ syncedSha: head });
}

export async function openWorkspace(): Promise<Workspace> {
  await syncWorkspace();
  if (workspace) return workspace;
  const { keys, rows } = readLayout(await readFile(join(CONFIG_DIR, "info.json"), "utf8"));
  workspace = { keymapFile: await findKeymapFile(CONFIG_DIR), layout: keys, rows };
  return workspace;
}

export async function readKeymap(): Promise<Keymap> {
  const ws = await openWorkspace();
  return toKeymap(parseKeymap(await readFile(ws.keymapFile, "utf8")));
}

/** Writes the keymap and commits it. Returns the new commit SHA. */
/** Commits the keymap. When it matches what's on the branch, commits nothing and says so. */
export async function saveKeymap(keymap: Keymap): Promise<{ sha: string; committed: boolean }> {
  const ws = await openWorkspace();
  const gh = await github();
  const repo = await connectedRepo();
  const s = await loadState();

  const head = await gh.head(repo.owner, repo.name, repo.branch);
  if (head !== s.syncedSha) {
    await syncWorkspace(true);
    throw new Error("The branch changed on GitHub since Tandem last loaded it. Tandem reloaded it, so check your keys and save again.");
  }

  const current = await readFile(ws.keymapFile, "utf8");
  const text = writeKeymap(current, keepSpelling(toKeymap(parseKeymap(current)), keymap), ws.rows);
  if (text === current) return { sha: head, committed: false };
  const path = `config/${basename(ws.keymapFile)}`;
  const sha = await gh.commit(repo.owner, repo.name, repo.branch, head, [{ path, content: text }], "Update layout with Tandem");
  await writeFile(ws.keymapFile, text);
  await saveState({ syncedSha: sha });
  return { sha, committed: true };
}

/** The build ID the halves report for the current commit: its short SHA. */
export async function currentBuildId(): Promise<string> {
  const s = await loadState();
  return (s.syncedSha ?? "").slice(0, 7);
}
