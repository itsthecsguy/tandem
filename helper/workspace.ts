// Tandem's working copy of the keyboard config. The user's GitHub branch is
// the source of truth: Tandem downloads its config/ folder, edits it here, and
// commits each save back to the branch. Saved state and downloaded firmware
// live in ~/Library/Application Support/Tandem.

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import type { BuildRecord, BuildSettings, Keymap, LayoutKey, RepoRef, Session, SetupStatus, Side } from "../shared/types";
import { CLIENT_ID, GitHub, REQUIRED_SCOPES, forgetToken, getToken, ghCliToken, signOut as dropToken } from "./github";
import { keepSpelling, parseKeymap, toKeymap, writeKeymap } from "../shared/keymap";
import { readLayout } from "../shared/layout";
import { type NewRepoOptions, createRepo } from "./newrepo";
import { KEYMAP_PATH, WORKFLOW_PATH, moduleFiles, setupPlan } from "./setup";

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
}

const DEFAULT_STATE: SavedState = {
  knownSerials: {},
  settings: { studio: true },
  lastBuild: null,
  useGhLogin: false,
  repo: null,
  syncedSha: null,
  onboarded: false,
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

let setupCache: { key: string; status: SetupStatus } | null = null;

async function readRepoFiles(gh: GitHub, repo: RepoRef, ref: string) {
  const mine = await moduleFiles();
  const [workflow, keymap, info, ...module] = await Promise.all([
    gh.file(repo.owner, repo.name, WORKFLOW_PATH, ref),
    gh.file(repo.owner, repo.name, KEYMAP_PATH, ref),
    gh.file(repo.owner, repo.name, "config/info.json", ref),
    ...mine.map((f) => gh.file(repo.owner, repo.name, f.path, ref)),
  ]);
  return { workflow, keymap, info, module: new Map(mine.map((f, i) => [f.path, module[i]])) };
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
    setupCache = { key, status };
  }
  return {
    ...signedIn,
    repo: { ...repo, url: `https://github.com/${repo.owner}/${repo.name}/tree/${repo.branch}`, head },
    setup: setupCache.status,
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
  const gh = await github();
  const repo = await connectedRepo();
  const head = await gh.head(repo.owner, repo.name, repo.branch);
  const { status, files } = await setupPlan(await readRepoFiles(gh, repo, head));
  if (status.blocker) throw new Error(status.blocker);
  if (!files.length) return head;
  const sha = await gh.commit(
    repo.owner,
    repo.name,
    repo.branch,
    head,
    files,
    "Add Tandem automatic updates\n\nAdds the zmk-tandem firmware module, builds it in every firmware build, and\nmoves the keymap's repeat-on-tap-then-hold keys to Tandem's &ltr behavior.",
  );
  setupCache = null;
  await syncWorkspace(true);
  return sha;
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
