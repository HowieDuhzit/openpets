import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { buildOmarchyAutostart, buildOmarchyHyprlandConfig, getOmarchySetupStatus, runOmarchySetupAction, type OmarchySetupOptions } from "../src/omarchy-setup.js";

function fixture(): { home: string; options: OmarchySetupOptions; hyprland: string; rules: string; autostart: string; waybar: string; helper: string; walker: string } {
  const home = mkdtempSync(join(tmpdir(), "openpets-omarchy-setup-"));
  const hyprDir = join(home, ".config", "hypr");
  mkdirSync(hyprDir, { recursive: true });
  const hyprland = join(hyprDir, "hyprland.conf");
  writeFileSync(hyprland, "# User configuration\nsource = ~/.config/hypr/monitors.conf\n");
  const waybarDir = join(home, ".config", "waybar");
  mkdirSync(waybarDir, { recursive: true });
  const waybar = join(waybarDir, "config.jsonc");
  writeFileSync(waybar, `{
  // Preserve user modules and comments.
  "modules-center": ["clock", "custom/voicebox"],
  "custom/voicebox": { "exec": "voicebox" }
}\n`);
  return {
    home,
    options: { platform: "linux", homeDir: home, executablePath: "/opt/Open Pets/openpets", omarchyVersion: "3.8.4", packaged: true },
    hyprland,
    rules: join(hyprDir, "openpets.conf"),
    autostart: join(home, ".config", "autostart", "openpets.desktop"),
    waybar,
    helper: join(home, ".config", "OpenPets", "waybar.cjs"),
    walker: join(home, ".config", "elephant", "menus", "openpets.toml"),
  };
}

