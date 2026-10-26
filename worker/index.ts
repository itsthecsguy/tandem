// The site's only server code, as a Cloudflare Worker. It serves the built
// site with security headers, and finishes GitHub sign-in: GitHub's token
// endpoint needs the OAuth app's secret and refuses requests from browsers,
// so the page sends the code here, and later the refresh token when the
// access token is about to expire. The Worker keeps nothing.

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  /** The OAuth app's client ID. Public, so it's a plain variable. */
  GITHUB_CLIENT_ID?: string;
  /** Set with `wrangler secret put GITHUB_CLIENT_SECRET`. */
  GITHUB_CLIENT_SECRET?: string;
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://avatars.githubusercontent.com",
  // Firmware downloads redirect from GitHub's API to its artifact storage.
  "connect-src 'self' https://api.github.com https://*.blob.core.windows.net https://*.actions.githubusercontent.com",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

interface GitHubToken {
  access_token?: string;
  scope?: string;
  /** Present when the OAuth app makes tokens expire. */
  expires_in?: number;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

/** Asks GitHub for a token, adding the app's ID and secret. */
async function tokenFromGitHub(env: Env, params: Record<string, string>): Promise<Response> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": "tandem" },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, ...params }),
  });
  const data = (await res.json().catch(() => ({}))) as GitHubToken;
  if (!data.access_token) return json({ error: data.error_description ?? data.error ?? "GitHub didn't send a token." }, 400);
  return json({
    token: data.access_token,
    scope: data.scope ?? "",
    ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
    ...(data.expires_in ? { expiresIn: data.expires_in } : {}),
  });
}

/** Checks a sign-in request came from this site's own pages, and returns its body. */
async function ownRequest(request: Request, env: Env): Promise<{ origin: string; body: Record<string, unknown> } | Response> {
  if (request.method !== "POST") return json({ error: "Use POST" }, 405);
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return json({ error: "GitHub sign-in isn't set up on this site." }, 503);
  const origin = new URL(request.url).origin;
  if (request.headers.get("origin") !== origin) return json({ error: "Wrong origin" }, 403);
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  return { origin, body: body ?? {} };
}

async function exchange(request: Request, env: Env): Promise<Response> {
  const checked = await ownRequest(request, env);
  if (checked instanceof Response) return checked;
  const { origin, body } = checked;
  const redirect = `${origin}/auth/callback`;
  if (typeof body.code !== "string" || !body.code) return json({ error: "Missing code" }, 400);
  if (body.redirect_uri !== redirect) return json({ error: "Wrong redirect" }, 400);
  return tokenFromGitHub(env, {
    code: body.code,
    redirect_uri: redirect,
    ...(typeof body.code_verifier === "string" ? { code_verifier: body.code_verifier } : {}),
  });
}

async function refresh(request: Request, env: Env): Promise<Response> {
  const checked = await ownRequest(request, env);
  if (checked instanceof Response) return checked;
  const token = checked.body.refresh_token;
  if (typeof token !== "string" || !token) return json({ error: "Missing refresh token" }, 400);
  return tokenFromGitHub(env, { grant_type: "refresh_token", refresh_token: token });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/auth/config") {
      return env.GITHUB_CLIENT_ID ? json({ clientId: env.GITHUB_CLIENT_ID }) : json({ error: "GitHub sign-in isn't set up on this site." }, 404);
    }
    if (pathname === "/api/auth/token") return exchange(request, env);
    if (pathname === "/api/auth/refresh") return refresh(request, env);
    if (pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);

    const res = await env.ASSETS.fetch(request);
    const headers = new Headers(res.headers);
    headers.set("content-security-policy", CSP);
    headers.set("x-content-type-options", "nosniff");
    // The sign-in callback's URL holds a code. Never send it anywhere.
    headers.set("referrer-policy", "no-referrer");
    headers.set("permissions-policy", "serial=(self)");
    // Browsers only keep this from HTTPS answers, so it's harmless in local dev.
    headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
    // Sign-in is a full-page redirect, so no other window needs a handle on this one.
    headers.set("cross-origin-opener-policy", "same-origin");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  },
};
