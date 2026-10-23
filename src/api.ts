import { useEffect, useState } from "react";

import type {
  AppState,
  BuildSettings,
  DevicesStatus,
  ImportedLayout,
  JobEvent,
  KeyboardInfo,
  JobSnapshot,
  Keymap,
  RepoOption,
  RepoRef,
  Session,
} from "../shared/types";

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

export const api = {
  session: () => call<Session>("GET", "/api/session"),
  useGh: () => call<Session>("POST", "/api/auth/gh"),
  startDevice: () => call<{ userCode: string; url: string }>("POST", "/api/auth/device"),
  deviceStatus: () => call<{ status: "pending" | "done" | "error"; error?: string } | null>("GET", "/api/auth/device"),
  signOut: () => call<Session>("POST", "/api/auth/signout"),
  repos: () => call<RepoOption[]>("GET", "/api/repos"),
  branches: (owner: string, name: string) =>
    call<{ branches: string[]; suggested: string }>("GET", `/api/repos/${owner}/${name}/branches`),
  connect: (repo: RepoRef) => call<Session>("POST", "/api/repo", repo),
  disconnect: () => call<Session>("POST", "/api/repo/disconnect"),
  newRepo: (options: { name: string; private: boolean; fromKeyboard: boolean }) => call<Session>("POST", "/api/repo/new", options),
  install: () => call<{ sha: string; session: Session }>("POST", "/api/repo/install"),
  completeOnboarding: () => call<Session>("POST", "/api/onboarding/complete"),
  restartOnboarding: () => call<Session>("POST", "/api/onboarding/restart"),
  keyboard: () => call<KeyboardInfo>("GET", "/api/keyboard"),
  readKeyboard: () => call<ImportedLayout>("POST", "/api/keyboard/read"),
  state: () => call<AppState>("GET", "/api/state"),
  saveKeymap: (keymap: Keymap) => call<AppState>("PUT", "/api/keymap", { keymap }),
  saveSettings: (settings: BuildSettings) => call<AppState>("PUT", "/api/settings", settings),
  update: (keymap?: Keymap) => call<{ id: string }>("POST", "/api/update", { keymap }),
  cancel: () => call<{ ok: true }>("POST", "/api/update/cancel"),
};

/** Live device status and update progress from the helper. */
export function useLive() {
  const [devices, setDevices] = useState<DevicesStatus | null>(null);
  const [job, setJob] = useState<JobSnapshot | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const source = new EventSource("/api/events");
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.addEventListener("devices", (e) => setDevices(JSON.parse(e.data)));
    source.addEventListener("job", (e) => setJob(JSON.parse(e.data)));
    source.addEventListener("job-event", (e) => {
      const event: JobEvent = JSON.parse(e.data);
      setJob((prev) =>
        prev
          ? {
              ...prev,
              events: [...prev.events, event],
              running: event.type === "done" || event.type === "error" ? false : prev.running,
            }
          : prev,
      );
    });
    return () => source.close();
  }, []);

  return { devices, job, connected };
}
