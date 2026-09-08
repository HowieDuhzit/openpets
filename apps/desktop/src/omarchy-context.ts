import { execFile } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";

import { app } from "electron";

import { getAppStateSnapshot } from "./app-state.js";
import { applyDefaultPetContext, moveDefaultPetToMonitor } from "./default-pet-controller.js";
import { readOmarchyVersion } from "./linux-environment.js";
import { debug, info, warn } from "./logger.js";
import { getHyprlandMonitorCenter, isRelevantHyprlandEvent, parseHyprlandContext, type OmarchyContextSnapshot } from "./omarchy-context-core.js";
import { isHyprlandWindowPositioningAvailable } from "./window-position.js";

const maxOutputBytes = 1024 * 1024;
let supported = false;
let started = false;
let stopped = false;
let socket: Socket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let reconcileTimer: NodeJS.Timeout | null = null;
let reconnectAttempt = 0;
let buffer = "";
let generation = 0;
let reconcileInFlight = false;
let reconcilePending = false;
let lastSnapshot: OmarchyContextSnapshot = { activeMonitor: null, fullscreen: false };

export function isOmarchyContextSupported(): boolean {
  return supported;
}

export async function startOmarchyContext(): Promise<void> {
  if (started) return;
  started = true;
  stopped = false;
  supported = app.isPackaged && Boolean(readOmarchyVersion(app.getPath("home"))) && isHyprlandWindowPositioningAvailable();
  if (!supported) return;
  await reconcile();
  connect();
  info("capabilities", "Omarchy context integration started");
}

export function stopOmarchyContext(): void {
  stopped = true;
  generation += 1;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (reconcileTimer) clearTimeout(reconcileTimer);
  reconnectTimer = null;
  reconcileTimer = null;
  buffer = "";
  const current = socket;
  socket = null;
  current?.removeAllListeners();
  current?.destroy();
}

export function applyOmarchyContextPreferences(): void {
  if (!supported) return;
  applySnapshot(lastSnapshot);
}

function connect(): void {
  if (stopped || socket) return;
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  const signature = process.env.HYPRLAND_INSTANCE_SIGNATURE;
  if (!runtimeDir || !signature || !/^[A-Za-z0-9_.-]+$/.test(signature)) return;
  const next = createConnection(join(runtimeDir, "hypr", signature, ".socket2.sock"));
  socket = next;
  next.setEncoding("utf8");
  next.on("connect", () => {
    reconnectAttempt = 0;
    buffer = "";
    scheduleReconcile(0);
    debug("capabilities", "Hyprland event stream connected", {});
  });
  next.on("data", handleData);
  next.on("error", (error) => warn("capabilities", "Hyprland event stream error", { reason: error.message }));
  next.on("close", () => {
    if (socket === next) socket = null;
    scheduleReconnect();
  });
}

function handleData(chunk: string | Buffer): void {
  buffer += chunk.toString();
  if (buffer.length > 32_768) {
    buffer = "";
    socket?.destroy(new Error("Hyprland event buffer exceeded limit."));
    return;
  }
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  if (lines.some((line) => isRelevantHyprlandEvent(line.replace(/\r$/, "")))) scheduleReconcile(50);
}

function scheduleReconcile(delayMs: number): void {
  if (stopped) return;
  if (reconcileTimer) clearTimeout(reconcileTimer);
  reconcileTimer = setTimeout(() => {
    reconcileTimer = null;
    void reconcile();
  }, delayMs);
  reconcileTimer.unref?.();
}

function scheduleReconnect(): void {
  if (stopped || reconnectTimer) return;
  const delayMs = Math.min(30_000, 500 * 2 ** Math.min(reconnectAttempt++, 6));
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delayMs);
  reconnectTimer.unref?.();
}

async function reconcile(): Promise<void> {
  if (stopped) return;
  if (reconcileInFlight) {
    reconcilePending = true;
    return;
  }
  reconcileInFlight = true;
  const currentGeneration = generation;
  try {
    const [monitors, workspace] = await Promise.all([queryHyprland("monitors"), queryHyprland("activeworkspace")]);
    if (stopped || currentGeneration !== generation) return;
    const snapshot = parseHyprlandContext(monitors, workspace);
    const changed = JSON.stringify(snapshot) !== JSON.stringify(lastSnapshot);
    lastSnapshot = snapshot;
    if (changed) {
      debug("capabilities", "Omarchy context changed", { activeMonitor: snapshot.activeMonitor?.name ?? null, fullscreen: snapshot.fullscreen });
      applySnapshot(snapshot);
    }
  } catch (error) {
    warn("capabilities", "Omarchy context query failed", { reason: error instanceof Error ? error.message : String(error) });
  } finally {
    reconcileInFlight = false;
    if (reconcilePending && !stopped) {
      reconcilePending = false;
      scheduleReconcile(0);
    }
  }
}

function applySnapshot(snapshot: OmarchyContextSnapshot): void {
  const preferences = getAppStateSnapshot().preferences;
  applyDefaultPetContext(preferences.hideDefaultPetOnFullscreen && snapshot.fullscreen);
  if (preferences.followActiveMonitor && snapshot.activeMonitor) {
    const center = getHyprlandMonitorCenter(snapshot.activeMonitor);
    if (center) moveDefaultPetToMonitor(center);
  }
}

function queryHyprland(resource: "monitors" | "activeworkspace"): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile("hyprctl", ["-j", resource], { timeout: 1_000, maxBuffer: maxOutputBytes }, (error, stdout) => {
      if (error) { reject(error); return; }
      try { resolve(JSON.parse(stdout)); } catch (parseError) { reject(parseError); }
    });
  });
}
