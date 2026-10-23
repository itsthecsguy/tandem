// The browser engine's live updates: device status and update progress. A new
// subscriber gets the latest of each right away, the way the helper's event
// stream starts.

import type { DevicesStatus, JobSnapshot } from "../../shared/types";
import type { LiveEvent } from "./types";

type Listener = (e: LiveEvent) => void;

export interface Hub {
  emit(e: LiveEvent): void;
  subscribe(listener: Listener): () => void;
}

export function createHub(currentJob: () => JobSnapshot | null): Hub {
  const listeners = new Set<Listener>();
  let devices: DevicesStatus | null = null;
  return {
    emit(e) {
      if (e.type === "devices") devices = e.devices;
      for (const l of listeners) l(e);
    },
    subscribe(listener) {
      listeners.add(listener);
      listener({ type: "connected", connected: true });
      if (devices) listener({ type: "devices", devices });
      const job = currentJob();
      if (job) listener({ type: "job", job });
      return () => listeners.delete(listener);
    },
  };
}
