import { Check, Loader2, Plug, Usb } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { AppState, DevicesStatus, Session } from "../../shared/types";
import { api, useLive } from "../api";
import { type EarlyList, UpdateProgress, isSetup, updateHeading } from "../components/UpdateSheet";
import { viewJob } from "../lib/job";

export function FirmwareStep({ onSession }: { onSession: (s: Session) => void }) {
  const { devices, job } = useLive();
  const [state, setState] = useState<AppState | null>(null);
  const [started, setStarted] = useState(false);
  /** The update started as the one-time setup: some half couldn't restart by itself. */
  const [firstTime, setFirstTime] = useState(false);
  /** The update started to get Chrome to trust the halves' update ports in this browser. */
  const [trusting, setTrusting] = useState(false);
  /** Chrome's list for the first update port, opened by the click that started the update. */
  const [early, setEarly] = useState<EarlyList | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.state().then(setState, (e) => setError(e.message));
  }, []);

  const view = useMemo(() => (job && (started || job.running || job.interrupted) ? viewJob(job) : null), [job, started]);

  const finish = async () => {
    setBusy(true);
    try {
      onSession(await api.completeOnboarding());
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const start = async () => {
    setError(null);
    setStarted(true);
    const first = !(devices?.left.autoflash && devices?.right.autoflash);
    const trust = !!devices && devices.left.autoflash && devices.right.autoflash && !trustedHere(devices);
    setFirstTime(first);
    setTrusting(trust);
    // Chrome opens its device list only from a click, and adds ADV360PRO to it
    // once a half is in update mode. Opening it now spares the click that
    // would open it later, and in setup lets the user do the left half while
    // GitHub builds. Setup starts with the left half, an update with the right.
    if (api.caps.engine === "browser" && api.caps.flash && (first || trust)) {
      const side = first ? "left" : "right";
      setEarly({ side, state: "open" });
      api.allowUpdatePort().then(
        (picked) => setEarly({ side, state: picked ? "picked" : "closed" }),
        () => setEarly({ side, state: "closed" }),
      );
    }
    try {
      await api.update();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!state || !devices) {
    return (
      <p className="hint ob__status">
        <Loader2 size={13} className="spin" /> Checking your keyboard
      </p>
    );
  }

  const left = devices.left;
  const right = devices.right;
  const both = left.mode !== "missing" && right.mode !== "missing";
  const tandem = left.autoflash && right.autoflash;
  const current = tandem && left.build === state.buildId && right.build === state.buildId;
  const trusted = trustedHere(devices);

  if (view) {
    const setup = isSetup(view, firstTime);
    return (
      <>
        <h1>{trusting ? (view.done ? "This browser is trusted" : view.error ? "That stopped" : "Trust this browser") : updateHeading(view, firstTime)}</h1>
        <p className="lede">
          {trusting
            ? view.done
              ? "Chrome trusts both halves' update ports here now, so updates from this browser need no clicks."
              : "Connect ADV360PRO when Tandem asks, once for each half. No keys needed."
            : view.done
              ? setup
                ? "Both halves run Tandem firmware now."
                : "Both halves run your latest firmware."
              : setup
                ? "You only do this once. When it's your turn, Tandem shows what to do right here, one step at a time."
                : "Tandem builds your firmware on GitHub and updates both halves. No key presses needed."}
        </p>
        <div className="ob__progress">
          <UpdateProgress
            view={view}
            keymap={state.keymap}
            layout={state.layout}
            firstTime={firstTime}
            early={early}
            onAct={(a) => api.act(a).catch((e: Error) => setError(e.message))}
          />
        </div>
        {error && <p className="callout callout--err">{error}</p>}
        <div className="ob__actions">
          {view.running ? (
            <button type="button" className="btn" onClick={() => api.cancel()}>
              Cancel
            </button>
          ) : view.error ? (
            <>
              <button type="button" className="btn btn--ghost" onClick={finish} disabled={busy}>
                Skip for now
              </button>
              <button type="button" className="btn btn--primary btn--lg" onClick={start}>
                Try again
              </button>
            </>
          ) : (
            <>
              <span />
              <button type="button" className="btn btn--primary btn--lg" onClick={finish} disabled={busy}>
                Open the editor
              </button>
            </>
          )}
        </div>
      </>
    );
  }

  // The keyboard has Tandem firmware, but this browser hasn't sent it
  // firmware. Chrome asks once per half before a page may use that half's
  // update port, and the port only exists in update mode. Doing it now
  // keeps the asks out of the first update from the editor.
  if (tandem && !trusted) {
    return (
      <>
        <h1>Trust this browser</h1>
        <p className="lede">
          Your keyboard already runs Tandem firmware, but this browser hasn't updated it yet. Chrome asks once per half before a site may
          use the half's update port, and that port only shows up while the half is in update mode.
        </p>
        <ol className="ob__plan">
          <li>
            <span>
              <strong>Tandem restarts each half into update mode.</strong> No keys needed.
            </span>
          </li>
          <li>
            <span>
              <strong>You connect ADV360PRO in Chrome, once for each half.</strong> The first list opens with your click.
            </span>
          </li>
          <li>
            <span>
              <strong>Tandem sends each half {current ? "the build it already runs" : `your latest build, ${state.buildId}`}.</strong> About a
              minute in all.
            </span>
          </li>
        </ol>
        <p className="hint">Incognito windows forget this when they close, so each new one asks again.</p>
        {error && <p className="callout callout--err">{error}</p>}
        <div className="ob__actions">
          <button type="button" className="btn btn--ghost" onClick={finish} disabled={busy}>
            Do this later
          </button>
          <button type="button" className="btn btn--primary btn--lg" onClick={start}>
            Trust this browser
          </button>
        </div>
      </>
    );
  }

  if (current) {
    return (
      <>
        <h1>Your keyboard is ready</h1>
        <p className="lede">Both halves run Tandem firmware built from your repo's latest commit. From now on, updates need no key presses.</p>
        <p className="callout callout--ok">
          <Check size={15} /> Both halves are on build <code>{state.buildId}</code>.
        </p>
        <div className="ob__actions">
          <span />
          <button type="button" className="btn btn--primary btn--lg" onClick={finish} disabled={busy}>
            Open the editor
          </button>
        </div>
      </>
    );
  }

  if (tandem) {
    return (
      <>
        <h1>Update your keyboard</h1>
        <p className="lede">
          Your keyboard already runs Tandem firmware, so the one-time setup isn't needed. Its build ({left.build}) is older than your repo's
          latest ({state.buildId}). Updating takes a few minutes and needs no key presses.
        </p>
        {error && <p className="callout callout--err">{error}</p>}
        <div className="ob__actions">
          <button type="button" className="btn btn--ghost" onClick={finish} disabled={busy}>
            Later
          </button>
          <button type="button" className="btn btn--primary btn--lg" onClick={start}>
            Update now
          </button>
        </div>
      </>
    );
  }

  if (!api.caps.flash) {
    return (
      <>
        <h1>Install Tandem firmware</h1>
        <p className="lede">
          This browser can't reach the keyboard, so an update here ends with you copying two files. In Chrome or Edge, Tandem copies them for
          you.
        </p>
        <ol className="ob__plan">
          <li>
            <strong>GitHub builds your firmware.</strong> About 3 minutes, from your repo's latest commit.
          </li>
          <li>
            <strong>You copy it onto each half.</strong> Tandem gives you both files and shows how to put each half in update mode.
          </li>
        </ol>
        {error && <p className="callout callout--err">{error}</p>}
        <div className="ob__actions">
          <button type="button" className="btn btn--ghost" onClick={finish} disabled={busy}>
            Do this later
          </button>
          <button type="button" className="btn btn--primary btn--lg" onClick={start}>
            Start
          </button>
        </div>
      </>
    );
  }

  const browser = api.caps.engine === "browser";
  return (
    <>
      <h1>One-time setup</h1>
      <p className="lede">
        Tandem puts its own firmware on both halves. You do this once, and it takes about 5 minutes. After it, every update is one click,
        with no keys to press{browser ? " and nothing to pick in Chrome" : ""}.
      </p>

      <h2 className="ob__subhead">What you'll do</h2>
      {browser ? (
        <>
          <p className="ob__para">
            Start setup opens Chrome's list right away, so you can do the left half while GitHub builds your firmware, which takes about 3
            minutes.
          </p>
          <ol className="ob__plan">
            <li>
              <span>
                <strong>Left half: press two keys, then pick ADV360PRO in Chrome's list and click Connect.</strong> Tandem lights the keys up
                on a picture of your layout. ADV360PRO shows up in the list once the half is in update mode.
              </span>
            </li>
            <li>
              <span>
                <strong>Right half: connect ADV360PRO in Chrome when Tandem asks.</strong> No keys this time. The left half's new firmware
                restarts the right half for you.
              </span>
            </li>
          </ol>
        </>
      ) : (
        <>
          <p className="ob__para">First GitHub builds your firmware, which takes about 3 minutes. Then, right half first, for each half:</p>
          <ol className="ob__plan">
            <li>
              <span>
                <strong>Press two keys on the keyboard.</strong> Tandem lights them up on a picture of your layout.
              </span>
            </li>
            <li>
              <span>
                <strong>Wait while Tandem copies the firmware.</strong> It checks that the half comes back running it.
              </span>
            </li>
          </ol>
        </>
      )}

      <ul className="ob__notes">
        <li>Keep both halves plugged in with USB cables until setup is done.</li>
        <li>
          While a half is in update mode, a drive named ADV360PRO shows up on your computer. Leave it alone.{" "}
          {browser ? "Tandem sends the firmware over USB itself." : "Tandem copies the firmware to it."} On a Mac, a warning that the drive
          wasn't ejected properly is normal.
        </li>
        {left.mode === "app" && (
          <li>If a key combo lands on the wrong half, that's fine. Tandem updates that half first and asks for the other one after.</li>
        )}
      </ul>

      {browser && api.caps.keyboard && left.mode === "missing" && (
        <div className="callout connect-ports">
          <span>
            <strong>Tandem can't see the left half yet.</strong> Connect it before you start, so Tandem can tell the halves apart while you
            press keys. In Chrome's list, pick <strong>Adv360 Pro</strong> and click Connect.
          </span>
          <button type="button" className="btn" onClick={() => api.connectKeyboard().catch((e: Error) => setError(e.message))}>
            <Usb size={15} /> Connect keyboard
          </button>
        </div>
      )}

      {!both && api.caps.engine === "helper" && (
        <p className="callout">
          <Plug size={15} /> Connect both halves with USB cables. Tandem will wait for them.
        </p>
      )}
      {error && <p className="callout callout--err">{error}</p>}
      <div className="ob__actions">
        <button type="button" className="btn btn--ghost" onClick={finish} disabled={busy}>
          Do this later
        </button>
        <button type="button" className="btn btn--primary btn--lg" onClick={start}>
          Start setup
        </button>
      </div>
    </>
  );
}

/** Chrome trusts both halves' update ports in this browser, as far as Tandem knows. The helper needs none of this. */
function trustedHere(devices: DevicesStatus): boolean {
  if (api.caps.engine !== "browser") return true;
  const ports = devices.updatePorts ?? [];
  return ports.includes("left") && ports.includes("right");
}
