import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { join } from "node:path";

import type { BrowserWindow } from "electron";

import type { Point } from "./display.js";

const require = createRequire(import.meta.url);
let loggerModule: typeof import("./logger.js") | null = null;

function logDebug(message: string, fields: Record<string, unknown>): void {
  try {
    loggerModule ??= require("./logger.js") as typeof import("./logger.js");
    loggerModule.debug("pet.window", message, fields);
  } catch {}
}

function logWarn(message: string, fields: Record<string, unknown>): void {
  try {
    loggerModule ??= require("./logger.js") as typeof import("./logger.js");
    loggerModule.warn("pet.window", message, fields);
  } catch {}
}

type HyprlandClient = {
  readonly address?: unknown;
  readonly pid?: unknown;
  readonly title?: unknown;
  readonly class?: unknown;
  readonly initialClass?: unknown;
  readonly at?: unknown;
};

type HyprlandIpc = {
  listClients(): Promise<readonly HyprlandClient[]>;
  dispatch(command: string): Promise<void>;
};

type PositionState = {
  address: string | null;
  position: Point | null;
  pending: Point | null;
  resolving: Promise<void> | null;
  resolveAttempts: number;
  dispatchFailures: number;
  disabledUntil: number;
  sending: boolean;
};

const states = new WeakMap<BrowserWindow, PositionState>();
let testIpc: HyprlandIpc | null = null;
let testEnabled: boolean | null = null;

export function getWindowPosition(window: BrowserWindow): Point {
  if (!isHyprlandWindowPositioningAvailable()) {
    const [x, y] = window.getPosition();
    return { x, y };
  }

  const state = stateFor(window);
  void resolveAddress(window, state);
  if (state.position) return state.position;
  const [x, y] = window.getPosition();
  return { x, y };
}

export function setWindowPosition(window: BrowserWindow, x: number, y: number, animate = false): void {
  if (!Number.isFinite(x) || !Number.isFinite(y) || window.isDestroyed()) return;
  const position = { x: Math.round(x), y: Math.round(y) };
  if (!isHyprlandWindowPositioningAvailable()) {
    window.setPosition(position.x, position.y, animate);
    return;
  }

  const state = stateFor(window);
  state.position = position;
  if (Date.now() < state.disabledUntil) return;
  state.pending = position;
  void resolveAddress(window, state).then(() => flush(window, state));
}

export function _setHyprlandPositioningForTesting(enabled: boolean | null, ipc: HyprlandIpc | null = null): void {
  testEnabled = enabled;
  testIpc = ipc;
}

export function isHyprlandWindowPositioningAvailable(): boolean {
  if (testEnabled !== null) return testEnabled;
  if (process.platform !== "linux" || process.env.OPENPETS_ALLOW_WAYLAND !== "1") return false;
  if (!process.env.HYPRLAND_INSTANCE_SIGNATURE) return false;
  const ozoneArg = process.argv.find((arg) => arg.startsWith("--ozone-platform="))?.split("=", 2)[1];
  if (ozoneArg === "x11") return false;
  if (ozoneArg === "wayland") return true;
  return process.env.XDG_SESSION_TYPE === "wayland" || Boolean(process.env.WAYLAND_DISPLAY);
}

function stateFor(window: BrowserWindow): PositionState {
  let state = states.get(window);
  if (!state) {
    state = { address: null, position: null, pending: null, resolving: null, resolveAttempts: 0, dispatchFailures: 0, disabledUntil: 0, sending: false };
    states.set(window, state);
  }
  return state;
}

