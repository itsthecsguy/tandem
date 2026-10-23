import { Check, Loader2, Plug } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { HalfStatus, KeyboardInfo, LayoutKey } from "../../shared/types";
import { api, useLive } from "../api";
import { Keyboard, PLAIN_KEYS } from "../components/Keyboard";
import { sideOf } from "../lib/guide";

function describe(half: HalfStatus | undefined): { state: "missing" | "tandem" | "other" | "bootloader"; text: string } {
  if (!half || half.mode === "missing") return { state: "missing", text: "Not connected" };
  if (half.mode === "bootloader") return { state: "bootloader", text: "In update mode" };
  if (half.autoflash) return { state: "tandem", text: `Tandem firmware${half.build ? ` · ${half.build}` : ""}` };
  return { state: "other", text: "Standard firmware" };
}

function HalfCard({ side, half, layout }: { side: "left" | "right"; half?: HalfStatus; layout: LayoutKey[] }) {
  const keys = useMemo(() => layout.filter((k) => sideOf(k) === side), [layout, side]);
  const { state, text } = describe(half);
  return (
    <div className={`half-card half-card--${state}`}>
      <div className="half-card__art">
        {keys.length > 0 && <Keyboard layout={keys} bindings={PLAIN_KEYS} layerNames={[]} compact />}
      </div>
      <div className="half-card__text">
        <strong>{side === "left" ? "Left half" : "Right half"}</strong>
        <span>
          {state === "missing" ? <Plug size={13} /> : <Check size={13} />} {text}
        </span>
      </div>
    </div>
  );
}

export function KeyboardStep({ onContinue }: { onContinue: (info: KeyboardInfo | null) => void }) {
  const { devices } = useLive();
  const [info, setInfo] = useState<KeyboardInfo | null>(null);
  const [checking, setChecking] = useState(true);

  // Look again whenever a half connects, disconnects or changes firmware.
  const shape = devices
    ? [devices.left, devices.right].map((h) => `${h.mode}:${h.autoflash}:${h.build}`).join("|")
    : "";
  useEffect(() => {
    if (!devices) return;
    let cancelled = false;
    setChecking(true);
    api
      .keyboard()
      .then((k) => !cancelled && setInfo(k))
      .finally(() => !cancelled && setChecking(false));
    return () => {
      cancelled = true;
    };
    // `shape` stands in for `devices`, which changes on every scan.
  }, [shape]);

  const left = info?.left ?? devices?.left;
  const right = info?.right ?? devices?.right;
  const both = left?.mode === "app" && right?.mode === "app";
  const tandem = !!(left?.autoflash && right?.autoflash);

  return (
    <>
      <h1>Connect your keyboard</h1>
      <p className="lede">
        Plug both halves into this Mac with USB cables. Tandem checks which firmware they run and can read the layout that's on them now.
      </p>

      <div className="half-cards">
        <HalfCard side="left" half={left} layout={info?.layout ?? []} />
        <HalfCard side="right" half={right} layout={info?.layout ?? []} />
      </div>

      {checking && !info ? (
        <p className="hint ob__status">
          <Loader2 size={13} className="spin" /> Looking for your keyboard
        </p>
      ) : both && tandem ? (
        <p className="callout callout--ok">
          <strong>Tandem firmware is already installed.</strong> You can skip the one-time setup flash.
          {info?.tandemRepo && ` This firmware was built from ${info.tandemRepo}.`}
        </p>
      ) : both ? (
        <p className="callout">
          <strong>This keyboard runs standard ZMK firmware.</strong>{" "}
          {info?.studio?.available ? "It has ZMK Studio, so Tandem can read your current layout from it. " : ""}
          Setup installs Tandem firmware once, with a key combo on each half. After that, updates need no key presses.
        </p>
      ) : (
        <p className="hint ob__status">Waiting for {left?.mode === "app" ? "the right half" : right?.mode === "app" ? "the left half" : "both halves"}.</p>
      )}

      <div className="ob__actions">
        <button type="button" className="btn btn--ghost" onClick={() => onContinue(info)}>
          Set up without the keyboard
        </button>
        <button type="button" className="btn btn--primary btn--lg" disabled={!both} onClick={() => onContinue(info)}>
          Continue
        </button>
      </div>
    </>
  );
}
