// Types shared by the web UI, the browser engine and the helper.

export interface LayoutKey {
  index: number;
  label: string;
  row: number;
  col: number;
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
  rx: number;
  ry: number;
}

export interface Layer {
  /** Devicetree node name, e.g. "layer_fn". */
  node: string;
  name: string;
  /** One raw ZMK binding per key, in layout order, e.g. "&kp A". */
  bindings: string[];
}

export interface RepeatTiming {
  /** How long a key must be held before it counts as a hold. */
  tappingTermMs: number;
  /** Window after a tap in which pressing again repeats the tap. */
  quickTapMs: number;
}

export interface Keymap {
  layers: Layer[];
  repeat: RepeatTiming;
}

export interface BuildSettings {
  /** Include ZMK Studio on the left half, as Kinesis's "Clique" build does. */
  studio: boolean;
}

export interface RepoRef {
  owner: string;
  name: string;
  branch: string;
}

export interface SetupStatus {
  /** Module and workflow are in place. */
  installed: boolean;
  /** Installed, but the module differs from this app's copy. */
  outdated: boolean;
  /** Files the setup commit would add or change. */
  changes: string[];
  /** Why setup can't run, if it can't. */
  blocker: string | null;
}

export interface Session {
  signedIn: boolean;
  login: string | null;
  source: "device" | "gh" | "oauth" | null;
  /** Token scopes Tandem needs but doesn't have. */
  missingScopes: string[];
  /** The token can see and change private repos. */
  privateRepos: boolean;
  /** GitHub sign-in through the device flow is configured (helper). */
  deviceFlow: boolean;
  /** GitHub sign-in through this site's OAuth app is configured (browser). */
  oauth: boolean;
  /** The GitHub CLI is signed in as this account. */
  ghLogin: string | null;
  repo: (RepoRef & { url: string; head: string }) | null;
  setup: SetupStatus | null;
  /** Finished onboarding, including the first flash. */
  onboarded: boolean;
  /** Why the last sign-in on GitHub didn't finish, shown once. */
  signInError?: string;
}

/** What setup found on the connected keyboard. */
export interface KeyboardInfo {
  left: HalfStatus;
  right: HalfStatus;
  /** The left half runs Tandem firmware that can report its own keymap. */
  tandemKeymap: boolean;
  /** Repo the left half's Tandem firmware was built from, if it says. */
  tandemRepo: string | null;
  /** ZMK Studio on the left half, for keyboards without Tandem firmware. */
  studio: { available: boolean; name: string | null; locked: boolean } | null;
  /** Kinesis's physical layout, for drawing the keyboard before a repo exists. */
  layout: LayoutKey[];
}

/** A layout read from the keyboard, to start a new repo from. */
export interface ImportedLayout {
  source: "tandem" | "studio";
  layers: Omit<Layer, "node">[];
  /** Keys that couldn't be translated and were left empty. */
  unknown: string[];
  layout: LayoutKey[];
}

export interface RepoOption {
  owner: string;
  name: string;
  fullName: string;
  fork: boolean;
  private: boolean;
  defaultBranch: string;
  pushedAt: string;
  description: string | null;
}

export interface AppState {
  repo: RepoRef & { url: string };
  layout: LayoutKey[];
  rows: number[];
  keymap: Keymap;
  settings: BuildSettings;
  /** Build ID the halves report when they run the branch's latest commit. */
  buildId: string;
  lastBuild: BuildRecord | null;
}

export interface BuildRecord {
  id: string;
  createdAt: string;
  left: string;
  right: string;
}

export type Side = "left" | "right";

export type HalfMode = "missing" | "app" | "bootloader";

export interface HalfStatus {
  side: Side;
  mode: HalfMode;
  serial: string | null;
  /** Firmware answered the Tandem info query, so updates need no key presses. */
  autoflash: boolean;
  /** Build ID reported by Tandem firmware. */
  build: string | null;
  /** Repo the firmware was built from, as owner/name. Tandem protocol 2 and up. */
  repo: string | null;
  /** Tandem protocol version: 1 has info only, 2 adds the repo and the keymap. */
  protocol: number;
  /** Tandem serial port, when present. */
  port: string | null;
  /** Mounted bootloader drive, in bootloader mode. */
  volume: string | null;
  /** The half's other serial ports, such as ZMK Studio's. */
  otherPorts: string[];
}

export interface DevicesStatus {
  left: HalfStatus;
  right: HalfStatus;
  /** Bootloader drives whose half we couldn't identify yet. */
  unknownBootloaders: { volume: string; serial: string | null }[];
  /** The browser needs the user's OK before it can see a half's port. */
  needsAccess: boolean;
  scannedAt: string;
}

export type StepId = "save" | "build" | "download" | "prepare" | "flash-left" | "flash-right" | "verify";
export type StepState = "pending" | "active" | "done" | "skipped" | "error";

export type JobEvent =
  | { type: "step"; step: StepId; state: StepState; detail?: string }
  | { type: "log"; line: string }
  | { type: "run"; url: string }
  | { type: "manual"; side: Side; reason: "no-autoflash" | "no-response" }
  | { type: "manual-done"; side: Side }
  /** The key combo put the other half in update mode, so that half is updated first. */
  | { type: "switched"; from: Side; to: Side }
  | { type: "plug-in"; side: Side }
  /** The browser needs the user to choose this half's update drive. */
  | { type: "drive"; side: Side }
  | { type: "drive-done"; side: Side }
  /**
   * The browser needs the user's OK to open this half's port: after its first
   * Tandem firmware, or before an update when it can't see the half at all.
   */
  | {
      type: "grant-port";
      side: Side;
      before?: boolean;
      retry?: boolean;
      /** Left half only: its ZMK Studio port is already allowed, so Chrome marks that entry Paired. */
      studioPaired?: boolean;
      /** Asking again because the last pick was an entry that was connected already. */
      paired?: boolean;
    }
  | { type: "grant-port-done"; side: Side }
  /** The half is in update mode: the browser needs the user's OK to open its update port, once. */
  | { type: "update-port"; side: Side }
  | { type: "update-port-done"; side: Side }
  /** This browser can't reach the keyboard: download both files and copy them by hand. */
  | { type: "manual-flash"; left: string; right: string }
  | { type: "manual-flash-done" }
  | { type: "done"; build: string; checked: boolean }
  | { type: "error"; message: string };

/** The user's answer to something an update asked for. */
export type JobAction =
  | { type: "pick-drive"; side: Side }
  | { type: "grant-port"; side: Side; skip?: boolean }
  | { type: "grant-update-port"; side: Side }
  | { type: "manual-flash-done" };

export interface JobSnapshot {
  id: string;
  running: boolean;
  events: JobEvent[];
  /** The page reloaded while this update ran, so it stopped part way. */
  interrupted?: boolean;
}
