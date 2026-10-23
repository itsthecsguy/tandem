// The local helper, reached over HTTP on the same origin. It serves this page
// itself, so its API is at /api. Live updates come over one event stream.

import type { Engine, LiveEvent } from "./types";

const demo = import.meta.env.DEV && new URLSearchParams(location.search).has("demo");

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  // Demo screens are for looking at. Never let them commit or flash anything.
  if (demo && method !== "GET") throw new Error("Demo mode doesn't send changes.");
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `${method} ${path} failed`);
  return data as T;
}

export function helperEngine(): Engine {
  return {
    caps: { engine: "helper", keyboard: true, flash: true },
    session: () => call("GET", "/api/session"),
    signIn: async () => {
      throw new Error("The helper signs in with the GitHub CLI or GitHub's device flow.");
    },
    useGh: () => call("POST", "/api/auth/gh"),
    startDevice: () => call("POST", "/api/auth/device"),
    deviceStatus: () => call("GET", "/api/auth/device"),
    signOut: () => call("POST", "/api/auth/signout"),
    repos: () => call("GET", "/api/repos"),
    branches: (owner, name) => call("GET", `/api/repos/${owner}/${name}/branches`),
    connect: (repo) => call("POST", "/api/repo", repo),
    disconnect: () => call("POST", "/api/repo/disconnect"),
    newRepo: (options) => call("POST", "/api/repo/new", options),
    install: () => call("POST", "/api/repo/install"),
    completeOnboarding: () => call("POST", "/api/onboarding/complete"),
    restartOnboarding: () => call("POST", "/api/onboarding/restart"),
    keyboard: () => call("GET", "/api/keyboard"),
    readKeyboard: () => call("POST", "/api/keyboard/read"),
    state: () => call("GET", "/api/state"),
    saveKeymap: (keymap) => call("PUT", "/api/keymap", { keymap }),
    saveSettings: (settings) => call("PUT", "/api/settings", settings),
    update: (keymap) => call("POST", "/api/update", { keymap }),
    cancel: () => call("POST", "/api/update/cancel"),
    // The helper finds the halves over USB and copies firmware itself.
    connectKeyboard: async () => {},
    act: async () => {},
    subscribe(listener: (e: LiveEvent) => void) {
      const source = new EventSource("/api/events");
      source.onopen = () => listener({ type: "connected", connected: true });
      source.onerror = () => listener({ type: "connected", connected: false });
      source.addEventListener("devices", (e) => listener({ type: "devices", devices: JSON.parse(e.data) }));
      source.addEventListener("job", (e) => listener({ type: "job", job: JSON.parse(e.data) }));
      source.addEventListener("job-event", (e) => listener({ type: "job-event", event: JSON.parse(e.data) }));
      return () => source.close();
    },
  };
}
