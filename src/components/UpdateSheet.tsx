import { ArrowUpRight, Check, Circle, Download, HardDrive, Loader2, Minus, Plug, Usb, X } from "lucide-react";

import type { JobAction, Keymap, LayoutKey, Side, StepState } from "../../shared/types";
import { bootloaderCombo } from "../lib/guide";
import { type JobView, STEP_ORDER, STEP_TITLES } from "../lib/job";
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

function sideName(side: Side) {
  return side === "left" ? "left" : "right";
}

function DriveButton({ side, onAct }: { side: Side; onAct: (a: JobAction) => void }) {
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

/** The browser can't see the drive until the user points at it. */
function DrivePrompt({ side, onAct }: { side: Side; onAct: (a: JobAction) => void }) {
  return (
    <div className="guide">
      <div className="guide__head">
        <span className="guide__badge">Your turn</span>
        <h3>Choose the {sideName(side)} half's drive</h3>
        <p>The {sideName(side)} half is in update mode and shows up as a drive. Point Tandem at it, and it copies the firmware.</p>
      </div>
      <DriveButton side={side} onAct={onAct} />
    </div>
  );
}

function GrantPortPrompt({ side, onAct }: { side: Side; onAct: (a: JobAction) => void }) {
  return (
    <div className="guide">
      <div className="guide__head">
        <span className="guide__badge">One-time step</span>
        <h3>Allow the {sideName(side)} half's new port</h3>
        <p>
          The {sideName(side)} half now runs Tandem firmware, which adds a port this browser hasn't been allowed to open yet. Allow it so Tandem
          can check the update. Later updates won't ask again.
        </p>
      </div>
      <div className="drive-pick">
        <button type="button" className="btn btn--primary" onClick={() => onAct({ type: "grant-port", side })}>
          <Usb size={15} /> Allow port
        </button>
      </div>
    </div>
  );
}

function ManualFlashGuide({
  files,
  keymap,
  layout,
  onAct,
}: {
  files: { left: string; right: string };
  keymap: Keymap;
  layout: LayoutKey[];
  onAct: (a: JobAction) => void;
}) {
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
        {right && (
          <div className="guide__board">
            <Keyboard
              layout={layout}
              bindings={keymap.layers[0].bindings}
              layerNames={keymap.layers.map((l) => l.name)}
              highlight={[right.hold, right.press]}
              labels={{ [right.hold]: "1", [right.press]: "2" }}
              compact
            />
          </div>
        )}
        <ol className="guide__steps">
          <li>
            Put the right half in update mode.{" "}
            {right ? (
              <>
                Hold the <strong>{right.layerName}</strong> key <span className="num">1</span> and press <span className="num">2</span>, or
                double-click its reset button.
              </>
            ) : (
              "Double-click its reset button."
            )}{" "}
            A drive named ADV360PRO appears.
          </li>
          <li>Drag right.uf2 onto ADV360PRO. The half restarts when it's done.</li>
          <li>Do the same with the left half and left.uf2. Double-click its reset button if you don't know its key combo.</li>
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

function ManualGuide({
  side,
  reason,
  keymap,
  layout,
  onPickDrive,
}: {
  side: Side;
  reason: "no-autoflash" | "no-response";
  keymap: Keymap;
  layout: LayoutKey[];
  /** In the browser, the user points Tandem at the drive once it appears. */
  onPickDrive?: (a: JobAction) => void;
}) {
  const combo = bootloaderCombo(side, keymap, layout);

  return (
    <div className="guide">
      <div className="guide__head">
        <span className="guide__badge">One-time step</span>
        <h3>Put the {sideName(side)} half in update mode</h3>
        <p>
          {reason === "no-autoflash"
            ? "Its current firmware can't restart into update mode by itself yet. After this update it can, and you won't need to do this again."
            : "It didn't restart into update mode by itself. Do it by hand this once."}
        </p>
      </div>

      <div className={`guide__body${combo ? "" : " guide__body--single"}`}>
        {combo && (
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
        )}

        <ol className="guide__steps">
          {combo ? (
            <li>
              Hold the <strong>{combo.layerName}</strong> key <span className="num">1</span>, then press{" "}
              <span className="num">2</span> on the {sideName(side)} half.
            </li>
          ) : null}
          <li>
            {combo ? "Or double-click" : "Double-click"} the reset button on the {sideName(side)} half.
          </li>
        </ol>
      </div>
      {onPickDrive ? (
        <DriveButton side={side} onAct={onPickDrive} />
      ) : (
        <p className="guide__wait">
          <Loader2 size={14} className="spin" /> Tandem continues as soon as the half shows up as a drive.
        </p>
      )}
    </div>
  );
}

interface Props {
  view: JobView;
  keymap: Keymap;
  layout: LayoutKey[];
  onAct: (a: JobAction) => void;
  onCancel: () => void;
  onClose: () => void;
  onRetry: () => void;
}

/** Progress of an update: the steps, and any guide or notice the user needs. */
export function UpdateProgress({ view, keymap, layout, onAct }: { view: JobView; keymap: Keymap; layout: LayoutKey[]; onAct: (a: JobAction) => void }) {
  const driveWithCombo = view.drive && view.manual?.side === view.drive;
  return (
    <>
      <ol className="steps">
        {STEP_ORDER.map((id) => {
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

      {view.plugIn && (
        <div className="notice">
          <Plug size={16} />
          <span>Connect the {sideName(view.plugIn)} half with a USB cable.</span>
        </div>
      )}

      {view.manual && (
        <ManualGuide
          side={view.manual.side}
          reason={view.manual.reason}
          keymap={keymap}
          layout={layout}
          onPickDrive={driveWithCombo ? onAct : undefined}
        />
      )}
      {view.drive && !driveWithCombo && <DrivePrompt side={view.drive} onAct={onAct} />}
      {view.grantPort && <GrantPortPrompt side={view.grantPort} onAct={onAct} />}
      {view.manualFlash && <ManualFlashGuide files={view.manualFlash} keymap={keymap} layout={layout} onAct={onAct} />}

      {view.done && (
        <div className="notice notice--ok">
          <Check size={16} />
          <span>
            {view.checked ? (
              <>
                Both halves are running build <code>{view.done}</code>.
              </>
            ) : (
              <>
                Build <code>{view.done}</code> is on both halves. This browser couldn't ask them to confirm it.
              </>
            )}
            {view.setup && " Automatic updates are set up. Next time, connect both halves and click Update."}
          </span>
        </div>
      )}

      {view.error && (
        <div className="notice notice--err">
          <X size={16} />
          <span>{view.error}</span>
        </div>
      )}
    </>
  );
}

export function updateHeading(view: JobView): string {
  if (view.done) return "Your keyboard is updated";
  if (view.error) return "The update stopped";
  return view.setup ? "Setting up automatic updates" : "Updating your keyboard";
}

export function UpdateSheet({ view, keymap, layout, onAct, onCancel, onClose, onRetry }: Props) {
  return (
    <div className="scrim" role="presentation">
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
        <header className="sheet__head">
          <h2 id="sheet-title">{updateHeading(view)}</h2>
          {!view.running && (
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
              <X size={18} />
            </button>
          )}
        </header>

        <UpdateProgress view={view} keymap={keymap} layout={layout} onAct={onAct} />

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
