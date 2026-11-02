import { ArrowUpRight, Info, Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";

import pins from "../../shared/pins.json";
import type { DevicesStatus, Session, UpdateHistory } from "../../shared/types";
import { api } from "../api";

const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

const shown = (date: string) => (date ? when.format(new Date(date)) : "");

// The ZMK 4.1 trial is for testing on a keyboard, until the port's author has
// said it's fine and it's run on real hardware. Add ?beta to the URL to see it.
const betaOffered = typeof location !== "undefined" && new URLSearchParams(location.search).has("beta");

function keyboardRelease(devices: DevicesStatus | null): string {
  const halves = devices ? [devices.left, devices.right] : [];
  if (!halves.some((h) => h.mode === "app")) return "Not connected";
  if (halves.some((h) => h.mode === "app" && !h.autoflash)) return "Not running Tandem on both halves";
  const versions = new Set(halves.filter((h) => h.mode === "app").map((h) => h.version));
  if (versions.size > 1) return "Different releases on each half";
  const [version] = versions;
  return version === null || version === undefined ? "A release from before they had numbers" : `Tandem ${version}`;
}

interface Props {
  session: Session;
  devices: DevicesStatus | null;
  /** An update is running, so nothing here can start. */
  running: boolean;
  /** Unsaved layout edits, which anything that moves the branch would drop. */
  dirty: boolean;
  onClose: () => void;
  onSession: (s: Session) => void;
  /** The branch moved, so the layout needs reading again. */
  onChanged: () => Promise<void>;
  /** A job started, which brings up its own sheet. */
  onStarted: () => void;
}

/** What's on the repo and the keyboard, and every way back from it. */
export function HistorySheet({ session, devices, running, dirty, onClose, onSession, onChanged, onStarted }: Props) {
  const [history, setHistory] = useState<UpdateHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    api.history().then(setHistory, (e: Error) => setError(e.message));
  }, []);

  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const disabled = busy || running;
  const movesBranch = disabled || dirty;
  const runningBuild = devices?.left.build;

  return (
    <div className="scrim" role="presentation">
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="history-title">
        <header className="sheet__head">
          <h2 id="history-title">Versions and undo</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>

        <dl className="versions">
          <dt>Your repo</dt>
          <dd>{session.setup?.version ? `Tandem ${session.setup.version}` : "A release from before they had numbers"}</dd>
          <dt>Your keyboard</dt>
          <dd>{keyboardRelease(devices)}</dd>
          <dt>This site</dt>
          <dd>
            {session.setup?.latest ? `Tandem ${session.setup.latest}` : "Unknown"}.{" "}
            <a href="/changelog" target="_blank" rel="noreferrer">
              What's in each release <ArrowUpRight size={13} />
            </a>
          </dd>
        </dl>

        {dirty && (
          <div className="notice">
            <Info size={16} />
            <span>You have unsaved changes. Save or discard them to undo an update or switch branches.</span>
          </div>
        )}

        {error && (
          <div className="notice notice--err" role="alert">
            <X size={16} />
            <span>{error}</span>
          </div>
        )}

        {!history && !error && (
          <p className="setup-wait">
            <Loader2 size={14} className="spin" /> Reading your repo's history…
          </p>
        )}

        {history && (
          <>
            <section className="history-section">
              <span className="section-label">Builds kept here</span>
              <p className="hint">
                Put an earlier build back on the keyboard. Your repo stays as it is, so the next keyboard update goes back to your latest commit.
              </p>
              {history.builds.length ? (
                <ul className="history-list">
                  {history.builds.map((b) => (
                    <li key={b.key}>
                      <span>
                        <code>{b.id}</code> <small>{[shown(b.createdAt), b.studio ? "Clique" : "Plain", b.stock && "Kinesis's firmware"].filter(Boolean).join(" · ")}</small>
                      </span>
                      {b.id === runningBuild ? (
                        <small>On the keyboard</small>
                      ) : (
                        <button
                          type="button"
                          className="btn btn--sm"
                          disabled={disabled}
                          onClick={() =>
                            act(async () => {
                              await api.flashBuild(b.key);
                              onStarted();
                            })
                          }
                        >
                          Put back
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="hint">None yet. Each update keeps its build here.</p>
              )}
            </section>

            <section className="history-section">
              <span className="section-label">Updates Tandem committed</span>
              <p className="hint">Undo one if it causes trouble. Tandem commits the undo to your repo, and later updates leave that release out.</p>
              {history.updates.length ? (
                <ul className="history-list">
                  {history.updates.map((u) => (
                    <li key={u.sha}>
                      <span>
                        {u.title} <small>{shown(u.date)}</small>
                      </span>
                      <button
                        type="button"
                        className="btn btn--sm"
                        disabled={movesBranch}
                        onClick={() =>
                          act(async () => {
                            onSession(await api.undoUpdate(u.sha));
                            await onChanged();
                            setHistory(await api.history());
                          })
                        }
                      >
                        Undo
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="hint">None in your branch's latest 30 commits.</p>
              )}
            </section>

            {(betaOffered || session.beta) && (
              <section className="history-section">
                <span className="section-label">Try {pins.beta.name}</span>
                {session.beta ? (
                  <>
                    <p className="hint">
                      You're on the <code>{session.repo?.branch}</code> branch. Going back switches to <code>{session.beta.from}</code>, and the next keyboard
                      update puts its firmware back. This branch stays on GitHub.
                    </p>
                    <button
                      type="button"
                      className="btn"
                      disabled={movesBranch}
                      onClick={() =>
                        act(async () => {
                          onSession(await api.leaveBeta());
                          await onChanged();
                          setHistory(await api.history());
                        })
                      }
                    >
                      Go back to {session.beta.from}
                    </button>
                  </>
                ) : (
                  <>
                    <p className="hint">
                      A community port of Kinesis's firmware to ZMK's newer Bluetooth stack, for testing. Tandem makes a new branch for it and leaves{" "}
                      <code>{session.repo?.branch}</code> alone, so going back is one click. Layout changes you make on it stay on it. Bluetooth pairings may not
                      carry over.{" "}
                      <a href="https://github.com/KinesisCorporation/Adv360-Pro-ZMK/issues/860" target="_blank" rel="noreferrer">
                        About the port <ArrowUpRight size={13} />
                      </a>
                    </p>
                    <button
                      type="button"
                      className="btn"
                      disabled={movesBranch}
                      onClick={() =>
                        act(async () => {
                          const { session: next, kept } = await api.startBeta();
                          onSession(next);
                          await onChanged();
                          setHistory(await api.history());
                          setNote(
                            `Switched to the trial branch. Click Update keyboard to build and install it.${kept.length ? ` ${kept.join(", ")} stayed as you had it, and ${pins.beta.name} may not read it.` : ""}`,
                          );
                        })
                      }
                    >
                      Try it on a new branch
                    </button>
                  </>
                )}
                {note && <p className="hint">{note}</p>}
              </section>
            )}

            <section className="history-section">
              <span className="section-label">Leave Tandem</span>
              <p className="hint">
                Tandem takes itself out of your repo, GitHub builds Kinesis's firmware with your layout, and Tandem puts it on both halves. Updates after
                that use Kinesis's steps, with key presses.
              </p>
              {confirming ? (
                <div className="drive-pick--row">
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={disabled}
                    onClick={() =>
                      act(async () => {
                        await api.leaveTandem();
                        onStarted();
                      })
                    }
                  >
                    Remove Tandem and go back
                  </button>
                  <button type="button" className="btn btn--ghost" onClick={() => setConfirming(false)}>
                    Keep Tandem
                  </button>
                </div>
              ) : (
                <button type="button" className="btn" disabled={movesBranch} onClick={() => setConfirming(true)}>
                  Go back to Kinesis's firmware
                </button>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
