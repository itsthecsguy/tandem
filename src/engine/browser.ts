// Tandem running entirely in this tab: GitHub's API for the repo and builds,
// and Web Serial for the keyboard where the browser has it.

import type { ImportedLayout, JobEvent, JobSnapshot } from "../../shared/types";
import { finishSignIn, startSignIn } from "./auth";
import { keptBuilds } from "./builds";
import { cancelJob, currentJob, startLeaving, startRollback, startUpdate } from "./jobs";
import { type KeyboardAccess, noKeyboard } from "./keyboard";
import { createHub } from "./live";
import { createFromTemplate } from "./newrepo";
import { saveState } from "./store";
import type { Engine } from "./types";
import {
  appState,
  connectRepo,
  disconnectRepo,
  github,
  installTandem,
  leaveBeta,
  listBranches,
  listRepos,
  saveKeymap,
  session,
  signOut,
  startBeta,
  undoUpdate,
  updateHistory,
  useGhLogin,
} from "./workspace";

export function browserEngine(keyboard: KeyboardAccess = noKeyboard()): Engine {
  const hub = createHub(currentJob);
  hub.emit({ type: "devices", devices: keyboard.devices() });
  keyboard.watch((devices) => hub.emit({ type: "devices", devices }));

  // GitHub may have just sent the browser back from signing in.
  let signInError: string | undefined;
  const signedIn = finishSignIn().catch((e: Error) => {
    signInError = e.message;
  });

  const currentSession = async () => {
    await signedIn;
    const s = await session();
    if (signInError) {
      s.signInError = signInError;
      signInError = undefined;
    }
    return s;
  };

  let imported: { layout: ImportedLayout; keymapText?: string } | null = null;

  const listen = {
    start: (snapshot: JobSnapshot) => hub.emit({ type: "job", job: snapshot }),
    event: (event: JobEvent) => hub.emit({ type: "job-event", event }),
  };

  return {
    caps: { engine: "browser", ...keyboard.caps },
    session: currentSession,
    signIn: (options) => startSignIn(!!options?.privateRepos),
    useGh: async () => {
      useGhLogin();
      return currentSession();
    },
    startDevice: async () => {
      throw new Error("Device sign-in is only in the local helper.");
    },
    deviceStatus: async () => null,
    signOut: async () => {
      signOut();
      return currentSession();
    },
    repos: listRepos,
    branches: listBranches,
    connect: async (repo) => {
      connectRepo(repo);
      return currentSession();
    },
    disconnect: async () => {
      disconnectRepo();
      return currentSession();
    },
    newRepo: async ({ name, private: isPrivate, fromKeyboard }) => {
      if (fromKeyboard && !imported) throw new Error("Read the layout from your keyboard first");
      const gh = await github();
      const { login } = await gh.whoami();
      const repo = await createFromTemplate(gh, login, {
        name,
        private: isPrivate,
        layers: fromKeyboard ? imported!.layout.layers : undefined,
        keymapText: fromKeyboard ? imported!.keymapText : undefined,
      });
      connectRepo(repo);
      return currentSession();
    },
    install: async () => {
      const sha = await installTandem();
      return { sha, session: await currentSession() };
    },
    completeOnboarding: async () => {
      saveState({ onboarded: true });
      return currentSession();
    },
    restartOnboarding: async () => {
      saveState({ onboarded: false });
      return currentSession();
    },
    keyboard: () => keyboard.info(),
    readKeyboard: async () => {
      imported = await keyboard.readLayout();
      return imported.layout;
    },
    state: appState,
    saveKeymap: async (keymap) => {
      await saveKeymap(keymap);
      return appState();
    },
    saveSettings: async (settings) => {
      saveState({ settings });
      return appState();
    },
    update: async (keymap) => {
      const job = startUpdate(keymap, keyboard.flash, listen);
      return { id: job.id };
    },
    history: async () => {
      const [builds, updates] = await Promise.all([keptBuilds(), updateHistory()]);
      return { builds, updates };
    },
    flashBuild: async (key) => ({ id: startRollback(key, keyboard.flash, listen).id }),
    undoUpdate: async (sha) => {
      await undoUpdate(sha);
      return currentSession();
    },
    leaveTandem: async () => ({ id: startLeaving(keyboard.flash, listen).id }),
    startBeta: async () => {
      const kept = await startBeta();
      return { session: await currentSession(), kept };
    },
    leaveBeta: async () => {
      const { beta } = await currentSession();
      if (beta) await leaveBeta(beta.from);
      return currentSession();
    },
    cancel: async () => {
      cancelJob();
      return { ok: true };
    },
    connectKeyboard: () => keyboard.connect(),
    allowUpdatePort: () => keyboard.allowUpdatePort(),
    act: (action) => keyboard.act(action),
    subscribe: (listener) => hub.subscribe(listener),
  };
}
