import type { DevicesStatus, HalfStatus } from "../../shared/types";

export type HalfState = "missing" | "bootloader" | "current" | "ready" | "setup";

export function halfState(half: HalfStatus, buildId: string, dirty: boolean): HalfState {
  if (half.mode === "missing") return "missing";
  if (half.mode === "bootloader") return "bootloader";
  if (!half.autoflash) return "setup";
  return half.build === buildId && !dirty ? "current" : "ready";
}

const TEXT: Record<HalfState, string> = {
  missing: "Not connected",
  bootloader: "Update mode",
  current: "Up to date",
  ready: "Ready to update",
  setup: "Needs setup",
};

function detail(half: HalfStatus, state: HalfState): string {
  const side = half.side === "left" ? "Left" : "Right";
  const extra = [
    half.build && `build ${half.build}`,
    state === "setup" && "older firmware, the next update needs a key combo",
  ]
    .filter(Boolean)
    .join(", ");
  return `${side}: ${TEXT[state]}${extra ? ` (${extra})` : ""}`;
}

/** One summary for both halves: the most urgent state wins. */
function summary(left: HalfState, right: HalfState): { state: HalfState; text: string } {
  for (const state of ["setup", "bootloader", "missing", "ready"] as HalfState[]) {
    if (left !== state && right !== state) continue;
    if (state === "missing" && left !== right) {
      return { state, text: `${left === "missing" ? "Left" : "Right"} not connected` };
    }
    return { state, text: TEXT[state] };
  }
  return { state: "current", text: TEXT.current };
}

export function KeyboardStatus({ devices, left, right }: { devices: DevicesStatus; left: HalfState; right: HalfState }) {
  const s = summary(left, right);
  return (
    <div className={`kb-status kb-status--${s.state}`} title={`${detail(devices.left, left)}\n${detail(devices.right, right)}`}>
      <span className="kb-status__dots">
        <span className={`kb-status__dot is-${left}`} aria-hidden />
        <span className={`kb-status__dot is-${right}`} aria-hidden />
      </span>
      <span className="kb-status__text">{s.text}</span>
    </div>
  );
}
