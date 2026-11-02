// What the UI asks of Tandem. Two engines answer: the browser engine, which
// does everything inside this tab, and the local helper, reached over HTTP.

import type {
  AppState,
  BuildSettings,
  DevicesStatus,
  ImportedLayout,
  JobAction,
  JobEvent,
  JobSnapshot,
  KeyboardInfo,
  Keymap,
  RepoOption,
  RepoRef,
  Session,
  UpdateHistory,
} from "../../shared/types";

export interface Caps {
  engine: "browser" | "helper";
  /** Can see the halves: Web Serial in the browser, USB in the helper. */
  keyboard: boolean;
  /** Can copy firmware onto a half's drive by itself. */
  flash: boolean;
}

export type LiveEvent =
  | { type: "devices"; devices: DevicesStatus }
  | { type: "job"; job: JobSnapshot }
  | { type: "job-event"; event: JobEvent }
  | { type: "connected"; connected: boolean };

export interface Engine {
  caps: Caps;
  session(): Promise<Session>;
  /** Signs in on GitHub's site. Leaves this page, so it only resolves on failure. */
  signIn(options?: { privateRepos?: boolean }): Promise<void>;
  useGh(): Promise<Session>;
  startDevice(): Promise<{ userCode: string; url: string }>;
  deviceStatus(): Promise<{ status: "pending" | "done" | "error"; error?: string } | null>;
  signOut(): Promise<Session>;
  repos(): Promise<RepoOption[]>;
  branches(owner: string, name: string): Promise<{ branches: string[]; suggested: string }>;
  connect(repo: RepoRef): Promise<Session>;
  disconnect(): Promise<Session>;
  newRepo(options: { name: string; private: boolean; fromKeyboard: boolean }): Promise<Session>;
  install(): Promise<{ sha: string; session: Session }>;
  completeOnboarding(): Promise<Session>;
  restartOnboarding(): Promise<Session>;
  keyboard(): Promise<KeyboardInfo>;
  readKeyboard(): Promise<ImportedLayout>;
  state(): Promise<AppState>;
  saveKeymap(keymap: Keymap): Promise<AppState>;
  saveSettings(settings: BuildSettings): Promise<AppState>;
  update(keymap?: Keymap): Promise<{ id: string }>;
  /** Kept builds and Tandem's own commits, for going back. */
  history(): Promise<UpdateHistory>;
  /** Puts a kept build back on the keyboard. The repo stays as it is. */
  flashBuild(key: string): Promise<{ id: string }>;
  /** Undoes one of Tandem's commits, and leaves that release out of later updates. */
  undoUpdate(sha: string): Promise<Session>;
  /** Removes Tandem from the repo and puts Kinesis's firmware on the keyboard. */
  leaveTandem(): Promise<{ id: string }>;
  /** Makes a branch with the ZMK 4.1 port and switches to it. The next update builds it. */
  startBeta(): Promise<{ session: Session; kept: string[] }>;
  /** Switches back to the branch the trial started from. The next update puts it back. */
  leaveBeta(): Promise<Session>;
  cancel(): Promise<{ ok: true }>;
  /** Asks the browser for access to the keyboard's ports. Call it from a click. */
  connectKeyboard(): Promise<void>;
  /** Opens Chrome's list for a half's update port ahead of time. Call it from a click. Says whether the user picked one. */
  allowUpdatePort(): Promise<boolean>;
  /** Answers something a running update asked for. Call it from a click. */
  act(action: JobAction): Promise<void>;
  subscribe(listener: (e: LiveEvent) => void): () => void;
}
