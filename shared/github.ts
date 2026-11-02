// GitHub's REST API, as Tandem uses it: reading and committing files, creating
// repos and following Actions builds. Only uses fetch, so the browser and the
// helper share it. No local git checkout is involved.

const API = "https://api.github.com";

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export class GitHubApi {
  constructor(protected token: string) {}

  async request(method: string, path: string, body?: unknown): Promise<Response> {
    const res = await fetch(path.startsWith("http") ? path : API + path, {
      method,
      // GitHub marks answers fresh for 60 seconds, so a browser would serve a
      // branch's head from before Tandem's own last commit. Asking again with
      // the ETag costs a 304, which doesn't count against the rate limit.
      cache: "no-cache",
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
      return new TextDecoder().decode(fromBase64(f.content));
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) return null;
      throw err;
    }
  }

  /** Names of the files directly inside a folder, or [] if it doesn't exist. */
  async listFolder(owner: string, repo: string, path: string, ref: string): Promise<string[]> {
    try {
      const entries = await this.json<{ name: string; type: string }[]>(
        "GET",
        `/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
      );
      return entries.filter((e) => e.type === "file").map((e) => e.name);
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) return [];
      throw err;
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
    return this.commitChanges(owner, repo, branch, parent, files, message);
  }

  /**
   * Commits changes on top of `parent`, each one new text, a blob the repo
   * already has, or a deletion. `merged` adds parents, for a merge commit.
   */
  async commitChanges(
    owner: string,
    repo: string,
    branch: string,
    parent: string,
    changes: TreeChange[],
    message: string,
    merged: string[] = [],
  ): Promise<string> {
    const sha = await this.makeCommit(owner, repo, parent, changes, message, merged);
    // Not forced: if the branch moved since `parent`, GitHub rejects this.
    await this.json("PATCH", `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, { sha, force: false });
    return sha;
  }

  /** Makes a commit that no branch points to yet. Returns its SHA. */
  async makeCommit(owner: string, repo: string, parent: string, changes: TreeChange[], message: string, merged: string[] = []): Promise<string> {
    const base = `/repos/${owner}/${repo}/git`;
    const parentCommit = await this.json<{ tree: { sha: string } }>("GET", `${base}/commits/${parent}`);
    // GitHub refuses a new tree with no entries. With no changes, the tree is the parent's.
    const tree = changes.length
      ? await this.json<{ sha: string }>("POST", `${base}/trees`, {
          base_tree: parentCommit.tree.sha,
          tree: changes.map(({ path, mode, ...what }) => ({ path, mode: mode ?? "100644", type: "blob", ...what })),
        })
      : parentCommit.tree;
    const commit = await this.json<{ sha: string }>("POST", `${base}/commits`, { message, tree: tree.sha, parents: [parent, ...merged] });
    return commit.sha;
  }

  /** Every file in a commit, by path. */
  async tree(owner: string, repo: string, ref: string): Promise<Map<string, TreeEntry>> {
    const res = await this.json<{ tree: (TreeEntry & { type: string })[]; truncated: boolean }>(
      "GET",
      `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    );
    if (res.truncated) throw new Error(`${owner}/${repo} has too many files for GitHub to list.`);
    return new Map(res.tree.filter((e) => e.type === "blob").map((e) => [e.path, { path: e.path, mode: e.mode, sha: e.sha }]));
  }

  async blob(owner: string, repo: string, sha: string): Promise<Uint8Array> {
    const res = await this.json<{ content: string }>("GET", `/repos/${owner}/${repo}/git/blobs/${sha}`);
    return fromBase64(res.content);
  }

  async putBlob(owner: string, repo: string, data: Uint8Array): Promise<string> {
    const res = await this.json<{ sha: string }>("POST", `/repos/${owner}/${repo}/git/blobs`, { content: toBase64(data), encoding: "base64" });
    return res.sha;
  }

  /** Creates a branch at a commit. */
  async createBranch(owner: string, repo: string, branch: string, sha: string): Promise<void> {
    await this.json("POST", `/repos/${owner}/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha });
  }

  /** A branch's latest commits, newest first. */
  async history(owner: string, repo: string, branch: string, count: number): Promise<CommitSummary[]> {
    const list = await this.json<RawCommit[]>("GET", `/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=${count}`);
    return list.map(summarizeCommit);
  }

  async commitOf(owner: string, repo: string, sha: string): Promise<CommitSummary> {
    return summarizeCommit(await this.json<RawCommit>("GET", `/repos/${owner}/${repo}/commits/${sha}`));
  }

  /** How `head` relates to `base`. Across a fork network, `head` is `owner:branch`. */
  async compare(owner: string, repo: string, base: string, head: string): Promise<Comparison> {
    const res = await this.json<{ status: string; behind_by: number; ahead_by: number; merge_base_commit: { sha: string }; commits: RawCommit[] }>(
      "GET",
      `/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${head.split(":").map(encodeURIComponent).join(":")}`,
    );
    return { status: res.status, behindBy: res.behind_by, aheadBy: res.ahead_by, mergeBase: res.merge_base_commit.sha, commits: res.commits.map(summarizeCommit) };
  }

  /** The build for a commit: from its push, or started by hand for it. */
  async runFor(owner: string, repo: string, sha: string): Promise<WorkflowRun | null> {
    const runs = await this.json<{ workflow_runs: WorkflowRun[] }>("GET", `/repos/${owner}/${repo}/actions/runs?head_sha=${sha}&per_page=10`);
    return runs.workflow_runs.find((r) => r.event === "push" || r.event === "workflow_dispatch") ?? null;
  }

  /** Starts a workflow by hand, for a commit whose push didn't start one. */
  async dispatch(owner: string, repo: string, workflowFile: string, ref: string): Promise<void> {
    await this.json("POST", `/repos/${owner}/${repo}/actions/workflows/${workflowFile}/dispatches`, { ref });
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

  /**
   * An artifact's zip file. GitHub redirects to its storage, which allows
   * browser requests, and fetch drops the token on the way there.
   */
  async artifactZip(owner: string, repo: string, id: number): Promise<Uint8Array> {
    const res = await this.request("GET", `/repos/${owner}/${repo}/actions/artifacts/${id}/zip`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Creates a repo owned by the signed-in user, with a first commit so it has a branch. */
  async createRepo(name: string, isPrivate: boolean, description: string): Promise<RepoSummary> {
    return summarize(
      await this.json<RawRepo>("POST", "/user/repos", { name, private: isPrivate, description, auto_init: true }),
    );
  }

  /** Creates a repo from a template repo, with the template's files and fresh history. */
  async generate(
    template: { owner: string; name: string },
    repo: { owner: string; name: string; private: boolean; description: string },
  ): Promise<RepoSummary> {
    return summarize(
      await this.json<RawRepo>("POST", `/repos/${template.owner}/${template.name}/generate`, {
        owner: repo.owner,
        name: repo.name,
        private: repo.private,
        description: repo.description,
        include_all_branches: false,
      }),
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
    files: { path: string; data: Uint8Array; executable?: boolean }[],
    message: string,
  ): Promise<string> {
    const base = `/repos/${owner}/${repo}/git`;
    const entries: { path: string; mode: string; type: string; sha: string }[] = [];
    // A few blobs at a time keeps well under GitHub's secondary rate limits.
    for (let i = 0; i < files.length; i += 6) {
      const batch = files.slice(i, i + 6);
      const shas = await Promise.all(
        batch.map((f) => this.json<{ sha: string }>("POST", `${base}/blobs`, { content: toBase64(f.data), encoding: "base64" })),
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

export interface TreeEntry {
  path: string;
  mode: string;
  sha: string;
}

/** One file's change in a commit: new text, a blob the repo has, or null to delete it. */
export type TreeChange = { path: string; mode?: string } & ({ content: string } | { sha: string | null });

interface RawCommit {
  sha: string;
  commit: { message: string; committer: { date: string } | null };
  parents: { sha: string }[];
}

export interface CommitSummary {
  sha: string;
  message: string;
  title: string;
  date: string;
  parents: string[];
}

function summarizeCommit(c: RawCommit): CommitSummary {
  return { sha: c.sha, message: c.commit.message, title: c.commit.message.split("\n")[0], date: c.commit.committer?.date ?? "", parents: c.parents.map((p) => p.sha) };
}

export interface Comparison {
  status: string;
  behindBy: number;
  aheadBy: number;
  mergeBase: string;
  commits: CommitSummary[];
}

interface RawRepo {
  name: string;
  full_name: string;
  owner: { login: string };
  fork: boolean;
  /** The top of the fork network. Only answers about one repo have it. */
  source?: { full_name: string };
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
  /** The repo at the top of its fork network, when GitHub says. */
  source: string | null;
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
    source: r.source?.full_name ?? null,
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
  event: string;
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
