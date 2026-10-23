// For browsers that can't reach the keyboard, such as Safari and Firefox:
// Tandem hands over both firmware files, the user copies each one onto its
// half's drive, and says when they're done. Nothing can check the halves.

import type { Build } from "./builds";
import type { Flash } from "./jobs";
import { waitFor } from "./prompts";

const fileUrl = (data: Uint8Array) => URL.createObjectURL(new Blob([data as BlobPart], { type: "application/octet-stream" }));

export const manualFlash: Flash = async (build: Build, emit, signal) => {
  emit({ type: "step", step: "prepare", state: "skipped", detail: "This browser can't reach the keyboard" });
  const left = fileUrl(build.left);
  const right = fileUrl(build.right);
  try {
    emit({ type: "step", step: "flash-right", state: "active", detail: "Copy right.uf2 by hand" });
    emit({ type: "step", step: "flash-left", state: "active", detail: "Copy left.uf2 by hand" });
    emit({ type: "manual-flash", left, right });
    await waitFor({ type: "manual-flash-done" }, signal);
    emit({ type: "manual-flash-done" });
    emit({ type: "step", step: "flash-right", state: "done", detail: "Copied by hand" });
    emit({ type: "step", step: "flash-left", state: "done", detail: "Copied by hand" });
    emit({ type: "step", step: "verify", state: "skipped", detail: "This browser can't ask the halves" });
    return false;
  } finally {
    // Long enough for a download the user started at the last moment.
    setTimeout(() => {
      URL.revokeObjectURL(left);
      URL.revokeObjectURL(right);
    }, 60_000);
  }
};
