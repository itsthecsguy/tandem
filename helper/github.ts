// The helper's GitHub access: where its token comes from, plus downloads that
// unpack onto disk. The REST calls themselves live in shared/github.ts.
//
// Sign-in uses GitHub's device flow when TANDEM_GITHUB_CLIENT_ID names an
// OAuth app with device flow turned on. Otherwise Tandem can borrow the
// GitHub CLI's login. Device-flow tokens live in the macOS keychain.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { GitHubApi } from "../shared/github";

export { GitHubError, type Artifact, type RepoSummary, type RunJob, type WorkflowRun } from "../shared/github";

const run = promisify(execFile);

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

export class GitHub extends GitHubApi {
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

  /** Downloads an artifact and unzips it into `dest`. Returns the files it held. */
  async downloadArtifact(owner: string, repo: string, id: number, dest: string): Promise<string[]> {
    await mkdir(dest, { recursive: true });
    const zip = join(dest, "artifact.zip");
    await writeFile(zip, await this.artifactZip(owner, repo, id));
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
