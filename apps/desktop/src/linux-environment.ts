import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { computeEffectiveWaylandBackend } from "./wayland-backend.js";

export interface LinuxEnvironmentDiagnostic {
  readonly environment: "omarchy" | "linux";
  readonly omarchyVersion?: string;
  readonly compositor: "hyprland" | "other" | "unknown";
  readonly sessionType: "x11" | "wayland" | "unknown";
  readonly displayBackend: "x11" | "xwayland" | "wayland" | "unknown";
  readonly ozonePlatform: "x11" | "wayland" | "auto";
  readonly positioning: "electron" | "hyprland-ipc" | "unsupported";
  readonly state: "ready" | "attention";
  readonly issue?: "native-wayland-positioning-unsupported";
}

export interface LinuxEnvironmentInput {
  readonly platform: NodeJS.Platform | string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly ozonePlatform: string;
  readonly omarchyVersion?: string;
  readonly hyprlandPositioningAvailable: boolean;
}

const omarchyVersionPattern = /^[0-9]+(?:\.[0-9]+){1,3}(?:[-+][A-Za-z0-9.-]+)?$/;

export function classifyLinuxEnvironment(input: LinuxEnvironmentInput): LinuxEnvironmentDiagnostic | undefined {
  if (input.platform !== "linux") return undefined;

  const sessionType = input.env.XDG_SESSION_TYPE === "wayland" ? "wayland" : input.env.XDG_SESSION_TYPE === "x11" ? "x11" : "unknown";
  const ozonePlatform = input.ozonePlatform === "wayland" ? "wayland" : input.ozonePlatform === "x11" ? "x11" : "auto";
  const nativeWayland = computeEffectiveWaylandBackend(input.platform, input.ozonePlatform, input.env.XDG_SESSION_TYPE, input.env.WAYLAND_DISPLAY);
  const compositor = input.env.HYPRLAND_INSTANCE_SIGNATURE ? "hyprland" : input.env.XDG_CURRENT_DESKTOP ? "other" : "unknown";
  const displayBackend = nativeWayland ? "wayland" : ozonePlatform === "x11" && sessionType === "wayland" ? "xwayland" : ozonePlatform === "x11" || sessionType === "x11" ? "x11" : "unknown";
  const positioning = nativeWayland ? input.hyprlandPositioningAvailable ? "hyprland-ipc" : "unsupported" : "electron";

  return {
    environment: input.omarchyVersion ? "omarchy" : "linux",
    omarchyVersion: input.omarchyVersion,
    compositor,
    sessionType,
    displayBackend,
    ozonePlatform,
    positioning,
    state: positioning === "unsupported" ? "attention" : "ready",
    issue: positioning === "unsupported" ? "native-wayland-positioning-unsupported" : undefined,
  };
}

export function readOmarchyVersion(homeDir: string): string | undefined {
  try {
    const versionPath = join(homeDir, ".local", "share", "omarchy", "version");
    const stat = statSync(versionPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 128) return undefined;
    const version = readFileSync(versionPath, "utf8").trim();
    return omarchyVersionPattern.test(version) ? version : undefined;
  } catch {
    return undefined;
  }
}
