// An in-memory GitHub for tests: repos with branches and commits, the Git Data
// API for committing, template repos, and Actions runs that finish at once
// with a firmware artifact. Installed in place of global fetch.

import { zipSync } from "fflate";

import { fromBase64, toBase64 } from "../../shared/github";

type Files = Map<string, Uint8Array>;

interface Commit {
  tree: Files;
  parents: string[];
  message: string;
}

interface Run {
  id: number;
  sha: string;
  event: string;
  artifacts: { id: number; name: string; zip: Uint8Array }[];
}

interface Repo {
  owner: string;
  name: string;
  private: boolean;
  template: boolean;
  defaultBranch: string;
  branches: Map<string, string>;
}

const text = (data: Uint8Array) => new TextDecoder().decode(data);
const bytes = (s: string) => new TextEncoder().encode(s);

/** A real UF2 file whose firmware is just text with the build ID, so tests can tell builds apart. */
export function fakeUf2(side: string, build: string): Uint8Array {
  const payload = bytes(`${side}:${build}`);
  const blocks = Math.ceil(payload.length / 256);
  const out = new Uint8Array(blocks * 512);
  const v = new DataView(out.buffer);
  for (let i = 0; i < blocks; i++) {
    const at = i * 512;
    v.setUint32(at, 0x0a324655, true);
    v.setUint32(at + 4, 0x9e5d5157, true);
    v.setUint32(at + 8, 0x2000, true); // family ID present
    v.setUint32(at + 12, 0x26000 + i * 256, true);
    v.setUint32(at + 16, 256, true);
    v.setUint32(at + 20, i, true);
    v.setUint32(at + 24, blocks, true);
    v.setUint32(at + 28, 0xada52840, true); // nRF52840
    out.set(payload.subarray(i * 256, (i + 1) * 256), at + 32);
    v.setUint32(at + 508, 0x0ab16f30, true);
  }
  return out;
}

export class FakeGitHub {
  login = "octocat";
  scopes = ["public_repo", "workflow"];
  /** Runs start automatically on push, as a workflow with `on: push` does. */
  buildOnPush = true;
  readonly commits = new Map<string, Commit>();
  readonly repos = new Map<string, Repo>();
  readonly runs: Run[] = [];
  readonly requests: string[] = [];
  /** The fetch cache mode of each request, in order. */
  readonly cacheModes: string[] = [];
  /** Answers for the next branch lookups, like a browser serving them from its cache. */
  staleHeads: string[] = [];
  private blobs = new Map<string, Uint8Array>();
  private trees = new Map<string, Files>();
  private seq = 0;

  private id(prefix: string) {
    this.seq++;
    return `${prefix}${this.seq.toString(16).padStart(39, "0")}`;
  }

  addRepo(owner: string, name: string, files: Record<string, string | Uint8Array>, options: { branch?: string; template?: boolean; private?: boolean } = {}) {
    const branch = options.branch ?? "main";
    const tree: Files = new Map(Object.entries(files).map(([p, c]) => [p, typeof c === "string" ? bytes(c) : c]));
    const sha = this.id("c");
    this.commits.set(sha, { tree, parents: [], message: "Initial commit" });
    this.repos.set(`${owner}/${name}`, {
      owner,
      name,
      private: !!options.private,
      template: !!options.template,
      defaultBranch: branch,
      branches: new Map([[branch, sha]]),
    });
    return sha;
  }

  head(owner: string, name: string, branch = "main") {
    return this.repos.get(`${owner}/${name}`)!.branches.get(branch)!;
  }

  fileAt(sha: string, path: string): string | null {
    const data = this.commits.get(sha)?.tree.get(path);
    return data ? text(data) : null;
  }

