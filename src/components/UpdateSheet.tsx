import { ArrowUpRight, Check, Circle, Download, HardDrive, Info, Loader2, Minus, Plug, Usb, X } from "lucide-react";
import type { ReactNode } from "react";

import type { JobAction, Keymap, LayoutKey, Side, StepState } from "../../shared/types";
import { api } from "../api";
import { type Combo, bootloaderCombo } from "../lib/guide";
import { type HandSteps, type JobView, type Mark, STEP_TITLES, stepOrder } from "../lib/job";
import { GitHubMark } from "./GitHubMark";
import { Keyboard } from "./Keyboard";

function StepIcon({ state }: { state: StepState }) {
  switch (state) {
    case "active":
      return <Loader2 size={16} className="spin" />;
    case "done":
      return <Check size={16} />;
    case "skipped":
      return <Minus size={16} />;
    case "error":
      return <X size={16} />;
    default:
      return <Circle size={16} />;
  }
}

const HALF: Record<Side, string> = { left: "left half", right: "right half" };
const Half: Record<Side, string> = { left: "Left half", right: "Right half" };

type Act = (a: JobAction) => void;

/**
 * The first-time setup's steps in the order they come: the left half by key
 * combo, then the right half, which Tandem restarts through the left one.
 */
function SetupChecklist({ hands, combos }: { hands: Record<Side, HandSteps>; combos: Record<Side, Combo | null> }) {
  const browser = api.caps.engine === "browser";
  const keysLabel = (side: Side) => {
    const pressKeys = combos[side] ? "Press 2 keys" : "Press reset twice";
    if (hands[side].keysBy === "you") return pressKeys;
    if (hands[side].keysBy === "tandem") return "Restarted by Tandem";
    // In the browser, the left half's new firmware restarts the right half.
    return browser && side === "right" ? "Restarts by itself" : pressKeys;
  };
  const item = (side: Side, key: "keys" | "allow", label: string) => (
    <li key={`${side}-${key}`} className={`is-${hands[side][key]}`}>
      <MarkIcon mark={hands[side][key]} />
      {label}
    </li>
  );
  return (
    <div className="checklist" aria-label="Your part of the setup">
      {(["left", "right"] as Side[]).map((side) => (
        <div key={side} className="checklist__half">
          <span className="checklist__name">{Half[side]}</span>
          <ol>
            {item(side, "keys", keysLabel(side))}
            {browser && item(side, "allow", "Connect ADV360PRO")}
          </ol>
        </div>
      ))}
    </div>
  );
}

function MarkIcon({ mark }: { mark: Mark }) {
  if (mark === "done") return <Check size={14} aria-label="Done" />;
  if (mark === "now") return <span className="checklist__now" aria-label="Now" />;
  return <Circle size={14} aria-hidden />;
}

/** Chrome's port list, step by step. */
function ChromeSteps({ button, entry, note }: { button: string; entry: ReactNode; note?: string }) {
  return (
    <>
      <li>
        Click <strong>{button}</strong> below.
      </li>
      <li>
        In the list Chrome opens, {entry}, then click Connect.{note && ` ${note}`}
      </li>
    </>
  );
}

/** What to pick for a half's Tandem port, given what Chrome shows next to it. */
function portEntry(side: Side, studioPaired: boolean) {
  if (side === "right") {
    return (
      <>
        pick <strong>Adv360 Pro rt</strong>
      </>
    );
  }
  return studioPaired ? (
    <>
      pick the <strong>Adv360 Pro</strong> that isn't marked Paired
    </>
  ) : (
    <>
      pick either <strong>Adv360 Pro</strong>
    </>
  );
}

/** The left half shows two ports with the same name until one of them is allowed. */
const twoPortsNote = "There are two. If you pick the wrong one, Tandem asks for the other.";

function DriveButton({ side, onAct }: { side: Side; onAct: Act }) {
  return (
    <div className="drive-pick">
      <button type="button" className="btn btn--primary" onClick={() => onAct({ type: "pick-drive", side })}>
        <HardDrive size={15} /> Choose ADV360PRO
      </button>
      <p className="hint">
        In the window that opens, select the drive named ADV360PRO, click Select, then allow Tandem to edit files. You don't pick a file.
        Tandem writes the firmware itself.
      </p>
    </div>
  );
}

