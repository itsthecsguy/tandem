import { useEffect, useState } from "react";

import type { DevicesStatus, JobSnapshot } from "../shared/types";
import { browserEngine } from "./engine/browser";
import { helperEngine } from "./engine/helper";
import type { Engine } from "./engine/types";

/** Set by initApi() before the app renders. */
export let api: Engine;

/**
 * Uses the local helper when it serves this page, and the browser engine
 * everywhere else, including tandemkb.com. `?engine=helper` or
 * `?engine=browser` picks one by hand.
 */
export async function initApi(): Promise<void> {
  const forced = new URLSearchParams(location.search).get("engine");
  const helper = forced ? forced === "helper" : await helperServesThisPage();
  api = helper ? helperEngine() : browserEngine();
}

async function helperServesThisPage(): Promise<boolean> {
  try {
    const res = await fetch("/api/engine", { signal: AbortSignal.timeout(1500) });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return false;
    return (await res.json()).engine === "helper";
  } catch {
    return false;
  }
}

/** Live device status and update progress. */
export function useLive() {
  const [devices, setDevices] = useState<DevicesStatus | null>(null);
  const [job, setJob] = useState<JobSnapshot | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(
    () =>
      api.subscribe((e) => {
        switch (e.type) {
          case "connected":
            setConnected(e.connected);
            break;
          case "devices":
            setDevices(e.devices);
            break;
          case "job":
            setJob(e.job);
            break;
          case "job-event":
            setJob((prev) =>
              prev
                ? {
                    ...prev,
                    events: [...prev.events, e.event],
                    running: e.event.type === "done" || e.event.type === "error" ? false : prev.running,
                  }
                : prev,
            );
            break;
        }
      }),
    [],
  );

  return { devices, job, connected };
}