  /** Commits straight to a branch, as if someone pushed from elsewhere. */
  push(owner: string, name: string, branch: string, files: Record<string, string>, message = "Elsewhere") {
    const repo = this.repos.get(`${owner}/${name}`)!;
    const parent = repo.branches.get(branch)!;
    const tree = new Map(this.commits.get(parent)!.tree);
    for (const [p, c] of Object.entries(files)) tree.set(p, bytes(c));
    const sha = this.id("c");
    this.commits.set(sha, { tree, parents: [parent], message });
    repo.branches.set(branch, sha);
    return sha;
  }

  /** Starts a finished run with both firmware artifacts for `sha`. */
  build(sha: string, event = "push") {
    const id = this.runs.length + 1;
    const short = sha.slice(0, 7);
    const zip = (variant: string) =>
      zipSync({ [`202610230444-${short}-left.uf2`]: fakeUf2(`left-${variant}`, short), [`202610230444-${short}-right.uf2`]: fakeUf2(`right-${variant}`, short) });
    this.runs.push({
      id,
      sha,
      event,
      artifacts: [
        { id: id * 10 + 1, name: "firmware-clique", zip: zip("clique") },
        { id: id * 10 + 2, name: "firmware-no-clique", zip: zip("legacy") },
      ],
    });
  }

