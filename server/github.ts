// GitHub access for Tandem: sign-in, reading and committing files, and
// following Actions builds. Talks to the REST API directly, so no local git
// checkout is needed.
//
// Sign-in uses GitHub's device flow when TANDEM_GITHUB_CLIENT_ID names an
// OAuth app with device flow turned on. Otherwise Tandem can borrow the
// GitHub CLI's login. Device-flow tokens live in the macOS keychain.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const API = "https://api.github.com";
const KEYCHAIN_SERVICE = "Tandem GitHub";
export const CLIENT_ID = process.env.TANDEM_GITHUB_CLIENT_ID ?? null;
export const REQUIRED_SCOPES = ["repo", "workflow"];

export type AuthSource = "device" | "gh";

let cached: { token: string; source: AuthSource } | null = null;

async function keychainToken(): Promise<string | null> {
  try {
    const { stdout } = await run("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function ghCliToken(): Promise<string | null> {
  try {
    const { stdout } = await run("gh", ["auth", "token"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** The token Tandem uses, or null when signed out. `allowGh` reflects the user's choice. */
export async function getToken(allowGh: boolean): Promise<{ token: string; source: AuthSource } | null> {
  if (cached) return cached;
  const device = await keychainToken();
  if (device) return (cached = { token: device, source: "device" });
  // Not cached: `gh auth refresh` swaps the CLI's token, and we want the new one.
  if (allowGh) {
    const gh = await ghCliToken();
    if (gh) return { token: gh, source: "gh" };
  }
  return null;
}

export async function signOut(): Promise<void> {
  cached = null;
  await run("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE]).catch(() => {});
}

export function forgetToken() {
  cached = null;
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class GitHub {
  constructor(private token: string) {}

  async request(method: string, path: string, body?: unknown): Promise<Response> {
    const res = await fetch(path.startsWith("http") ? path : API + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}) as { message?: string });
      throw new GitHubError(`GitHub: ${detail.message ?? res.statusText} (${method} ${path})`, res.status);
    }
    return res;
  }

  async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.request(method, path, body);
    return (res.status === 204 ? null : await res.json()) as T;
  }

  async whoami(): Promise<{ login: string; scopes: string[] }> {
    const res = await this.request("GET", "/user");
    const user = (await res.json()) as { login: string };
    const scopes = (res.headers.get("x-oauth-scopes") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return { login: user.login, scopes };
  }

  async repos(): Promise<RepoSummary[]> {
    const repos = await this.json<RawRepo[]>("GET", "/user/repos?per_page=100&sort=pushed&affiliation=owner");
    return repos.map(summarize);
  }

  async repo(owner: string, name: string): Promise<RepoSummary> {
    return summarize(await this.json<RawRepo>("GET", `/repos/${owner}/${name}`));
  }

  async branches(owner: string, repo: string): Promise<string[]> {
    const list = await this.json<{ name: string }[]>("GET", `/repos/${owner}/${repo}/branches?per_page=100`);
    return list.map((b) => b.name);
  }

  /** Branch of the most recent Actions run, a good guess at where the user works. */
  async recentBranch(owner: string, repo: string): Promise<string | null> {
    const runs = await this.json<{ workflow_runs: { head_branch: string }[] }>(
      "GET",
      `/repos/${owner}/${repo}/actions/runs?per_page=1&event=push`,
    );
    return runs.workflow_runs[0]?.head_branch ?? null;
  }

  async head(owner: string, repo: string, branch: string): Promise<string> {
    const ref = await this.json<{ object: { sha: string } }>(
      "GET",
      `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
    );
    return ref.object.sha;
  }

  async file(owner: string, repo: string, path: string, ref: string): Promise<string | null> {
    try {
      const f = await this.json<{ content: string; encoding: string }>(
        "GET",
        `/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
      );
      return Buffer.from(f.content, "base64").toString("utf8");
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) return null;
      throw err;
    }
  }

  /** Downloads one folder of the repo at `ref` into `dest`, replacing what's there. */
  async downloadFolder(owner: string, repo: string, ref: string, folder: string, dest: string): Promise<void> {
    const res = await this.request("GET", `/repos/${owner}/${repo}/tarball/${ref}`);
    const tmp = await mkdtemp(join(tmpdir(), "tandem-repo-"));
    try {
      const archive = join(tmp, "repo.tar.gz");
      await writeFile(archive, Buffer.from(await res.arrayBuffer()));
      await run("tar", ["-xzf", archive, "-C", tmp, "--strip-components=1", `*/${folder}`]);
      await rm(dest, { recursive: true, force: true });
      await mkdir(join(dest, ".."), { recursive: true });
      await rename(join(tmp, folder), dest);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  /** Commits several files to a branch in one commit. Returns the new commit SHA. */
  async commit(
    owner: string,
    repo: string,
    branch: string,
    parent: string,
    files: { path: string; content: string }[],
    message: string,
  ): Promise<string> {
    const base = `/repos/${owner}/${repo}/git`;
    const parentCommit = await this.json<{ tree: { sha: string } }>("GET", `${base}/commits/${parent}`);
    const tree = await this.json<{ sha: string }>("POST", `${base}/trees`, {
      base_tree: parentCommit.tree.sha,
      tree: files.map((f) => ({ path: f.path, mode: "100644", type: "blob", content: f.content })),
    });
    const commit = await this.json<{ sha: string }>("POST", `${base}/commits`, {
      message,
      tree: tree.sha,
      parents: [parent],
    });
    // Not forced: if the branch moved since `parent`, GitHub rejects this.
    await this.json("PATCH", `${base}/refs/heads/${encodeURIComponent(branch)}`, { sha: commit.sha, force: false });
    return commit.sha;
  }

  async runFor(owner: string, repo: string, sha: string): Promise<WorkflowRun | null> {
    const runs = await this.json<{ workflow_runs: WorkflowRun[] }>(
      "GET",
      `/repos/${owner}/${repo}/actions/runs?head_sha=${sha}&event=push&per_page=5`,
    );
    return runs.workflow_runs[0] ?? null;
  }

  async getRun(owner: string, repo: string, id: number): Promise<WorkflowRun> {
    return this.json("GET", `/repos/${owner}/${repo}/actions/runs/${id}`);
  }

  async jobs(owner: string, repo: string, runId: number): Promise<RunJob[]> {
    const res = await this.json<{ jobs: RunJob[] }>("GET", `/repos/${owner}/${repo}/actions/runs/${runId}/jobs`);
    return res.jobs;
  }

  async artifacts(owner: string, repo: string, runId: number): Promise<Artifact[]> {
    const res = await this.json<{ artifacts: Artifact[] }>(
      "GET",
      `/repos/${owner}/${repo}/actions/runs/${runId}/artifacts`,
    );
    return res.artifacts;
  }

  /** Downloads an artifact and unzips it into `dest`. Returns the files it held. */
  async downloadArtifact(owner: string, repo: string, id: number, dest: string): Promise<string[]> {
    const res = await this.request("GET", `/repos/${owner}/${repo}/actions/artifacts/${id}/zip`);
    await mkdir(dest, { recursive: true });
    const zip = join(dest, "artifact.zip");
    await writeFile(zip, Buffer.from(await res.arrayBuffer()));
    await run("unzip", ["-o", "-q", zip, "-d", dest]);
    await rm(zip);
    return readdir(dest);
  }

  /** Downloads a whole repo at `ref` into `dest`, without the top-level archive folder. */
  async downloadRepo(owner: string, repo: string, ref: string, dest: string): Promise<void> {
    const res = await this.request("GET", `/repos/${owner}/${repo}/tarball/${ref}`);
    await mkdir(dest, { recursive: true });
    const archive = join(dest, "..", `${repo}.tar.gz`);
    await writeFile(archive, Buffer.from(await res.arrayBuffer()));
    try {
      await run("tar", ["-xzf", archive, "-C", dest, "--strip-components=1"]);
    } finally {
      await rm(archive, { force: true });
    }
  }

  /** Creates a repo owned by the signed-in user, with a first commit so it has a branch. */
  async createRepo(name: string, isPrivate: boolean, description: string): Promise<RepoSummary> {
    return summarize(
      await this.json<RawRepo>("POST", "/user/repos", { name, private: isPrivate, description, auto_init: true }),
    );
  }

  /**
   * Replaces a branch's whole tree with `files` in one commit. Used for a new
   * repo, where nothing in the first commit is worth keeping.
   */
  async commitTree(
    owner: string,
    repo: string,
    branch: string,
    parent: string,
    files: { path: string; data: Buffer; executable?: boolean }[],
    message: string,
  ): Promise<string> {
    const base = `/repos/${owner}/${repo}/git`;
    const entries: { path: string; mode: string; type: string; sha: string }[] = [];
    // A few blobs at a time keeps well under GitHub's secondary rate limits.
    for (let i = 0; i < files.length; i += 6) {
      const batch = files.slice(i, i + 6);
      const shas = await Promise.all(
        batch.map((f) =>
          this.json<{ sha: string }>("POST", `${base}/blobs`, { content: f.data.toString("base64"), encoding: "base64" }),
        ),
      );
      batch.forEach((f, j) =>
        entries.push({ path: f.path, mode: f.executable ? "100755" : "100644", type: "blob", sha: shas[j].sha }),
      );
    }
    const tree = await this.json<{ sha: string }>("POST", `${base}/trees`, { tree: entries });
    const commit = await this.json<{ sha: string }>("POST", `${base}/commits`, { message, tree: tree.sha, parents: [parent] });
    await this.json("PATCH", `${base}/refs/heads/${encodeURIComponent(branch)}`, { sha: commit.sha, force: false });
    return commit.sha;
  }

  async fork(owner: string, repo: string): Promise<RepoSummary> {
    return summarize(await this.json<RawRepo>("POST", `/repos/${owner}/${repo}/forks`, { default_branch_only: false }));
  }

  /** Forks start with Actions off. Turn them on for the build workflow. */
  async enableActions(owner: string, repo: string, workflowFile: string): Promise<void> {
    await this.json("PUT", `/repos/${owner}/${repo}/actions/permissions`, { enabled: true, allowed_actions: "all" });
    await this.json("PUT", `/repos/${owner}/${repo}/actions/workflows/${workflowFile}/enable`).catch(() => {});
  }
}

interface RawRepo {
  name: string;
  full_name: string;
  owner: { login: string };
  fork: boolean;
  private: boolean;
  default_branch: string;
  html_url: string;
  pushed_at: string;
  description: string | null;
}

export interface RepoSummary {
  owner: string;
  name: string;
  fullName: string;
  fork: boolean;
  private: boolean;
  defaultBranch: string;
  url: string;
  pushedAt: string;
  description: string | null;
}

function summarize(r: RawRepo): RepoSummary {
  return {
    owner: r.owner.login,
    name: r.name,
    fullName: r.full_name,
    fork: r.fork,
    private: r.private,
    defaultBranch: r.default_branch,
    url: r.html_url,
    pushedAt: r.pushed_at,
    description: r.description,
  };
}

export interface WorkflowRun {
  id: number;
  status: "queued" | "in_progress" | "completed" | "waiting" | "requested" | "pending";
  conclusion: "success" | "failure" | "cancelled" | "skipped" | "timed_out" | null;
  html_url: string;
  head_sha: string;
  name: string;
}

export interface RunJob {
  name: string;
  status: string;
  conclusion: string | null;
  steps?: { name: string; status: string; conclusion: string | null; number: number }[];
}

export interface Artifact {
  id: number;
  name: string;
  size_in_bytes: number;
  expired: boolean;
}

// Device flow. See docs.github.com, "Authorizing OAuth apps".

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  expires_in: number;
}

export async function startDeviceFlow(): Promise<DeviceCode> {
  if (!CLIENT_ID) throw new Error("Set TANDEM_GITHUB_CLIENT_ID to sign in with GitHub");
  const res = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID, scope: REQUIRED_SCOPES.join(" ") }),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error_description ?? "GitHub didn't start sign-in");
  return data;
}

/** Polls until the user approves the code. Stores the token in the keychain. */
export async function finishDeviceFlow(code: DeviceCode, signal: AbortSignal): Promise<void> {
  let interval = code.interval;
  const deadline = Date.now() + code.expires_in * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval * 1000));
    signal.throwIfAborted();
    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code: code.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    const data = await res.json();
    if (data.access_token) {
      await run("security", ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", "github", "-w", data.access_token]);
      cached = { token: data.access_token, source: "device" };
      return;
    }
    if (data.error === "slow_down") interval = data.interval ?? interval + 5;
    else if (data.error !== "authorization_pending") throw new Error(data.error_description ?? data.error);
  }
  throw new Error("The sign-in code expired. Try again.");
}
