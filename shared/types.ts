// Types shared by the helper server and the web UI.

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
  source: "device" | "gh" | null;
  /** Token scopes Tandem needs but doesn't have. */
  missingScopes: string[];
  /** GitHub sign-in through the device flow is configured. */
  deviceFlow: boolean;
  /** The GitHub CLI is signed in as this account. */
  ghLogin: string | null;
  repo: (RepoRef & { url: string; head: string }) | null;
  setup: SetupStatus | null;
  /** Finished onboarding, including the first flash. */
  onboarded: boolean;
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
  | { type: "plug-in"; side: Side }
  | { type: "done"; build: string }
  | { type: "error"; message: string };

export interface JobSnapshot {
  id: string;
  running: boolean;
  events: JobEvent[];
}
