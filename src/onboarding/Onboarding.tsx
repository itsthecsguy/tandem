import { Check } from "lucide-react";
import { useEffect, useState } from "react";

import type { KeyboardInfo, Session } from "../../shared/types";
import { api } from "../api";
import { ThemeMenu } from "../components/ThemeMenu";
import { FirmwareStep } from "./FirmwareStep";
import { KeyboardStep } from "./KeyboardStep";
import { LayoutStep } from "./LayoutStep";
import { SignInStep } from "./SignInStep";

type StepId = "github" | "keyboard" | "layout" | "firmware";

/** Onboarding shows until the repo is set up and the first flash is done or skipped. */
export function needsOnboarding(s: Session): boolean {
  return !s.signedIn || s.missingScopes.length > 0 || !s.repo || !(s.setup?.installed || s.setup?.outdated) || !s.onboarded;
}

const KEYBOARD_SEEN = "tandem-onboarding-keyboard";

function seenKeyboard(): boolean {
  try {
    return sessionStorage.getItem(KEYBOARD_SEEN) === "1";
  } catch {
    return false;
  }
}

export function Onboarding({ session, onSession }: { session: Session; onSession: (s: Session) => void }) {
  const [keyboardDone, setKeyboardDone] = useState(seenKeyboard);
  const [keyboard, setKeyboard] = useState<KeyboardInfo | null>(null);

  // After a reload the keyboard step stays done, so look at the keyboard again.
  const signedInNow = session.signedIn && session.missingScopes.length === 0;
  useEffect(() => {
    if (keyboardDone && !keyboard && signedInNow) api.keyboard().then(setKeyboard, () => {});
  }, [keyboardDone, keyboard, signedInNow]);

  const signedIn = session.signedIn && session.missingScopes.length === 0;
  const repoReady = !!session.repo && !!session.setup?.installed;
  const current: StepId = !signedIn ? "github" : !keyboardDone ? "keyboard" : !repoReady ? "layout" : "firmware";

  const steps: { id: StepId; title: string; detail: string; done: boolean }[] = [
    { id: "github", title: "GitHub", detail: signedIn ? `@${session.login}` : "Sign in", done: signedIn },
    {
      id: "keyboard",
      title: "Keyboard",
      detail: keyboardDone ? (keyboard?.left.autoflash ? "Tandem firmware found" : keyboard ? "Connected" : "Skipped") : "Connect both halves",
      done: keyboardDone,
    },
    {
      id: "layout",
      title: "Layout",
      detail: session.repo ? `${session.repo.owner}/${session.repo.name}` : "Choose where it lives",
      done: repoReady,
    },
    { id: "firmware", title: "Firmware", detail: "Install Tandem once", done: false },
  ];
  const index = steps.findIndex((s) => s.id === current);

  return (
    <div className="ob">
      <aside className="ob__side">
        <div className="ob__brand">
          <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden>
            <rect x="2.5" y="8" width="12" height="16" rx="3.5" fill="currentColor" />
            <rect x="17.5" y="8" width="12" height="16" rx="3.5" fill="currentColor" opacity="0.45" />
          </svg>
          Tandem
        </div>

        <ol className="ob__steps">
          {steps.map((s, i) => {
            const state = s.done && s.id !== current ? "done" : s.id === current ? "on" : "todo";
            const revisit = s.id === "keyboard" && s.done && current !== "keyboard";
            const body = (
              <>
                <span className="ob__step-num">{state === "done" ? <Check size={13} /> : i + 1}</span>
                <span className="ob__step-text">
                  <strong>{s.title}</strong>
                  <span>{s.detail}</span>
                </span>
              </>
            );
            return (
              <li key={s.id} className={`ob__step is-${state}`} aria-current={s.id === current ? "step" : undefined}>
                {revisit ? (
                  <button type="button" onClick={() => setKeyboardDone(false)} title="Check the keyboard again">
                    {body}
                  </button>
                ) : (
                  <div>{body}</div>
                )}
              </li>
            );
          })}
        </ol>

        <div className="ob__side-foot">
          <p>
            {api.caps.engine === "browser"
              ? "Your layout lives in your GitHub repo, GitHub builds the firmware, and this browser puts it on the keyboard."
              : "No Tandem servers. Your layout lives in your GitHub repo, and only flashing runs on this Mac."}
          </p>
          <ThemeMenu />
        </div>
      </aside>

      <main className="ob__main">
        <div className="ob__content" key={current}>
          <span className="ob__eyebrow">
            Step {index + 1} of {steps.length}
          </span>
          {current === "github" && <SignInStep session={session} onSession={onSession} />}
          {current === "keyboard" && (
            <KeyboardStep
              onContinue={(info) => {
                setKeyboard(info);
                setKeyboardDone(true);
                try {
                  sessionStorage.setItem(KEYBOARD_SEEN, "1");
                } catch {
                  // Only matters if the page reloads mid-setup.
                }
              }}
            />
          )}
          {current === "layout" && <LayoutStep session={session} keyboard={keyboard} onSession={onSession} />}
          {current === "firmware" && <FirmwareStep onSession={onSession} />}
        </div>
      </main>
    </div>
  );
}