describe("managed Omarchy setup", () => {
  it("installs all artifacts while preserving user Hyprland configuration", () => {
    const value = fixture();
    try {
      assert.equal(getOmarchySetupStatus(value.options).state, "not_installed");
      const result = runOmarchySetupAction("install", value.options);
      assert.equal(result.ok, true);
      assert.equal(result.status.state, "installed");
      const hyprland = readFileSync(value.hyprland, "utf8");
      assert.match(hyprland, /# User configuration/);
      assert.match(hyprland, /source = ~\/\.config\/hypr\/monitors\.conf/);
      assert.equal((hyprland.match(/OPENPETS:OMARCHY_SOURCE:START/g) ?? []).length, 1);
      assert.equal(readFileSync(value.rules, "utf8"), buildOmarchyHyprlandConfig());
      assert.match(readFileSync(value.autostart, "utf8"), /OPENPETS_ALLOW_WAYLAND=1 .* --ozone-platform=wayland/);
      const waybar = readFileSync(value.waybar, "utf8");
      assert.match(waybar, /Preserve user modules and comments/);
      assert.match(waybar, /custom\/voicebox/);
      assert.match(waybar, /custom\/openpets/);
      assert.match(readFileSync(value.helper, "utf8"), /status\.subscribe/);
      const walker = readFileSync(value.walker, "utf8");
      assert.match(walker, /name = "openpets"/);
      assert.match(walker, /Open Control Center/);
      assert.match(walker, /--toggle-default-pet-paused/);
      assert.match(walker, /OPENPETS_ALLOW_WAYLAND=1/);
      assert.match(waybar, /OPENPETS_ALLOW_WAYLAND=1/);

      const repeated = runOmarchySetupAction("install", value.options);
      assert.equal(repeated.ok, false);
      assert.equal(repeated.changed, false);
      assert.equal((readFileSync(value.hyprland, "utf8").match(/OPENPETS:OMARCHY_SOURCE:START/g) ?? []).length, 1);
    } finally { rmSync(value.home, { recursive: true, force: true }); }
  });

  it("repairs drift only when ownership markers remain valid", () => {
    const value = fixture();
    try {
      assert.equal(runOmarchySetupAction("install", value.options).ok, true);
      writeFileSync(value.rules, readFileSync(value.rules, "utf8").replace("no_blur on", "no_blur off"));
      const drift = getOmarchySetupStatus(value.options);
      assert.equal(drift.state, "needs_repair");
      assert.equal(drift.canRepair, true);
      const repaired = runOmarchySetupAction("repair", value.options);
      assert.equal(repaired.ok, true);
      assert.equal(repaired.status.state, "installed");
      assert.equal(readFileSync(value.rules, "utf8"), buildOmarchyHyprlandConfig());
    } finally { rmSync(value.home, { recursive: true, force: true }); }
  });

  it("migrates exact inline OpenPets rules without leaving duplicates", () => {
    const value = fixture();
    try {
      writeFileSync(value.hyprland, `${readFileSync(value.hyprland, "utf8")}\n${buildOmarchyHyprlandConfig().split("\n").filter((line) => line.startsWith("windowrule =")).join("\n")}\n`);
      assert.equal(runOmarchySetupAction("install", value.options).ok, true);
      const hyprland = readFileSync(value.hyprland, "utf8");
      assert.equal((hyprland.match(/match:class open-pets-desktop/g) ?? []).length, 0);
      assert.equal((readFileSync(value.rules, "utf8").match(/match:class open-pets-desktop/g) ?? []).length, 7);
    } finally { rmSync(value.home, { recursive: true, force: true }); }
  });

  it("refuses unmanaged collisions without changing them", () => {
    const value = fixture();
    try {
      writeFileSync(value.rules, "# User-owned OpenPets rules\n");
      const status = getOmarchySetupStatus(value.options);
      assert.equal(status.state, "conflict");
      assert.equal(status.canInstall, false);
      const result = runOmarchySetupAction("install", value.options);
      assert.equal(result.ok, false);
      assert.equal(readFileSync(value.rules, "utf8"), "# User-owned OpenPets rules\n");
    } finally { rmSync(value.home, { recursive: true, force: true }); }
  });

  it("refuses an unmanaged Waybar module without changing user configuration", () => {
    const value = fixture();
    try {
      const custom = `{
  "modules-center": ["clock", "custom/openpets"],
  "custom/openpets": { "exec": "user-command" }
}\n`;
      writeFileSync(value.waybar, custom);
      const status = getOmarchySetupStatus(value.options);
      assert.equal(status.state, "conflict");
      assert.equal(runOmarchySetupAction("install", value.options).ok, false);
      assert.equal(readFileSync(value.waybar, "utf8"), custom);
    } finally { rmSync(value.home, { recursive: true, force: true }); }
  });

  it("refuses an unmanaged Walker menu without changing it", () => {
    const value = fixture();
    try {
      mkdirSync(join(value.home, ".config", "elephant", "menus"), { recursive: true });
      writeFileSync(value.walker, "name = \"user-openpets\"\n");
      assert.equal(getOmarchySetupStatus(value.options).state, "conflict");
      assert.equal(runOmarchySetupAction("install", value.options).ok, false);
      assert.equal(readFileSync(value.walker, "utf8"), "name = \"user-openpets\"\n");
    } finally { rmSync(value.home, { recursive: true, force: true }); }
  });

  it("removes only managed artifacts and preserves unrelated configuration", () => {
    const value = fixture();
    try {
      assert.equal(runOmarchySetupAction("install", value.options).ok, true);
      const result = runOmarchySetupAction("remove", value.options);
      assert.equal(result.ok, true);
      assert.equal(result.status.state, "not_installed");
      const hyprland = readFileSync(value.hyprland, "utf8");
      assert.match(hyprland, /# User configuration/);
      assert.doesNotMatch(hyprland, /OPENPETS:OMARCHY_SOURCE/);
      const waybar = readFileSync(value.waybar, "utf8");
      assert.match(waybar, /custom\/voicebox/);
      assert.doesNotMatch(waybar, /custom\/openpets/);
      assert.equal(getOmarchySetupStatus(value.options).artifacts.walkerMenu.state, "missing");
    } finally { rmSync(value.home, { recursive: true, force: true }); }
  });

  it("escapes desktop entry executable arguments without a shell", () => {
    const desktop = buildOmarchyAutostart('/opt/Open Pets/`special`$app"/openpets');
    assert.match(desktop, /^Exec=\/usr\/bin\/env OPENPETS_ALLOW_WAYLAND=1 "/m);
    assert.match(desktop, /\\`special\\`\\\$app\\"/);
    assert.doesNotMatch(desktop, /sh -c|bash -c/);
    assert.throws(() => buildOmarchyAutostart("relative/openpets"));
    assert.throws(() => buildOmarchyAutostart("/opt/openpets\nExec=bad"));
  });

  it("stays unsupported outside a packaged Omarchy Linux app", () => {
    const value = fixture();
    try {
      const status = getOmarchySetupStatus({ ...value.options, packaged: false });
      assert.equal(status.state, "unsupported");
      assert.equal(status.canInstall, false);
    } finally { rmSync(value.home, { recursive: true, force: true }); }
  });

  it("ships a standalone Waybar helper that reports offline safely", () => {
    const value = fixture();
    try {
      assert.equal(runOmarchySetupAction("install", value.options).ok, true);
      const child = spawnSync(process.execPath, [value.helper], { encoding: "utf8", env: { ...process.env, HOME: value.home, XDG_CONFIG_HOME: join(value.home, ".config"), XDG_RUNTIME_DIR: join(value.home, "missing-runtime") } });
      assert.equal(child.status, 0);
      assert.deepEqual(JSON.parse(child.stdout.trim()), { text: "Pets", tooltip: "OpenPets is not running", class: "offline" });
      assert.equal(child.stderr, "");
    } finally { rmSync(value.home, { recursive: true, force: true }); }
  });
});