/** Connects the update port: one pick in Chrome's list, once per half. The drive is the way around it. */
function UpdatePortButton({ side, onAct, emptyHint }: { side: Side; onAct: Act; emptyHint: boolean }) {
  return (
    <div className="drive-pick">
      <button type="button" className="btn btn--primary" onClick={() => onAct({ type: "grant-update-port", side })}>
        <Usb size={15} /> Connect ADV360PRO
      </button>
      {emptyHint && (
        <p className="hint">
          If Chrome's list is empty, the half isn't in update mode yet. Close the list, press the keys again, and click Connect ADV360PRO.
        </p>
      )}
      <button type="button" className="link hint" onClick={() => onAct({ type: "pick-drive", side })}>
        Chrome won't connect? Copy the firmware to the drive instead
      </button>
    </div>
  );
}

function ComboBoard({ combo, keymap, layout }: { combo: Combo; keymap: Keymap; layout: LayoutKey[] }) {
  return (
    <div className="guide__board">
      <Keyboard
        layout={layout}
        bindings={keymap.layers[0].bindings}
        layerNames={keymap.layers.map((l) => l.name)}
        highlight={[combo.hold, combo.press]}
        labels={{ [combo.hold]: "1", [combo.press]: "2" }}
        compact
      />
    </div>
  );
}

function comboStep(side: Side, combo: Combo | null) {
  return combo ? (
    <>
      Hold <strong>{combo.layerName}</strong> <span className="num">1</span> and tap <span className="num">2</span>, the two keys lit up
      here. If that does nothing, press the {HALF[side]}'s reset button twice, quickly.
    </>
  ) : (
    <>Press the {HALF[side]}'s reset button twice, quickly.</>
  );
}

/** The update port's step when the click that started this already opened Chrome's list. */
function OpenListStep() {
  return (
    <li>
      Chrome's list is already open. Once <strong>ADV360PRO</strong> shows up in it, pick it and click Connect.
    </li>
  );
}

