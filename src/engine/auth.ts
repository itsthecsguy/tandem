// Where the browser's GitHub token comes from.
//
// On the site, people sign in on GitHub with the site's OAuth app. GitHub
// sends them back to /auth/callback with a code, and the site's Worker trades
// the code for a token, since that step needs the app's secret and GitHub
// doesn't let browsers call it. See worker/index.ts.
//
// In development there's no Worker, so Tandem can use the GitHub CLI's login,
// which the Vite dev server reads for this page only.

import { loadState, loadToken, saveState, saveToken } from "./store";

/** Scopes Tandem asks for. `repo` replaces `public_repo` once someone needs private repos. */
export function scopesFor(privateRepos: boolean): string[] {
  return [privateRepos ? "repo" : "public_repo", "workflow"];
}

/** Scopes Tandem needs that a token with `granted` lacks. `repo` covers `public_repo`. */
export function missingScopes(granted: string[]): string[] {
  const missing: string[] = [];
  if (!granted.includes("repo") && !granted.includes("public_repo")) missing.push("public_repo");
  if (!granted.includes("workflow")) missing.push("workflow");
  return missing;
}

export interface Token {
  token: string;
  source: "oauth" | "gh";
}

let devCache: { token: Promise<string | null>; at: number } | null = null;

/** The GitHub CLI's token, in development only. Asked for at most once a minute. */
export function ghCliToken(): Promise<string | null> {
  if (!import.meta.env.DEV) return Promise.resolve(null);
  if (devCache && Date.now() - devCache.at < 60_000) return devCache.token;
  const token = fetch("/__dev/gh-token", { headers: { "X-Tandem-Dev": "1" } })
    .then(async (res) => (res.ok ? ((await res.json()).token ?? null) : null))
    // No dev server, or no GitHub CLI.
    .catch(() => null);
  devCache = { token, at: Date.now() };
  return token;
}

export async function getToken(): Promise<Token | null> {
  const stored = loadToken();
  if (stored) return { token: stored.token, source: "oauth" };
  if (loadState().useGh) {
    const token = await ghCliToken();
    if (token) return { token, source: "gh" };
  }
  return null;
}

export function signOut() {
  saveToken(null);
  saveState({ useGh: false });
  devCache = null;
}

// OAuth sign-in.

let config: Promise<{ clientId: string } | null> | null = null;

/** The site's OAuth app, if this page is served by the site's Worker. */
export function oauthConfig(): Promise<{ clientId: string } | null> {
  config ??= fetch("/api/auth/config")
    .then(async (res) => {
      if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return null;
      const { clientId } = await res.json();
      return typeof clientId === "string" && clientId ? { clientId } : null;
    })
    .catch(() => null);
  return config;
}

const PENDING = "tandem.oauth";
const CALLBACK = "/auth/callback";

function randomString(bytes: number): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return base64url(data);
}

function base64url(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** Sends the browser to GitHub to sign in. */
export async function startSignIn(privateRepos: boolean): Promise<void> {
  const app = await oauthConfig();
  if (!app) throw new Error("GitHub sign-in isn't set up on this site.");
  const state = randomString(16);
  const verifier = randomString(48);
  sessionStorage.setItem(PENDING, JSON.stringify({ state, verifier }));
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", app.clientId);
  url.searchParams.set("redirect_uri", location.origin + CALLBACK);
  url.searchParams.set("scope", scopesFor(privateRepos).join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", await pkceChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("allow_signup", "true");
  location.assign(url.toString());
}

/**
 * Finishes sign-in when GitHub has sent the browser back here. Does nothing on
 * any other page. Throws if the sign-in failed.
 */
export async function finishSignIn(): Promise<void> {
  if (typeof location === "undefined" || location.pathname !== CALLBACK) return;
  const params = new URLSearchParams(location.search);
  const pending = JSON.parse(sessionStorage.getItem(PENDING) ?? "null") as { state: string; verifier: string } | null;
  sessionStorage.removeItem(PENDING);
  history.replaceState(null, "", "/");

  const error = params.get("error_description") ?? params.get("error");
  if (error) throw new Error(`GitHub sign-in didn't finish: ${error}`);
  const code = params.get("code");
  if (!code || !pending || params.get("state") !== pending.state) {
    throw new Error("That sign-in link doesn't match one this page started. Sign in again.");
  }

  const res = await fetch("/api/auth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, code_verifier: pending.verifier, redirect_uri: location.origin + CALLBACK }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.token) throw new Error(data.error ?? "GitHub sign-in failed. Try again.");
  saveToken({ token: data.token, scope: data.scope ?? "" });
  saveState({ useGh: false });
}