function resolveAddress(window: BrowserWindow, state: PositionState): Promise<void> {
  if (state.address || window.isDestroyed() || Date.now() < state.disabledUntil) return Promise.resolve();
  if (state.resolving) return state.resolving;
  state.resolving = findClient(window)
    .then((client) => {
      if (!client) return;
      state.address = client.address;
      state.resolveAttempts = 0;
      if (!state.position) state.position = client.position;
      logDebug("Hyprland window resolved", { windowId: window.id, address: client.address, title: window.getTitle() });
    })
    .catch((error: unknown) => {
      logWarn("Hyprland window resolution failed", { windowId: window.id, reason: error instanceof Error ? error.message : String(error) });
    })
    .finally(() => {
      state.resolving = null;
      if (!state.address && state.pending && !window.isDestroyed() && state.resolveAttempts < 20) {
        state.resolveAttempts += 1;
        setTimeout(() => { void resolveAddress(window, state).then(() => flush(window, state)); }, 50).unref?.();
      }
    });
  return state.resolving;
}

async function findClient(window: BrowserWindow): Promise<{ address: string; position: Point } | null> {
  const clients = await getIpc().listClients();
  const candidates = clients.flatMap((client) => {
    if (client.pid !== process.pid || !isAddress(client.address) || !isPoint(client.at)) return [];
    if (client.class !== "open-pets-desktop" && client.initialClass !== "open-pets-desktop") return [];
    return [{ address: client.address, title: typeof client.title === "string" ? client.title : "", position: { x: client.at[0], y: client.at[1] } }];
  });
  const exact = candidates.find((client) => client.title === window.getTitle());
  return exact ?? null;
}

function flush(window: BrowserWindow, state: PositionState): void {
  if (state.sending || !state.address || !state.pending || window.isDestroyed()) return;
  const position = state.pending;
  state.pending = null;
  state.sending = true;
  const command = `dispatch movewindowpixel exact ${position.x} ${position.y},address:${state.address}`;
  void getIpc().dispatch(command)
    .then(() => { state.dispatchFailures = 0; })
    .catch((error: unknown) => {
      state.address = null;
      state.dispatchFailures += 1;
      if (state.dispatchFailures < 3) state.pending ??= position;
      else state.disabledUntil = Date.now() + 5_000;
      state.resolveAttempts = 0;
      logWarn("Hyprland window move failed", { windowId: window.id, reason: error instanceof Error ? error.message : String(error) });
    })
    .finally(() => {
      state.sending = false;
      if (state.pending) {
        const retryMs = state.address ? 0 : state.dispatchFailures * 100;
        setTimeout(() => { void resolveAddress(window, state).then(() => flush(window, state)); }, retryMs).unref?.();
      }
    });
}

function getIpc(): HyprlandIpc {
  return testIpc ?? nativeIpc;
}

const nativeIpc: HyprlandIpc = {
  listClients: () => new Promise((resolve, reject) => {
    execFile("hyprctl", ["-j", "clients"], { timeout: 1_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) { reject(error); return; }
      try {
        const parsed: unknown = JSON.parse(stdout);
        resolve(Array.isArray(parsed) ? parsed as HyprlandClient[] : []);
      } catch (parseError) {
        reject(parseError);
      }
    });
  }),
  dispatch: (command) => sendSocketCommand(command),
};

function sendSocketCommand(command: string): Promise<void> {
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  const signature = process.env.HYPRLAND_INSTANCE_SIGNATURE;
  if (!runtimeDir || !signature || !/^[A-Za-z0-9_.-]+$/.test(signature)) {
    return Promise.reject(new Error("Hyprland IPC environment is unavailable."));
  }
  const socketPath = join(runtimeDir, "hypr", signature, ".socket.sock");
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let response = "";
    socket.setEncoding("utf8");
    socket.setTimeout(1_000);
    socket.on("connect", () => socket.end(command));
    socket.on("data", (chunk) => { response += chunk; });
    socket.on("timeout", () => socket.destroy(new Error("Hyprland IPC timed out.")));
    socket.on("error", reject);
    socket.on("close", (hadError) => {
      if (hadError) return;
      if (response.trim() !== "ok") { reject(new Error(response.trim() || "Hyprland IPC returned no response.")); return; }
      resolve();
    });
  });
}

function isAddress(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-f]+$/i.test(value);
}

function isPoint(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && Number.isFinite(value[0]) && Number.isFinite(value[1]);
}
