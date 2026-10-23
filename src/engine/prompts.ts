// Things an update waits for the user to do, such as choosing a half's drive.
// The UI answers from a click handler, because the browser only opens its
// drive and port pickers inside a click.

import type { JobAction } from "../../shared/types";

const pending = new Map<string, (value: unknown) => void>();

const keyOf = (action: JobAction) => ("side" in action ? `${action.type}:${action.side}` : action.type);

/** Waits for `answer(action)`. Rejects if `signal` aborts first. */
export function waitFor<T>(action: JobAction, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const key = keyOf(action);
    pending.set(key, resolve as (value: unknown) => void);
    signal.addEventListener(
      "abort",
      () => {
        pending.delete(key);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

export function isWaiting(action: JobAction): boolean {
  return pending.has(keyOf(action));
}

/** Resolves the update's wait for `action`. Returns false if nothing was waiting. */
export function answer(action: JobAction, value?: unknown): boolean {
  const key = keyOf(action);
  const resolve = pending.get(key);
  if (!resolve) return false;
  pending.delete(key);
  resolve(value);
  return true;
}