  install() {
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => this.handle(String(input instanceof Request ? input.url : input), init)) as typeof fetch;
    return () => {
      globalThis.fetch = real;
    };
  }

  private json(body: unknown, status = 200, headers: Record<string, string> = {}) {
    return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  }

  private notFound() {
    return this.json({ message: "Not Found" }, 404);
  }

  private async handle(url: string, init?: RequestInit): Promise<Response> {
    const method = (init?.method ?? "GET").toUpperCase();
    if (!url.startsWith("https://api.github.com/")) return new Response("not here", { status: 404 });
    const u = new URL(url);
    const path = u.pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.requests.push(`${method} ${path}${u.search}`);
    this.cacheModes.push(init?.cache ?? "default");

    if (path === "/user") return this.json({ login: this.login }, 200, { "x-oauth-scopes": this.scopes.join(", ") });
    if (path === "/user/repos") return this.json([...this.repos.values()].filter((r) => r.owner === this.login).map((r) => this.raw(r)));

    const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
    if (!m) return this.notFound();
    const [, owner, name, rest = ""] = m;
    const repo = this.repos.get(`${owner}/${name}`);
    if (!repo) return this.notFound();

    if (rest === "" && method === "GET") return this.json(this.raw(repo));
    if (rest === "/branches") return this.json([...repo.branches.keys()].map((b) => ({ name: b })));

    let r: RegExpExecArray | null;
    if ((r = /^\/git\/ref\/heads\/(.+)$/.exec(rest)) && this.staleHeads.length) {
      return this.json({ object: { sha: this.staleHeads.shift() } });
    }
    if ((r = /^\/git\/ref\/heads\/(.+)$/.exec(rest))) {
      const sha = repo.branches.get(decodeURIComponent(r[1]));
      return sha ? this.json({ object: { sha } }) : this.notFound();
    }
    if ((r = /^\/contents\/(.+)$/.exec(rest))) {
      const ref = u.searchParams.get("ref")!;
      const sha = repo.branches.get(ref) ?? ref;
      const tree = this.commits.get(sha)?.tree;
      if (!tree) return this.notFound();
      const p = decodeURIComponent(r[1]);
      const file = tree.get(p);
      if (file) return this.json({ content: toBase64(file), encoding: "base64" });
      const inside = [...tree.keys()].filter((k) => k.startsWith(`${p}/`) && !k.slice(p.length + 1).includes("/"));
      return inside.length ? this.json(inside.map((k) => ({ name: k.slice(p.length + 1), type: "file" }))) : this.notFound();
    }
    if ((r = /^\/git\/commits\/(.+)$/.exec(rest)) && method === "GET") {
      if (!this.commits.has(r[1])) return this.notFound();
      const treeSha = `t${r[1]}`;
      this.trees.set(treeSha, new Map(this.commits.get(r[1])!.tree));
      return this.json({ tree: { sha: treeSha } });
    }
    if (rest === "/git/blobs" && method === "POST") {
      const sha = this.id("b");
      this.blobs.set(sha, fromBase64(body.content));
      return this.json({ sha }, 201);
    }
    if (rest === "/git/trees" && method === "POST") {
      const tree: Files = new Map(body.base_tree ? this.trees.get(body.base_tree) : []);
      for (const e of body.tree) tree.set(e.path, e.content !== undefined ? bytes(e.content) : this.blobs.get(e.sha)!);
      const sha = this.id("t");
      this.trees.set(sha, tree);
      return this.json({ sha }, 201);
    }
    if (rest === "/git/commits" && method === "POST") {
      const sha = this.id("c");
      this.commits.set(sha, { tree: this.trees.get(body.tree)!, parents: body.parents, message: body.message });
      return this.json({ sha }, 201);
    }
    if ((r = /^\/git\/refs\/heads\/(.+)$/.exec(rest)) && method === "PATCH") {
      const branch = decodeURIComponent(r[1]);
      const current = repo.branches.get(branch);
      if (!body.force && !this.commits.get(body.sha)!.parents.includes(current!)) return this.json({ message: "Update is not a fast forward" }, 422);
      repo.branches.set(branch, body.sha);
      if (this.buildOnPush) this.build(body.sha, "push");
      return this.json({ object: { sha: body.sha } });
    }
    if (rest === "/generate" && method === "POST") {
      if (!repo.template) return this.json({ message: "Not a template repository" }, 422);
      const tree = this.commits.get(repo.branches.get(repo.defaultBranch)!)!.tree;
      const files = Object.fromEntries(tree);
      this.addRepo(body.owner, body.name, files, { private: body.private });
      return this.json(this.raw(this.repos.get(`${body.owner}/${body.name}`)!), 201);
    }
    if (rest === "/actions/workflows/build.yml/dispatches" && method === "POST") {
      this.build(repo.branches.get(body.ref)!, "workflow_dispatch");
      return this.json(null, 204);
    }
    if (rest === "/actions/runs" && method === "GET") {
      const sha = u.searchParams.get("head_sha");
      const runs = this.runs.filter((run) => !sha || run.sha === sha);
      return this.json({ workflow_runs: runs.map((run) => this.rawRun(owner, name, run)) });
    }
    if ((r = /^\/actions\/runs\/(\d+)(\/\w+)?$/.exec(rest))) {
      const run = this.runs.find((x) => x.id === Number(r![1]));
      if (!run) return this.notFound();
      if (!r[2]) return this.json(this.rawRun(owner, name, run));
      if (r[2] === "/jobs") {
        return this.json({
          jobs: ["Build (Legacy)", "Build (Clique)"].map((n) => ({ name: n, status: "completed", conclusion: "success", steps: [] })),
        });
      }
      if (r[2] === "/artifacts") {
        return this.json({ artifacts: run.artifacts.map((a) => ({ id: a.id, name: a.name, size_in_bytes: a.zip.length, expired: false })) });
      }
    }
    if ((r = /^\/actions\/artifacts\/(\d+)\/zip$/.exec(rest))) {
      const artifact = this.runs.flatMap((x) => x.artifacts).find((a) => a.id === Number(r![1]));
      return artifact ? new Response(artifact.zip as BodyInit, { status: 200 }) : this.notFound();
    }
    return this.notFound();
  }

  private raw(r: Repo) {
    return {
      name: r.name,
      full_name: `${r.owner}/${r.name}`,
      owner: { login: r.owner },
      fork: false,
      private: r.private,
      default_branch: r.defaultBranch,
      html_url: `https://github.com/${r.owner}/${r.name}`,
      pushed_at: "2026-10-23T00:00:00Z",
      description: null,
    };
  }

  private rawRun(owner: string, name: string, run: Run) {
    return {
      id: run.id,
      status: "completed",
      conclusion: "success",
      html_url: `https://github.com/${owner}/${name}/actions/runs/${run.id}`,
      head_sha: run.sha,
      event: run.event,
      name: "Build",
    };
  }
}
