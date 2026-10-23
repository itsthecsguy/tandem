// The site's only server code, as a Cloudflare Worker. It serves the built
// site with security headers, and finishes GitHub sign-in: GitHub's token
// endpoint needs the OAuth app's secret and refuses requests from browsers,
// so the page sends the code here. The Worker keeps nothing.

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
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

async function exchange(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return json({ error: "Use POST" }, 405);
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return json({ error: "GitHub sign-in isn't set up on this site." }, 503);

  // Only this site's own pages may trade a code.
  const origin = new URL(request.url).origin;
  if (request.headers.get("origin") !== origin) return json({ error: "Wrong origin" }, 403);

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const code = body?.code;
  const verifier = body?.code_verifier;
  const redirect = `${origin}/auth/callback`;
  if (typeof code !== "string" || !code) return json({ error: "Missing code" }, 400);
  if (body?.redirect_uri !== redirect) return json({ error: "Wrong redirect" }, 400);

  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": "tandem" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirect,
      ...(typeof verifier === "string" ? { code_verifier: verifier } : {}),
    }),
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; scope?: string; error?: string; error_description?: string };
  if (!data.access_token) return json({ error: data.error_description ?? data.error ?? "GitHub didn't send a token." }, 400);
  return json({ token: data.access_token, scope: data.scope ?? "" });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/auth/config") {
      return env.GITHUB_CLIENT_ID ? json({ clientId: env.GITHUB_CLIENT_ID }) : json({ error: "GitHub sign-in isn't set up on this site." }, 404);
    }
    if (pathname === "/api/auth/token") return exchange(request, env);
    if (pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);

    const res = await env.ASSETS.fetch(request);
    const headers = new Headers(res.headers);
    headers.set("content-security-policy", CSP);
    headers.set("x-content-type-options", "nosniff");
    // The sign-in callback's URL holds a code. Never send it anywhere.
    headers.set("referrer-policy", "no-referrer");
    headers.set("permissions-policy", "serial=(self)");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  },
};
