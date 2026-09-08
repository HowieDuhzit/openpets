import { randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";

import { buildWaybarHelper, shellQuote, waybarHelperEnd, waybarHelperStart } from "./waybar-helper.js";

export type OmarchySetupAction = "install" | "repair" | "doctor" | "remove";
export type OmarchySetupState = "unsupported" | "not_installed" | "installed" | "needs_repair" | "conflict" | "error";
export type OmarchyArtifactState = "missing" | "installed" | "needs_repair" | "conflict" | "error";

export interface OmarchySetupArtifactStatus {
  readonly state: OmarchyArtifactState;
  readonly label: string;
}

export interface OmarchySetupStatus {
  readonly state: OmarchySetupState;
  readonly message: string;
  readonly artifacts: {
    readonly hyprlandRules: OmarchySetupArtifactStatus;
    readonly hyprlandSource: OmarchySetupArtifactStatus;
    readonly autostart: OmarchySetupArtifactStatus;
    readonly waybarConfig: OmarchySetupArtifactStatus;
    readonly waybarHelper: OmarchySetupArtifactStatus;
    readonly walkerMenu: OmarchySetupArtifactStatus;
  };
  readonly canInstall: boolean;
  readonly canRepair: boolean;
  readonly canRemove: boolean;
}

export interface OmarchySetupResult {
  readonly ok: boolean;
  readonly changed: boolean;
  readonly action: OmarchySetupAction;
  readonly message: string;
  readonly status: OmarchySetupStatus;
}

export interface OmarchySetupOptions {
  readonly platform: NodeJS.Platform | string;
  readonly homeDir: string;
  readonly executablePath: string;
  readonly omarchyVersion?: string;
  readonly packaged: boolean;
}

const sourceStart = "# OPENPETS:OMARCHY_SOURCE:START";
const sourceEnd = "# OPENPETS:OMARCHY_SOURCE:END";
const configStart = "# OPENPETS:OMARCHY_CONFIG:START";
const configEnd = "# OPENPETS:OMARCHY_CONFIG:END";
const autostartStart = "# OPENPETS:OMARCHY_AUTOSTART:START";
const autostartEnd = "# OPENPETS:OMARCHY_AUTOSTART:END";
const walkerStart = "# OPENPETS:WALKER_MENU:START";
const walkerEnd = "# OPENPETS:WALKER_MENU:END";
const maxHyprlandConfigBytes = 1024 * 1024;
const maxManagedFileBytes = 64 * 1024;
const maxWaybarConfigBytes = 1024 * 1024;

const rules = [
  "windowrule = decorate off, match:class open-pets-desktop",
  "windowrule = border_size 0, match:class open-pets-desktop",
  "windowrule = rounding 0, match:class open-pets-desktop",
  "windowrule = no_shadow on, match:class open-pets-desktop",
  "windowrule = no_blur on, match:class open-pets-desktop",
  "windowrule = float on, match:class open-pets-desktop",
  "windowrule = pin on, match:class open-pets-desktop",
] as const;

type ArtifactRead = { readonly state: OmarchyArtifactState; readonly content: string; readonly exists: boolean };

export function buildOmarchyHyprlandConfig(): string {
  return `${configStart}\n# Managed by OpenPets. Use Control Center to repair or remove this file.\n${rules.join("\n")}\n${configEnd}\n`;
}

export function buildOmarchyAutostart(executablePath: string): string {
  const executable = escapeDesktopExecArg(validateExecutablePath(executablePath));
  return `${autostartStart}\n[Desktop Entry]\nType=Application\nName=OpenPets\nComment=Animated desktop pets for coding agents\nExec=/usr/bin/env OPENPETS_ALLOW_WAYLAND=1 ${executable} --ozone-platform=wayland\nTerminal=false\nX-GNOME-Autostart-enabled=true\n${autostartEnd}\n`;
}

export function buildWaybarModule(executablePath: string, helperPath: string): Record<string, unknown> {
  const executable = validateExecutablePath(executablePath);
  if (!isAbsolute(helperPath) || /[\0\r\n]/.test(helperPath)) throw new Error("Waybar helper path is invalid.");
  return {
    exec: `${shellQuote("/usr/bin/env")} ${shellQuote("ELECTRON_RUN_AS_NODE=1")} ${shellQuote(executable)} ${shellQuote(helperPath)}`,
    "return-type": "json",
    "restart-interval": 2,
    "on-click": buildNativeWaylandCommand(executable, "--open-control-center=dashboard"),
    "on-click-right": buildNativeWaylandCommand(executable, "--toggle-default-pet-paused"),
    "on-click-middle": buildNativeWaylandCommand(executable, "--toggle-default-pet"),
    "openpets-managed": true,
  };
}

export function buildWalkerMenu(executablePath: string): string {
  const executable = validateExecutablePath(executablePath);
  const entries = [
    { text: "Open Control Center", keywords: ["dashboard", "pets", "settings"], action: "--open-control-center=dashboard" },
    { text: "Show or Hide Pet", keywords: ["show", "hide", "visibility"], action: "--toggle-default-pet" },
    { text: "Pause or Resume Pet", keywords: ["pause", "resume"], action: "--toggle-default-pet-paused" },
  ];
  return `${walkerStart}
name = "openpets"
name_pretty = "OpenPets"
description = "Desktop companion controls"
hide_from_providerlist = false
search_name = true
fixed_order = true

${entries.map((entry) => `[[entries]]\ntext = ${tomlString(entry.text)}\nkeywords = [${entry.keywords.map(tomlString).join(", ")}]\nactions = { activate = ${tomlString(buildNativeWaylandCommand(executable, entry.action))} }`).join("\n\n")}
${walkerEnd}
`;
}

export function getOmarchySetupStatus(options: OmarchySetupOptions): OmarchySetupStatus {
  if (!isSupported(options)) return statusFor("unsupported", emptyArtifacts("missing"));
  try {
    const paths = getPaths(options.homeDir);
    const expectedAutostart = buildOmarchyAutostart(options.executablePath);
    const rulesStatus = readDedicated(paths.rules, buildOmarchyHyprlandConfig(), configStart, configEnd);
    const sourceStatus = readSource(paths.hyprland, sourceBlock());
    const autostartStatus = readDedicated(paths.autostart, expectedAutostart, autostartStart, autostartEnd);
    const waybarConfigStatus = readWaybarConfig(paths.waybarConfig, buildWaybarModule(options.executablePath, paths.waybarHelper));
    const waybarHelperStatus = readDedicated(paths.waybarHelper, buildWaybarHelper(), waybarHelperStart, waybarHelperEnd);
    const walkerMenuStatus = readDedicated(paths.walkerMenu, buildWalkerMenu(options.executablePath), walkerStart, walkerEnd);
    const artifacts = {
      hyprlandRules: publicArtifact(rulesStatus.state),
      hyprlandSource: publicArtifact(sourceStatus.state),
      autostart: publicArtifact(autostartStatus.state),
      waybarConfig: publicArtifact(waybarConfigStatus.state),
      waybarHelper: publicArtifact(waybarHelperStatus.state),
      walkerMenu: publicArtifact(walkerMenuStatus.state),
    };
    const states = [rulesStatus.state, sourceStatus.state, autostartStatus.state, waybarConfigStatus.state, waybarHelperStatus.state, walkerMenuStatus.state];
    if (states.includes("error")) return statusFor("error", artifacts);
    if (states.includes("conflict")) return statusFor("conflict", artifacts);
    if (states.every((state) => state === "missing")) return statusFor("not_installed", artifacts);
    if (states.every((state) => state === "installed")) return statusFor("installed", artifacts);
    return statusFor("needs_repair", artifacts);
  } catch {
    return statusFor("error", emptyArtifacts("error"));
  }
}

export function runOmarchySetupAction(action: OmarchySetupAction, options: OmarchySetupOptions): OmarchySetupResult {
  const before = getOmarchySetupStatus(options);
  if (action === "doctor") return { ok: before.state !== "error", changed: false, action, message: before.message, status: before };
  const allowed = action === "install" ? before.canInstall : action === "repair" ? before.canRepair : before.canRemove;
  if (!allowed) return { ok: false, changed: false, action, message: `Omarchy setup cannot ${action} while its state is ${before.state}.`, status: before };

  try {
    const paths = getPaths(options.homeDir);
    assertSafeSetupPaths(options.homeDir, paths);
    if (action === "remove") removeManagedSetup(paths, options.executablePath);
    else installOrRepairSetup(paths, options.executablePath);
    const status = getOmarchySetupStatus(options);
    const ok = action === "remove" ? status.state === "not_installed" : status.state === "installed";
    return { ok, changed: true, action, message: ok ? action === "remove" ? "Omarchy integration removed." : "Omarchy integration installed." : status.message, status };
  } catch {
    const status = getOmarchySetupStatus(options);
    return { ok: false, changed: false, action, message: "Omarchy setup could not be changed safely. Run Doctor for details.", status };
  }
}

function installOrRepairSetup(paths: ReturnType<typeof getPaths>, executablePath: string): void {
  const expectedRules = buildOmarchyHyprlandConfig();
  const expectedAutostart = buildOmarchyAutostart(executablePath);
  if (readDedicated(paths.rules, expectedRules, configStart, configEnd).state !== "installed") writeManagedFile(paths.rules, expectedRules);
  if (readDedicated(paths.autostart, expectedAutostart, autostartStart, autostartEnd).state !== "installed") writeManagedFile(paths.autostart, expectedAutostart);
  if (readDedicated(paths.waybarHelper, buildWaybarHelper(), waybarHelperStart, waybarHelperEnd).state !== "installed") writeManagedFile(paths.waybarHelper, buildWaybarHelper());
  if (readDedicated(paths.walkerMenu, buildWalkerMenu(executablePath), walkerStart, walkerEnd).state !== "installed") writeManagedFile(paths.walkerMenu, buildWalkerMenu(executablePath));
  const waybar = readWaybarConfig(paths.waybarConfig, buildWaybarModule(executablePath, paths.waybarHelper));
  if (waybar.state !== "installed") writeManagedFile(paths.waybarConfig, updateWaybarConfig(waybar.content, buildWaybarModule(executablePath, paths.waybarHelper), false));
  const source = readSource(paths.hyprland, sourceBlock());
  if (source.state === "conflict" || source.state === "error") throw new Error("Hyprland source configuration conflicts with OpenPets setup.");
  if (source.state === "installed") return;
  const next = source.state === "missing" ? appendBlock(removeInlineOpenPetsRules(source.content), sourceBlock()) : replaceManagedBlock(source.content, sourceStart, sourceEnd, sourceBlock());
  writeManagedFile(paths.hyprland, next);
}

function removeManagedSetup(paths: ReturnType<typeof getPaths>, executablePath: string): void {
  const source = readSource(paths.hyprland, sourceBlock());
  if (source.state === "installed" || source.state === "needs_repair") {
    writeManagedFile(paths.hyprland, removeManagedBlock(source.content, sourceStart, sourceEnd));
  }
  removeDedicated(paths.rules, buildOmarchyHyprlandConfig(), configStart, configEnd);
  removeDedicated(paths.autostart, buildOmarchyAutostart(executablePath), autostartStart, autostartEnd);
  const waybar = readWaybarConfig(paths.waybarConfig, buildWaybarModule(executablePath, paths.waybarHelper));
  if (waybar.state === "installed" || waybar.state === "needs_repair") writeManagedFile(paths.waybarConfig, updateWaybarConfig(waybar.content, buildWaybarModule(executablePath, paths.waybarHelper), true));
  else if (waybar.state !== "missing") throw new Error("Waybar module ownership is ambiguous.");
  removeDedicated(paths.waybarHelper, buildWaybarHelper(), waybarHelperStart, waybarHelperEnd);
  removeDedicated(paths.walkerMenu, buildWalkerMenu(executablePath), walkerStart, walkerEnd);
}

function getPaths(homeDir: string) {
  const config = join(homeDir, ".config");
  return {
    hyprland: join(config, "hypr", "hyprland.conf"),
    rules: join(config, "hypr", "openpets.conf"),
    autostart: join(config, "autostart", "openpets.desktop"),
    waybarConfig: join(config, "waybar", "config.jsonc"),
    waybarHelper: join(config, "OpenPets", "waybar.cjs"),
    walkerMenu: join(config, "elephant", "menus", "openpets.toml"),
  };
}

function sourceBlock(): string {
  return `${sourceStart}\nsource = ~/.config/hypr/openpets.conf\n${sourceEnd}\n`;
}

function readDedicated(path: string, expected: string, start: string, end: string): ArtifactRead {
  const read = readSafe(path, maxManagedFileBytes);
  if (read.state === "missing" || read.state === "error") return read;
  const markerState = classifyMarkers(read.content, start, end, true);
  if (markerState !== "managed") return { ...read, state: "conflict" };
  return { ...read, state: normalize(read.content) === normalize(expected) ? "installed" : "needs_repair" };
}

function readSource(path: string, expectedBlock: string): ArtifactRead {
  const read = readSafe(path, maxHyprlandConfigBytes);
  if (read.state === "missing" || read.state === "error") return read;
  const markerState = classifyMarkers(read.content, sourceStart, sourceEnd, false);
  if (markerState === "missing") {
    if (/^\s*source\s*=\s*~\/\.config\/hypr\/openpets\.conf\s*$/m.test(read.content)) return { ...read, state: "conflict" };
    return { ...read, state: "missing" };
  }
  if (markerState === "conflict") return { ...read, state: "conflict" };
  const block = extractManagedBlock(read.content, sourceStart, sourceEnd);
  return { ...read, state: normalize(block) === normalize(expectedBlock) ? "installed" : "needs_repair" };
}

function readWaybarConfig(path: string, expectedModule: Record<string, unknown>): ArtifactRead {
  const read = readSafe(path, maxWaybarConfigBytes);
  if (read.state === "missing") return { ...read, state: "error" };
  if (read.state === "error") return read;
  const errors: ParseError[] = [];
  const parsed = parse(read.content, errors, { allowTrailingComma: true, disallowComments: false }) as unknown;
  if (errors.length > 0 || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...read, state: "error" };
  const record = parsed as Record<string, unknown>;
  const center = record["modules-center"];
  if (!Array.isArray(center) || !center.every((item) => typeof item === "string")) return { ...read, state: "conflict" };
  const occurrences = center.filter((item) => item === "custom/openpets").length;
  const module = record["custom/openpets"];
  if (module === undefined && occurrences === 0) return { ...read, state: "missing" };
  if (!module || typeof module !== "object" || Array.isArray(module) || (module as Record<string, unknown>)["openpets-managed"] !== true || occurrences > 1) return { ...read, state: "conflict" };
  return { ...read, state: JSON.stringify(module) === JSON.stringify(expectedModule) && occurrences === 1 ? "installed" : "needs_repair" };
}

function updateWaybarConfig(content: string, expectedModule: Record<string, unknown>, remove: boolean): string {
  const errors: ParseError[] = [];
  const parsed = parse(content, errors, { allowTrailingComma: true, disallowComments: false }) as Record<string, unknown> | undefined;
  if (errors.length > 0 || !parsed || !Array.isArray(parsed["modules-center"])) throw new Error("Waybar configuration is invalid.");
  const existingModule = parsed["custom/openpets"];
  if (existingModule !== undefined && (typeof existingModule !== "object" || existingModule === null || Array.isArray(existingModule) || (existingModule as Record<string, unknown>)["openpets-managed"] !== true)) throw new Error("Waybar OpenPets module is not managed by OpenPets.");
  const center = (parsed["modules-center"] as unknown[]).filter((item) => item !== "custom/openpets");
  if (!remove) center.push("custom/openpets");
  const formattingOptions = { insertSpaces: true, tabSize: 2 };
  let next = applyEdits(content, modify(content, ["modules-center"], center, { formattingOptions }));
  next = applyEdits(next, modify(next, ["custom/openpets"], remove ? undefined : expectedModule, { formattingOptions }));
  return next.endsWith("\n") ? next : `${next}\n`;
}

function readSafe(path: string, maxBytes: number): ArtifactRead {
  if (!existsSync(path)) return { state: "missing", content: "", exists: false };
  try {
    const lstat = lstatSync(path);
    if (lstat.isSymbolicLink() || !lstat.isFile()) return { state: "error", content: "", exists: true };
    const stat = statSync(path);
    if (stat.size > maxBytes) return { state: "error", content: "", exists: true };
    return { state: "installed", content: readFileSync(path, "utf8"), exists: true };
  } catch {
    return { state: "error", content: "", exists: true };
  }
}

function classifyMarkers(content: string, start: string, end: string, wholeFile: boolean): "missing" | "managed" | "conflict" {
  const starts = count(content, start);
  const ends = count(content, end);
  if (starts === 0 && ends === 0) return "missing";
  if (starts !== 1 || ends !== 1 || content.indexOf(start) > content.indexOf(end)) return "conflict";
  if (wholeFile) {
    const block = extractManagedBlock(content, start, end);
    if (normalize(block) !== normalize(content)) return "conflict";
  }
  return "managed";
}

function extractManagedBlock(content: string, start: string, end: string): string {
  const from = content.indexOf(start);
  const through = content.indexOf(end, from) + end.length;
  return `${content.slice(from, through).trim()}\n`;
}

function replaceManagedBlock(content: string, start: string, end: string, replacement: string): string {
  const from = content.indexOf(start);
  const through = content.indexOf(end, from) + end.length;
  return `${content.slice(0, from)}${replacement.trimEnd()}${content.slice(through)}`.replace(/\n{3,}/g, "\n\n").replace(/\s*$/, "\n");
}

function removeManagedBlock(content: string, start: string, end: string): string {
  const from = content.indexOf(start);
  const through = content.indexOf(end, from) + end.length;
  return `${content.slice(0, from)}${content.slice(through)}`.replace(/\n{3,}/g, "\n\n").replace(/\s*$/, "\n");
}

function appendBlock(content: string, block: string): string {
  return `${content.replace(/\s*$/, "")}\n\n${block}`;
}

function removeInlineOpenPetsRules(content: string): string {
  const managedLines = new Set<string>(rules);
  return content.split(/\r?\n/).filter((line) => !managedLines.has(line.trim())).join("\n").replace(/\n{3,}/g, "\n\n");
}

function writeManagedFile(path: string, content: string): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (existsSync(path)) createBackup(path);
  const temp = join(parent, `.${randomUUID()}.openpets.tmp`);
  const fd = openSync(temp, "wx", 0o600);
  try { writeFileSync(fd, content, "utf8"); } finally { closeSync(fd); }
  try { renameSync(temp, path); } catch (error) { rmSync(temp, { force: true }); throw error; }
}

