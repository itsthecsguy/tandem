import { afterEach, describe, expect, it, vi } from "vitest";

import worker, { type Env } from "../worker/index";

const SITE = "https://tandemkb.com";

const env = (over: Partial<Env> = {}): Env => ({
  ASSETS: { fetch: async () => new Response("<!doctype html>", { headers: { "content-type": "text/html" } }) },
  GITHUB_CLIENT_ID: "Ov23liTest",
  GITHUB_CLIENT_SECRET: "shh",
  ...over,
});

const exchange = (body: unknown, origin = SITE, method = "POST") =>
  new Request(`${SITE}/api/auth/token`, {
    method,
    headers: { origin, "content-type": "application/json" },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });

const good = { code: "abc", code_verifier: "v1", redirect_uri: `${SITE}/auth/callback` };

afterEach(() => vi.unstubAllGlobals());

describe("worker", () => {
  it("tells the page which OAuth app to use", async () => {
    const res = await worker.fetch(new Request(`${SITE}/api/auth/config`), env());
    expect(await res.json()).toEqual({ clientId: "Ov23liTest" });
    expect((await worker.fetch(new Request(`${SITE}/api/auth/config`), env({ GITHUB_CLIENT_ID: "" }))).status).toBe(404);
  });

  it("trades a code for a token with the app's secret", async () => {
    const sent: { url: string; body: Record<string, string> }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ access_token: "gho_new", scope: "public_repo,workflow" }));
    });
    const res = await worker.fetch(exchange(good), env());
    expect(await res.json()).toEqual({ token: "gho_new", scope: "public_repo,workflow" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(sent).toEqual([
      {
        url: "https://github.com/login/oauth/access_token",
        body: { client_id: "Ov23liTest", client_secret: "shh", code: "abc", code_verifier: "v1", redirect_uri: `${SITE}/auth/callback` },
      },
    ]);
  });

  it("passes on GitHub's reason when it refuses", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "bad_verification_code", error_description: "The code passed is incorrect or expired." })));
    const res = await worker.fetch(exchange(good), env());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "The code passed is incorrect or expired." });
  });

  it("only trades codes for its own pages", async () => {
    const github = vi.fn();
    vi.stubGlobal("fetch", github);
    expect((await worker.fetch(exchange(good, "https://evil.example"), env())).status).toBe(403);
    expect((await worker.fetch(exchange({ ...good, redirect_uri: "https://evil.example/cb" }), env())).status).toBe(400);
    expect((await worker.fetch(exchange({ ...good, code: "" }), env())).status).toBe(400);
    expect((await worker.fetch(exchange(null, SITE, "GET"), env())).status).toBe(405);
    expect((await worker.fetch(exchange(good), env({ GITHUB_CLIENT_SECRET: undefined }))).status).toBe(503);
    expect(github).not.toHaveBeenCalled();
  });

  it("serves the site with security headers", async () => {
    const res = await worker.fetch(new Request(`${SITE}/auth/callback?code=abc`), env());
    expect(await res.text()).toBe("<!doctype html>");
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(res.headers.get("content-security-policy")).toContain("https://api.github.com");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("answers unknown API paths with 404", async () => {
    expect((await worker.fetch(new Request(`${SITE}/api/nope`), env())).status).toBe(404);
  });
});
