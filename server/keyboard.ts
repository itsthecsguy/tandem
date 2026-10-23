// What setup can learn from the connected keyboard, and reading its layout.
// Tandem firmware (protocol 2) reports its exact keymap file. Anything else
// can be read over ZMK Studio once the user unlocks it.

import type { ImportedLayout, KeyboardInfo } from "../shared/types";
import { readTandemKeymap, scanDevices } from "./devices";
import { parseKeymap, toKeymap } from "./keymap";
import { kinesisLayout } from "./newrepo";
import { readStudioLayout, studioStatus } from "./studio";
import { github } from "./workspace";

/** How long to wait for the user to press the Studio unlock key. */
const UNLOCK_WAIT_MS = 120_000;

let pending: { layout: ImportedLayout; keymapText?: string } | null = null;

export async function keyboardInfo(): Promise<KeyboardInfo> {
  const [{ left, right }, { keys }] = await Promise.all([scanDevices(), github().then(kinesisLayout)]);
  const tandemKeymap = left.mode === "app" && left.autoflash && left.protocol >= 2;
  const studio =
    left.mode === "app" && !tandemKeymap && left.otherPorts.length ? await studioStatus(left.otherPorts).catch(() => null) : null;
  return { left, right, tandemKeymap, tandemRepo: left.repo, studio, layout: keys };
}

/** Reads the layout from the left half. For Studio, waits for the user to unlock it. */
export async function readKeyboardLayout(): Promise<ImportedLayout> {
  const { left } = await scanDevices();
  if (left.mode !== "app") throw new Error("Connect the left half with a USB cable first.");
  const { keys } = await kinesisLayout(await github());

  if (left.autoflash && left.protocol >= 2 && left.port) {
    const text = await readTandemKeymap(left.port);
    const layers = toKeymap(parseKeymap(text)).layers.map(({ name, bindings }) => ({ name, bindings }));
    const layout: ImportedLayout = { source: "tandem", layers, unknown: [], layout: keys };
    pending = { layout, keymapText: text };
    return layout;
  }

  if (!left.otherPorts.length) throw new Error("This keyboard's firmware doesn't share its layout.");
  const imported = await readStudioLayout(left.otherPorts, UNLOCK_WAIT_MS);
  const layout: ImportedLayout = { source: "studio", ...imported, layout: keys };
  pending = { layout };
  return layout;
}

/** The layout read most recently, to start a new repo from. */
export function pendingLayout() {
  return pending;
}
