// Reads the layout over ZMK Studio through Web Serial, for keyboards whose
// layout only lives on the device, such as ones set up with Kinesis's Clique
// app. Studio keeps the keymap locked until the user presses &studio_unlock
// (Mod + Esc on Kinesis's default layout), and locks again when the connection
// closes, so one connection stays open from the unlock prompt through the read.

import { type RpcConnection, call_rpc, create_rpc_connection } from "@zmkfirmware/zmk-studio-ts-client";

import macrosDtsi from "../../template/config/macros.dtsi?raw";
import { type ImportedLayout, KINESIS_LABELS, behaviorLabels, convertStudioKeymap } from "../../shared/studio";
import { type PortLike, closePort, exclusive, openPort } from "./serial";
import { sleep, withTimeout } from "./util";

const LOCKED = 0;
const UNLOCKED = 1;

interface Session {
  conn: RpcConnection;
  name: string;
  close: () => Promise<void>;
}

async function connect(port: PortLike): Promise<Session | null> {
  await openPort(port, 115200);
  await port.setSignals?.({ dataTerminalReady: true, requestToSend: true }).catch(() => {});
  const abortController = new AbortController();
  const conn = create_rpc_connection(
    { label: "Web Serial", abortController, readable: port.readable!, writable: port.writable! },
    { signal: abortController.signal },
  );
  // Aborting ends the client's pipes, which unlocks the port's streams so it can close.
  const close = async () => {
    abortController.abort();
    await sleep(50);
    await closePort(port);
  };
  try {
    const res = await withTimeout(call_rpc(conn, { core: { getDeviceInfo: true } }), 1500, "Studio");
    const name = res.core?.getDeviceInfo?.name;
    if (name !== undefined) return { conn, name, close };
  } catch {
    // Not a Studio port, or it didn't answer.
  }
  await close();
  return null;
}

/** Runs `fn` on the first port that answers as ZMK Studio, or returns null. */
async function withStudio<T>(ports: PortLike[], fn: (s: Session) => Promise<T>): Promise<T | null> {
  for (const port of ports) {
    const result = await exclusive(port, async () => {
      const s = await connect(port).catch(() => null);
      if (!s) return { found: false as const };
      try {
        return { found: true as const, value: await fn(s) };
      } finally {
        await s.close();
      }
    });
    if (result.found) return result.value;
  }
  return null;
}

async function lockState(conn: RpcConnection): Promise<number | undefined> {
  return (await withTimeout(call_rpc(conn, { core: { getLockState: true } }), 1500, "Studio lock state")).core?.getLockState;
}

export async function studioStatus(ports: PortLike[]): Promise<{ available: boolean; name: string | null; locked: boolean }> {
  const status = await withStudio(ports, async (s) => ({ available: true, name: s.name, locked: (await lockState(s.conn)) !== UNLOCKED }));
  return status ?? { available: false, name: null, locked: true };
}

/** Reads the keymap, waiting up to `waitMs` for the user to unlock the keyboard. */
export async function readStudioLayout(ports: PortLike[], waitMs: number): Promise<ImportedLayout> {
  const layout = await withStudio(ports, async ({ conn }) => {
    if ((await lockState(conn)) === LOCKED) {
      const deadline = Date.now() + waitMs;
      while ((await lockState(conn)) !== UNLOCKED) {
        if (Date.now() > deadline) throw new Error("The keyboard stayed locked. Press its Studio unlock key and try again.");
        await sleep(1000);
      }
    }
    const keymap = (await withTimeout(call_rpc(conn, { keymap: { getKeymap: true } }), 5000, "Reading the keymap")).keymap?.getKeymap;
    if (!keymap) throw new Error("The keyboard didn't send its keymap.");

    const ids =
      (await withTimeout(call_rpc(conn, { behaviors: { listAllBehaviors: true } }), 3000, "Listing behaviors")).behaviors?.listAllBehaviors
        ?.behaviors ?? [];
    const names = new Map<number, string>();
    for (const id of ids) {
      const details = (await withTimeout(call_rpc(conn, { behaviors: { getBehaviorDetails: { behaviorId: id } } }), 3000, "Behavior details"))
        .behaviors?.getBehaviorDetails;
      if (details) names.set(id, details.displayName);
    }
    // A new repo starts from the template, so its macros are the ones a key can name.
    return convertStudioKeymap(keymap.layers, names, new Map([...KINESIS_LABELS, ...behaviorLabels(macrosDtsi)]));
  });
  if (!layout) throw new Error("The keyboard didn't answer over ZMK Studio.");
  return layout;
}
