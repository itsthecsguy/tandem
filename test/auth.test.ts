import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

describe("sign-in scopes", () => {
  it("counts repo as covering public_repo", async () => {
    const { missingScopes, scopesFor } = await import("../src/engine/auth");
    expect(missingScopes(["repo", "workflow"])).toEqual([]);
    expect(missingScopes(["public_repo"])).toEqual(["workflow"]);
    expect(missingScopes([])).toEqual(["public_repo", "workflow"]);
    expect(scopesFor(false)).toEqual(["public_repo", "workflow"]);
    expect(scopesFor(true)).toEqual(["repo", "workflow"]);
  });

  it("makes PKCE challenges like RFC 7636's example", async () => {
    const { pkceChallenge } = await import("../src/engine/auth");
    expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});

describe("finishing sign-in", () => {
  /** A page at /auth/callback, as GitHub sends the browser back. */
  function callback(search: string, pending: { state: string; verifier: string } | null) {
    const storage = new Map<string, string>(pending ? [["tandem.oauth", JSON.stringify(pending)]] : []);
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => storage.set(k, v),
      removeItem: (k: string) => storage.delete(k),
    });
    vi.stubGlobal("location", { pathname: "/auth/callback", search, origin: "https://tandemkb.com" });
    const urls: string[] = [];
    vi.stubGlobal("history", { replaceState: (_s: unknown, _t: string, url: string) => urls.push(url) });
    return { urls, storage };
  }

  async function load() {
    vi.resetModules();
    return { auth: await import("../src/engine/auth"), store: await import("../src/engine/store") };
  }

  it("trades the code for a token and keeps it", async () => {
    const { urls, storage } = callback("?code=abc&state=s1", { state: "s1", verifier: "v1" });
    const sent: { url: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ token: "gho_new", scope: "public_repo,workflow" }), { headers: { "content-type": "application/json" } });
    });
    const { auth, store } = await load();
    await auth.finishSignIn();
    expect(sent).toEqual([{ url: "/api/auth/token", body: { code: "abc", code_verifier: "v1", redirect_uri: "https://tandemkb.com/auth/callback" } }]);
    expect(store.loadToken()).toEqual({ token: "gho_new", scope: "public_repo,workflow" });
    expect(urls).toEqual(["/"]);
    expect(storage.has("tandem.oauth")).toBe(false);
  });

  it("refuses a callback this page didn't start", async () => {
    callback("?code=abc&state=forged", { state: "s1", verifier: "v1" });
    const github = vi.fn();
    vi.stubGlobal("fetch", github);
    const { auth, store } = await load();
    await expect(auth.finishSignIn()).rejects.toThrow(/doesn't match/);
    expect(github).not.toHaveBeenCalled();
    expect(store.loadToken()).toBeNull();
  });

  it("says why GitHub stopped", async () => {
    callback("?error=access_denied&error_description=The+user+has+denied+your+application+access.", { state: "s1", verifier: "v1" });
    const { auth } = await load();
    await expect(auth.finishSignIn()).rejects.toThrow(/denied your application access/);
  });
});

describe("keeping a sign-in alive", () => {
  async function load() {
    vi.resetModules();
    return { auth: await import("../src/engine/auth"), store: await import("../src/engine/store") };
  }

  it("renews a token shortly before it expires", async () => {
    const { auth, store } = await load();
    store.saveToken({ token: "ghu_old", scope: "", refreshToken: "ghr_1", expiresAt: Date.now() + 60_000 });
    const sent: unknown[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ token: "ghu_new", scope: "", refreshToken: "ghr_2", expiresIn: 28800 }));
    });
    expect(await auth.getToken()).toEqual({ token: "ghu_new", source: "oauth" });
    expect(sent).toEqual([{ url: "/api/auth/refresh", body: { refresh_token: "ghr_1" } }]);
    expect(store.loadToken()).toMatchObject({ token: "ghu_new", refreshToken: "ghr_2" });
    expect(store.loadToken()!.expiresAt).toBeGreaterThan(Date.now() + 7 * 3600_000);
  });

  it("leaves a fresh token alone", async () => {
    const { auth, store } = await load();
    store.saveToken({ token: "ghu_fresh", scope: "", refreshToken: "ghr_1", expiresAt: Date.now() + 3600_000 });
    const github = vi.fn();
    vi.stubGlobal("fetch", github);
    expect(await auth.getToken()).toEqual({ token: "ghu_fresh", source: "oauth" });
    expect(github).not.toHaveBeenCalled();
  });

  it("signs out when GitHub won't renew it", async () => {
    const { auth, store } = await load();
    store.saveToken({ token: "ghu_old", scope: "", refreshToken: "ghr_revoked", expiresAt: Date.now() - 1000 });
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "The refresh token is invalid." }), { status: 400 }));
    expect(await auth.getToken()).toBeNull();
    expect(store.loadToken()).toBeNull();
  });
});