function removeDedicated(path: string, expected: string, start: string, end: string): void {
  const current = readDedicated(path, expected, start, end);
  if (current.state === "missing") return;
  if (current.state !== "installed" && current.state !== "needs_repair") throw new Error("Managed file ownership is ambiguous.");
  const backup = uniqueBackup(path);
  renameSync(path, backup);
}

function createBackup(path: string): void {
  const backup = uniqueBackup(path);
  const fd = openSync(backup, "wx", 0o600);
  try { writeFileSync(fd, readFileSync(path)); } finally { closeSync(fd); }
}

function uniqueBackup(path: string): string {
  return `${path}.openpets-backup-${process.pid}-${Date.now()}-${randomUUID()}`;
}

function assertSafeSetupPaths(homeDir: string, paths: ReturnType<typeof getPaths>): void {
  if (!isAbsolute(homeDir)) throw new Error("Home path must be absolute.");
  const root = resolve(homeDir);
  for (const path of Object.values(paths)) {
    const target = resolve(path);
    const rel = relative(root, target);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Setup path escapes the home directory.");
    let current = root;
    for (const part of rel.split(/[\\/]+/).slice(0, -1)) {
      current = join(current, part);
      if (!existsSync(current)) break;
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Setup path contains an unsafe parent.");
    }
    if (existsSync(target)) {
      const stat = lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Setup target is unsafe.");
    }
  }
}

