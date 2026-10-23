// What the browser remembers between visits. Small state and the GitHub token
// go in localStorage, downloaded firmware in IndexedDB. Both fall back to
// memory when the browser blocks storage, as some private windows do.

import type { BuildRecord, BuildSettings, RepoRef } from "../../shared/types";

export interface SavedState {
  settings: BuildSettings;
  lastBuild: BuildRecord | null;
  repo: RepoRef | null;
  /** Commit the keymap was last read from or committed as. */
  syncedSha: string | null;
  onboarded: boolean;
  /** In development, sign in with the GitHub CLI's login. */
  useGh: boolean;
}

const DEFAULT_STATE: SavedState = {
  settings: { studio: true },
  lastBuild: null,
  repo: null,
  syncedSha: null,
  onboarded: false,
  useGh: false,
};

const STATE_KEY = "tandem.state";
const TOKEN_KEY = "tandem.github";
const memory = new Map<string, string>();

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return memory.get(key) ?? null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    if (value === null) memory.delete(key);
    else memory.set(key, value);
  }
}

export function loadState(): SavedState {
  try {
    return { ...DEFAULT_STATE, ...JSON.parse(read(STATE_KEY) ?? "{}") };
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}

export function saveState(patch: Partial<SavedState>): SavedState {
  const next = { ...loadState(), ...patch };
  write(STATE_KEY, JSON.stringify(next));
  return next;
}

export interface StoredToken {
  token: string;
  /** Scopes GitHub granted, as its token response lists them. */
  scope: string;
}

export function loadToken(): StoredToken | null {
  try {
    return JSON.parse(read(TOKEN_KEY) ?? "null");
  } catch {
    return null;
  }
}

export function saveToken(token: StoredToken | null) {
  write(TOKEN_KEY, token && JSON.stringify(token));
}

// Firmware builds, a few at a time.

export interface StoredBuild {
  key: string;
  id: string;
  createdAt: string;
  left: Uint8Array;
  right: Uint8Array;
}

const KEEP_BUILDS = 4;
const memoryBuilds = new Map<string, StoredBuild>();
let database: Promise<IDBDatabase | null> | null = null;

function db(): Promise<IDBDatabase | null> {
  database ??= new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null);
    const req = indexedDB.open("tandem", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("builds", { keyPath: "key" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  return database;
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getBuild(key: string): Promise<StoredBuild | null> {
  const d = await db();
  if (!d) return memoryBuilds.get(key) ?? null;
  return (await done(d.transaction("builds").objectStore("builds").get(key))) ?? null;
}

export async function putBuild(build: StoredBuild): Promise<void> {
  const d = await db();
  if (!d) {
    memoryBuilds.set(build.key, build);
    return;
  }
  const store = d.transaction("builds", "readwrite").objectStore("builds");
  await done(store.put(build));
  const all = (await done(store.getAll())) as StoredBuild[];
  all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const old of all.slice(KEEP_BUILDS)) await done(store.delete(old.key));
}
