// Fake update runs for reviewing the update sheet without a keyboard.
// Open the dev server with ?demo=setup, ?demo=auto or ?demo=done.

import type { JobEvent, JobSnapshot, Session } from "../../shared/types";

const base: JobEvent[] = [
  { type: "step", step: "save", state: "done", detail: "Committed 3f9c2ab" },
  { type: "run", url: "https://github.com/octocat/Adv360-Pro-ZMK/actions" },
  { type: "step", step: "build", state: "done", detail: "Built 3f9c2ab" },
  { type: "step", step: "download", state: "done", detail: "323 KB" },
  { type: "step", step: "prepare", state: "done", detail: "Both halves connected" },
];

const scenarios: Record<string, { running: boolean; events: JobEvent[] }> = {
  setup: {
    running: true,
    events: [
      ...base,
      { type: "step", step: "flash-right", state: "active", detail: "Waiting for update mode" },
      { type: "manual", side: "right", reason: "no-autoflash" },
    ],
  },
  auto: {
    running: true,
    events: [
      ...base,
      { type: "step", step: "flash-right", state: "active", detail: "Copying firmware" },
      { type: "step", step: "flash-left", state: "active", detail: "Restarting into update mode" },
    ],
  },
  done: {
    running: false,
    events: [
      ...base,
      { type: "manual", side: "right", reason: "no-autoflash" },
      { type: "manual-done", side: "right" },
      { type: "step", step: "flash-right", state: "done", detail: "Running 3f9c2ab" },
      { type: "step", step: "flash-left", state: "done", detail: "Running 3f9c2ab" },
      { type: "step", step: "verify", state: "done", detail: "Both halves run 3f9c2ab" },
      { type: "done", build: "3f9c2ab", checked: true },
    ],
  },
};

const signedIn: Session = {
  signedIn: true,
  login: "octocat",
  source: "gh",
  missingScopes: [],
  privateRepos: true,
  deviceFlow: false,
  oauth: false,
  ghLogin: "octocat",
  repo: null,
  setup: null,
  onboarded: false,
};

/** Fake sessions for reviewing onboarding: ?demo=repo or ?demo=install. */
export function demoSession(): Session | null {
  if (!import.meta.env.DEV) return null;
  const name = new URLSearchParams(location.search).get("demo");
  if (name === "repo") return signedIn;
  if (name === "install") {
    return {
      ...signedIn,
      repo: {
        owner: "octocat",
        name: "Adv360-Pro-ZMK",
        branch: "main",
        url: "https://github.com/octocat/Adv360-Pro-ZMK/tree/main",
        head: "3f9c2ab",
      },
      setup: {
        installed: false,
        outdated: false,
        changes: ["tandem/zmk-tandem/Kconfig", ".github/workflows/build.yml", "config/adv360.keymap"],
        blocker: null,
      },
    };
  }
  return null;
}

export function demoJob(): JobSnapshot | null {
  if (!import.meta.env.DEV) return null;
  const name = new URLSearchParams(location.search).get("demo");
  const scenario = name ? scenarios[name] : undefined;
  return scenario ? { id: `demo-${name}`, ...scenario } : null;
}