function validateExecutablePath(path: string): string {
  if (!isAbsolute(path) || /[\0\r\n]/.test(path)) throw new Error("OpenPets executable path is invalid.");
  return path;
}

function escapeDesktopExecArg(value: string): string {
  return `"${value.replace(/([\\"`$])/g, "\\$1")}"`;
}

function isSupported(options: OmarchySetupOptions): boolean {
  return options.platform === "linux" && Boolean(options.omarchyVersion) && options.packaged && isAbsolute(options.homeDir);
}

function statusFor(state: OmarchySetupState, artifacts: OmarchySetupStatus["artifacts"]): OmarchySetupStatus {
  const messages: Record<OmarchySetupState, string> = {
    unsupported: "Managed Omarchy setup requires the packaged Linux app running on Omarchy.",
    not_installed: "Omarchy integration is not installed.",
    installed: "Omarchy integration is installed and up to date.",
    needs_repair: "Omarchy integration is incomplete or needs repair.",
    conflict: "Existing configuration conflicts with managed Omarchy setup.",
    error: "Omarchy integration could not safely inspect its configuration.",
  };
  const safelyOwned = Object.values(artifacts).some((artifact) => artifact.state === "installed" || artifact.state === "needs_repair");
  return { state, message: messages[state], artifacts, canInstall: state === "not_installed", canRepair: state === "needs_repair", canRemove: safelyOwned && state !== "conflict" && state !== "error" };
}

function publicArtifact(state: OmarchyArtifactState): OmarchySetupArtifactStatus {
  const labels: Record<OmarchyArtifactState, string> = { missing: "Missing", installed: "Installed", needs_repair: "Needs repair", conflict: "Conflict", error: "Error" };
  return { state, label: labels[state] };
}

function emptyArtifacts(state: OmarchyArtifactState): OmarchySetupStatus["artifacts"] {
  const artifact = publicArtifact(state);
  return { hyprlandRules: artifact, hyprlandSource: artifact, autostart: artifact, waybarConfig: artifact, waybarHelper: artifact, walkerMenu: artifact };
}

function buildNativeWaylandCommand(executablePath: string, action: string): string {
  return `${shellQuote("/usr/bin/env")} ${shellQuote("OPENPETS_ALLOW_WAYLAND=1")} ${shellQuote(executablePath)} --ozone-platform=wayland ${action}`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function count(content: string, needle: string): number {
  return content.split(needle).length - 1;
}

function normalize(content: string): string {
  return content.replace(/\r\n/g, "\n").trim();
}