function ManualGuide({
  side,
  reason,
  keymap,
  layout,
  onPickDrive,
  onAllowPort,
  listOpen = false,
  early = false,
}: {
  side: Side;
  reason: "no-autoflash" | "no-response";
  keymap: Keymap;
  layout: LayoutKey[];
  /** In the browser, the user points Tandem at the drive once it appears. */
  onPickDrive?: Act;
  /** In the browser, the user connects the half's update port once it appears. */
  onAllowPort?: Act;
  /** Chrome's list for the update port is open already. */
  listOpen?: boolean;
  /** Shown while GitHub builds, before Tandem asks for anything. */
  early?: boolean;
}) {
  const combo = bootloaderCombo(side, keymap, layout);

  return (
    <div className="guide">
      <div className="guide__head">
        <span className="guide__badge">{Half[side]}</span>
        <h3>Put the {HALF[side]} in update mode{early ? " now" : ""}</h3>
        {early && <p>GitHub is still building your firmware. Do this meanwhile, and Tandem sends it to the {HALF[side]} once it's ready.</p>}
        {reason === "no-response" && <p>It didn't restart into update mode by itself, so do it by hand this once.</p>}
      </div>

      <div className={`guide__body${combo ? "" : " guide__body--single"}`}>
        {combo && <ComboBoard combo={combo} keymap={keymap} layout={layout} />}
        <ol className="guide__steps">
          <li>{comboStep(side, combo)}</li>
          {listOpen ? (
            <OpenListStep />
          ) : onAllowPort ? (
            <ChromeSteps
              button="Connect ADV360PRO"
              entry={
                <>
                  pick <strong>ADV360PRO</strong>
                </>
              }
            />
          ) : onPickDrive ? (
            <li>A drive named ADV360PRO appears. Click Choose ADV360PRO below and select it.</li>
          ) : (
            <li>A drive named ADV360PRO appears, and Tandem copies the firmware to it.</li>
          )}
        </ol>
      </div>
      {listOpen ? null : onAllowPort ? (
        <UpdatePortButton side={side} onAct={onAllowPort} emptyHint />
      ) : onPickDrive ? (
        <DriveButton side={side} onAct={onPickDrive} />
      ) : (
        <p className="guide__wait">
          <Loader2 size={14} className="spin" /> Tandem continues as soon as the half shows up as a drive.
        </p>
      )}
    </div>
  );
}

/** A half running Tandem firmware restarted into update mode, but this browser may not open its update port yet. */
function UpdatePortPrompt({ side, onAct, listOpen = false }: { side: Side; onAct: Act; listOpen?: boolean }) {
  return (
    <div className="guide">
      <div className="guide__head">
        <span className="guide__badge">{Half[side]} · once in this browser</span>
        <h3>Connect the {HALF[side]}'s update port</h3>
        <p>The {HALF[side]} restarted into update mode by itself. Chrome needs your OK once before Tandem can send it firmware.</p>
      </div>
      <ol className="guide__steps">
        {listOpen ? (
          <OpenListStep />
        ) : (
          <ChromeSteps
            button="Connect ADV360PRO"
            entry={
              <>
                pick <strong>ADV360PRO</strong>
              </>
            }
          />
        )}
      </ol>
      {!listOpen && <UpdatePortButton side={side} onAct={onAct} emptyHint={false} />}
    </div>
  );
}

/** The browser can't see the drive until the user points at it. */
function DrivePrompt({ side, onAct }: { side: Side; onAct: Act }) {
  return (
    <div className="guide">
      <div className="guide__head">
        <span className="guide__badge">{Half[side]}</span>
        <h3>Choose the {HALF[side]}'s drive</h3>
        <p>The {HALF[side]} is in update mode and shows up as a drive. Point Tandem at it, and it copies the firmware.</p>
      </div>
      <DriveButton side={side} onAct={onAct} />
    </div>
  );
}

function GrantPortPrompt({
  side,
  before,
  retry,
  studioPaired,
  paired,
  onAct,
}: {
  side: Side;
  before: boolean;
  retry: boolean;
  studioPaired: boolean;
  paired: boolean;
  onAct: Act;
}) {
  const heading = retry
    ? side === "right"
      ? "Pick Adv360 Pro rt"
      : "Pick the other Adv360 Pro"
    : before
      ? `Connect the ${HALF[side]}`
      : `Connect the ${HALF[side]}'s new port`;
  const why = retry
    ? paired
      ? side === "right"
        ? "That entry is the left half, which is connected already."
        : "That entry was connected already."
      : side === "right"
        ? "The right half didn't answer on that entry."
        : "That was the left half's ZMK Studio port, which Tandem doesn't update through."
    : before
      ? `This browser can't see the ${HALF[side]} yet. Connect it once, and Tandem restarts the half by itself, with no keys to press.`
      : `ADV360PRO was the ${HALF[side]} in update mode. Running Tandem firmware, it shows up to Chrome as a different device, and Chrome asks once before Tandem may use it. ${side === "left" ? "Tandem restarts both halves through it" : "After this, Tandem restarts the halves by itself"} for every update.`;
  return (
    <div className="guide">
      <div className="guide__head">
        <span className="guide__badge">{before ? `${Half[side]} · once in this browser` : Half[side]}</span>
        <h3>{heading}</h3>
        <p>{why}</p>
      </div>
      <ol className="guide__steps">
        <ChromeSteps
          button="Connect port"
          entry={portEntry(side, studioPaired || retry)}
          note={side === "right" ? "The entries named Adv360 Pro are the left half." : !studioPaired && !retry ? twoPortsNote : undefined}
        />
      </ol>
      <div className="drive-pick drive-pick--row">
        <button type="button" className="btn btn--primary" onClick={() => onAct({ type: "grant-port", side })}>
          <Usb size={15} /> Connect port
        </button>
        <button type="button" className="btn btn--ghost" onClick={() => onAct({ type: "grant-port", side, skip: true })}>
          {before ? "Use the keys instead" : "Skip, and press keys next update"}
        </button>
      </div>
    </div>
  );
}

function ManualFlashGuide({ files, keymap, layout, onAct }: { files: { left: string; right: string }; keymap: Keymap; layout: LayoutKey[]; onAct: Act }) {
  const right = bootloaderCombo("right", keymap, layout);
  return (
    <div className="guide">
      <div className="guide__head">
        <span className="guide__badge">By hand</span>
        <h3>Copy the firmware onto each half</h3>
        <p>This browser can't reach the keyboard, so copy the two files yourself. In Chrome or Edge, Tandem does this for you.</p>
      </div>
      <div className="manual-files">
        <a className="btn" href={files.right} download="right.uf2">
          <Download size={15} /> right.uf2
        </a>
        <a className="btn" href={files.left} download="left.uf2">
          <Download size={15} /> left.uf2
        </a>
      </div>
      <div className={`guide__body${right ? "" : " guide__body--single"}`}>
        {right && <ComboBoard combo={right} keymap={keymap} layout={layout} />}
        <ol className="guide__steps">
          <li>
            Put the right half in update mode. {comboStep("right", right)} A drive named ADV360PRO appears.
          </li>
          <li>Drag right.uf2 onto ADV360PRO. The half restarts when it's done.</li>
          <li>Do the same with the left half and left.uf2. Press its reset button twice if you don't know its key combo.</li>
        </ol>
      </div>
      <div className="drive-pick">
        <button type="button" className="btn btn--primary" onClick={() => onAct({ type: "manual-flash-done" })}>
          <Check size={15} /> I've copied both
        </button>
      </div>
    </div>
  );
}

/** While nothing is asked of the user during setup: what Tandem is doing, and what not to touch. */
function SetupWait({ view, readySide }: { view: JobView; readySide: Side | null }) {
  const flashing = (["right", "left"] as Side[]).find((s) => view.steps[`flash-${s}`].state === "active");
  if (flashing) {
    const detail = view.steps[`flash-${flashing}`].detail ?? "";
    const text = detail.startsWith("Sending") || detail.startsWith("Copying")
      ? `Sending firmware to the ${HALF[flashing]}. Keep it plugged in.`
      : detail === "Restarting"
        ? `The ${HALF[flashing]} is restarting with Tandem firmware.`
        : detail.startsWith("Waiting for it to connect")
          ? `Waiting for the ${HALF[flashing]} to connect to the left half.`
          : detail.startsWith("Restarting into update mode")
            ? `Tandem is restarting the ${HALF[flashing]} into update mode. No keys needed.`
            : null;
    return text ? (
      <p className="setup-wait">
        <Loader2 size={14} className="spin" /> {text}
      </p>
    ) : null;
  }
  if (readySide && ["save", "build", "download", "prepare"].some((s) => view.steps[s as keyof JobView["steps"]].state === "active")) {
    return (
      <p className="setup-wait">
        <Check size={14} /> The {HALF[readySide]} is in update mode. Tandem sends it the firmware as soon as GitHub finishes building.
      </p>
    );
  }
  if (["save", "build", "download", "prepare"].some((s) => view.steps[s as keyof JobView["steps"]].state === "active")) {
    return (
      <p className="setup-wait">
        <Loader2 size={14} className="spin" /> Nothing to do yet. GitHub is building your firmware, which takes about 3 minutes. Keep both halves
        plugged in.
      </p>
    );
  }
  return null;
}

interface Props {
  view: JobView;
  keymap: Keymap;
  layout: LayoutKey[];
  /** Neither half could restart by itself when this update started. */
  firstTime?: boolean;
  onAct: Act;
  onCancel: () => void;
  onClose: () => void;
  onRetry: () => void;
}

/** A first-time setup: some half needs the user's hands. */
export function isSetup(view: JobView, firstTime = false) {
  return (view.setup || firstTime) && !view.manualFlash;
}

/**
 * Chrome's list for an update port, opened by the click that started the
 * update, and the half the user was asked to put in update mode meanwhile.
 */
export interface EarlyList {
  side: Side;
  state: "open" | "picked" | "closed";
}

/** Progress of an update: what the user needs to do now, then the steps. */
export function UpdateProgress({
  view,
  keymap,
  layout,
  firstTime = false,
  early = null,
  onAct,
}: {
  view: JobView;
  keymap: Keymap;
  layout: LayoutKey[];
  firstTime?: boolean;
  early?: EarlyList | null;
  onAct: Act;
}) {
  const driveWithCombo = view.drive && view.manual?.side === view.drive;
  const portWithCombo = view.updatePort && view.manual?.side === view.updatePort;
  const setup = isSetup(view, firstTime);
  const combos = { left: bootloaderCombo("left", keymap, layout), right: bootloaderCombo("right", keymap, layout) };
  const listOpen = early?.state === "open";
  // Before Tandem flashes anything, the user can do the first half from the open list.
  const beforeFlashing = view.running && (["left", "right"] as Side[]).every((s) => view.steps[`flash-${s}`].state === "pending");
  const earlyGuide = setup && listOpen && beforeFlashing && !view.manual ? early!.side : null;
  const readySide = setup && early?.state === "picked" && beforeFlashing ? early.side : null;
  const hands =
    readySide && view.hands[readySide].keys !== "now"
      ? { ...view.hands, [readySide]: { ...view.hands[readySide], keys: "done", keysBy: "you", allow: "done" } }
      : view.hands;
  return (
    <>
      {setup && !view.done && <SetupChecklist hands={hands} combos={combos} />}
      {earlyGuide && <ManualGuide side={earlyGuide} reason="no-autoflash" keymap={keymap} layout={layout} listOpen early />}

      {view.switched && (
        <div className="notice">
          <Info size={16} />
          <span>
            That was the {HALF[view.switched.to]}, so Tandem is updating it now. The {HALF[view.switched.from]} comes next.
          </span>
        </div>
      )}

      {view.plugIn && (
        <div className="notice">
          <Plug size={16} />
          <span>Connect the {HALF[view.plugIn]} with a USB cable.</span>
        </div>
      )}

      {view.manual && (
        <ManualGuide
          side={view.manual.side}
          reason={view.manual.reason}
          keymap={keymap}
          layout={layout}
          onPickDrive={driveWithCombo ? onAct : undefined}
          onAllowPort={portWithCombo ? onAct : undefined}
          listOpen={listOpen && !!portWithCombo}
        />
      )}
      {view.updatePort && !portWithCombo && <UpdatePortPrompt side={view.updatePort} onAct={onAct} listOpen={listOpen} />}
      {view.drive && !driveWithCombo && <DrivePrompt side={view.drive} onAct={onAct} />}
      {view.grantPort && <GrantPortPrompt {...view.grantPort} onAct={onAct} />}
      {view.manualFlash && <ManualFlashGuide files={view.manualFlash} keymap={keymap} layout={layout} onAct={onAct} />}
      {setup && view.running && !earlyGuide && !view.manual && !view.updatePort && !view.drive && !view.grantPort && (
        <SetupWait view={view} readySide={readySide} />
      )}

      {view.done && (
        <div className="notice notice--ok">
          <Check size={16} />
          <span>
            {setup && view.checked && (
              <>
                <strong>You won't need to do this again.</strong> From now on, plug in both halves and click Update. Tandem does the rest,
                with no keys to press.{" "}
              </>
            )}
            {setup && !view.checked && (
              <>
                <strong>Tandem firmware is on both halves, but this browser can't reach one of them yet.</strong> The next update asks for
                that half's port, or its keys, one more time.{" "}
              </>
            )}
            {view.checked ? (
              <>
                Both halves are running build <code>{view.done}</code>.
              </>
            ) : (
              <>
                Build <code>{view.done}</code> is on both halves. This browser couldn't ask them to confirm it.
              </>
            )}
          </span>
        </div>
      )}

      {view.error && (
        <div className="notice notice--err">
          <X size={16} />
          <span>{view.error}</span>
        </div>
      )}

      <ol className="steps">
        {stepOrder(view, setup && api.caps.engine === "browser").map((id) => {
          const step = view.steps[id];
          return (
            <li key={id} className={`step step--${step.state}`}>
              <span className="step__icon">
                <StepIcon state={step.state} />
              </span>
              <span className="step__title">{STEP_TITLES[id]}</span>
              {step.detail && <span className="step__detail">{step.detail}</span>}
            </li>
          );
        })}
      </ol>

      {view.runUrl && (
        <a className="run-link" href={view.runUrl} target="_blank" rel="noreferrer">
          <GitHubMark size={14} /> See the build on GitHub <ArrowUpRight size={13} />
        </a>
      )}
    </>
  );
}

export function updateHeading(view: JobView, firstTime = false): string {
  const setup = isSetup(view, firstTime);
  if (view.done) return setup ? "Setup is done" : "Your keyboard is updated";
  if (view.error) return setup ? "Setup stopped" : "The update stopped";
  return setup ? "One-time setup" : "Updating your keyboard";
}

export function UpdateSheet({ view, keymap, layout, firstTime, onAct, onCancel, onClose, onRetry }: Props) {
  return (
    <div className="scrim" role="presentation">
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
        <header className="sheet__head">
          <h2 id="sheet-title">{updateHeading(view, firstTime)}</h2>
          {!view.running && (
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
              <X size={18} />
            </button>
          )}
        </header>

        <UpdateProgress view={view} keymap={keymap} layout={layout} firstTime={firstTime} onAct={onAct} />

        <footer className="sheet__foot">
          {view.running ? (
            <button type="button" className="btn" onClick={onCancel}>
              Cancel
            </button>
          ) : view.error ? (
            <>
              <button type="button" className="btn" onClick={onClose}>
                Close
              </button>
              <button type="button" className="btn btn--primary" onClick={onRetry}>
                Try again
              </button>
            </>
          ) : (
            <button type="button" className="btn btn--primary" onClick={onClose}>
              Done
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
