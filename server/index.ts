import { existsSync } from "node:fs";

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import type { AppState, BuildSettings, DevicesStatus, Keymap, RepoRef } from "../shared/types";
import { scanDevices } from "./devices";
import { type DeviceCode, finishDeviceFlow, startDeviceFlow } from "./github";
import { cancelJob, currentJob, onJobStart, startUpdate } from "./jobs";
import { keyboardInfo, pendingLayout, readKeyboardLayout } from "./keyboard";
import {
  APP_DIR,
  connectRepo,
  createNewRepo,
  currentBuildId,
  disconnectRepo,
  installTandem,
  listBranches,
  listRepos,
  loadState,
  openWorkspace,
  readKeymap,
  saveKeymap,
  saveState,
  session,
  signOut,
  useGhLogin,
} from "./workspace";

const PORT = Number(process.env.PORT ?? 4317);
const app = new Hono();

app.onError((err, c) => c.json({ error: err.message }, 500));

// The UI asks this to learn that a helper serves it, not tandemkb.com.
app.get("/api/engine", (c) => c.json({ engine: "helper" }));

// Sign-in

app.get("/api/session", async (c) => c.json(await session()));

app.post("/api/auth/gh", async (c) => {
  await useGhLogin();
  return c.json(await session());
});

let device: { code: DeviceCode; status: "pending" | "done" | "error"; error?: string; abort: AbortController } | null = null;

app.post("/api/auth/device", async (c) => {
  device?.abort.abort();
  const code = await startDeviceFlow();
  const abort = new AbortController();
  const flow = { code, status: "pending" as const, abort } as NonNullable<typeof device>;
  device = flow;
  finishDeviceFlow(code, abort.signal).then(
    () => (flow.status = "done"),
    (err) => {
      flow.status = "error";
      flow.error = err.message;
    },
  );
  return c.json({ userCode: code.user_code, url: code.verification_uri });
});

app.get("/api/auth/device", (c) =>
  c.json(device ? { status: device.status, error: device.error, userCode: device.code.user_code, url: device.code.verification_uri } : null),
);

app.post("/api/auth/signout", async (c) => {
  await signOut();
  return c.json(await session());
});

// Repo

app.get("/api/repos", async (c) => c.json(await listRepos()));

app.get("/api/repos/:owner/:name/branches", async (c) => c.json(await listBranches(c.req.param("owner"), c.req.param("name"))));

app.post("/api/repo", async (c) => {
  await connectRepo(await c.req.json<RepoRef>());
  return c.json(await session());
});

app.post("/api/repo/disconnect", async (c) => {
  await disconnectRepo();
  return c.json(await session());
});

app.post("/api/repo/new", async (c) => {
  const body = await c.req.json<{ name: string; private: boolean; fromKeyboard: boolean }>();
  const read = body.fromKeyboard ? pendingLayout() : null;
  if (body.fromKeyboard && !read) throw new Error("Read the layout from your keyboard first");
  await createNewRepo({ name: body.name, private: body.private, layers: read?.layout.layers, keymapText: read?.keymapText });
  return c.json(await session());
});

app.post("/api/onboarding/complete", async (c) => {
  await saveState({ onboarded: true });
  return c.json(await session());
});

app.post("/api/onboarding/restart", async (c) => {
  await saveState({ onboarded: false });
  return c.json(await session());
});

// Keyboard

app.get("/api/keyboard", async (c) => c.json(await keyboardInfo()));

app.post("/api/keyboard/read", async (c) => c.json(await readKeyboardLayout()));

app.post("/api/repo/install", async (c) => {
  const sha = await installTandem();
  return c.json({ sha, session: await session() });
});

// Editor

async function appState(): Promise<AppState> {
  const ws = await openWorkspace();
  const keymap = await readKeymap();
  const s = await loadState();
  const repo = s.repo!;
  return {
    repo: { ...repo, url: `https://github.com/${repo.owner}/${repo.name}/tree/${repo.branch}` },
    layout: ws.layout,
    rows: ws.rows,
    keymap,
    settings: s.settings,
    buildId: await currentBuildId(),
    lastBuild: s.lastBuild,
  };
}

app.get("/api/state", async (c) => c.json(await appState()));

app.put("/api/keymap", async (c) => {
  const { keymap } = await c.req.json<{ keymap: Keymap }>();
  await saveKeymap(keymap);
  return c.json(await appState());
});

app.put("/api/settings", async (c) => {
  await saveState({ settings: await c.req.json<BuildSettings>() });
  return c.json(await appState());
});

// Keyboard

app.get("/api/devices", async (c) => c.json(await scanDevices()));

app.post("/api/update", async (c) => {
  const body = await c.req.json<{ keymap?: Keymap }>().catch(() => ({}) as { keymap?: Keymap });
  const job = startUpdate(body.keymap);
  return c.json({ id: job.id });
});

app.post("/api/update/cancel", (c) => {
  cancelJob();
  return c.json({ ok: true });
});

app.get("/api/update", (c) => c.json(currentJob()?.snapshot() ?? null));

// One stream for everything live: device status and update progress.
app.get("/api/events", (c) =>
  streamSSE(c, async (stream) => {
    let closed = false;
    let last = "";
    const send = (event: string, data: unknown) => stream.writeSSE({ event, data: JSON.stringify(data) });

    const job = currentJob();
    if (job) await send("job", job.snapshot());

    let unsubscribeJob = job?.subscribe((e) => send("job-event", e));
    const offStart = onJobStart((j) => {
      unsubscribeJob?.();
      send("job", j.snapshot());
      unsubscribeJob = j.subscribe((e) => send("job-event", e));
    });

    stream.onAbort(() => {
      closed = true;
      unsubscribeJob?.();
      offStart();
    });

    while (!closed) {
      let devices: DevicesStatus | null = null;
      try {
        devices = await scanDevices();
      } catch (err) {
        console.error("Device scan failed:", err);
      }
      if (devices) {
        const { scannedAt: _, ...comparable } = devices;
        const key = JSON.stringify(comparable);
        if (key !== last) {
          last = key;
          await send("devices", devices);
        }
      }
      await stream.sleep(1000);
    }
  }),
);

if (process.env.NODE_ENV === "production" && existsSync("dist")) {
  app.use("/*", serveStatic({ root: "./dist" }));
}

serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" }, () => {
  console.log(`Tandem helper on http://127.0.0.1:${PORT}`);
  console.log(`App data: ${APP_DIR}`);
});
