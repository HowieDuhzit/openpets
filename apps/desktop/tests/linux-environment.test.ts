import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { classifyLinuxEnvironment, readOmarchyVersion } from "../src/linux-environment.js";

describe("Linux environment diagnostic", () => {
  it("is omitted on non-Linux platforms", () => {
    assert.equal(classifyLinuxEnvironment({ platform: "darwin", env: {}, ozonePlatform: "", hyprlandPositioningAvailable: false }), undefined);
  });

  it("reports forced X11 in a Wayland session as supported XWayland", () => {
    const result = classifyLinuxEnvironment({ platform: "linux", env: { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-1" }, ozonePlatform: "x11", hyprlandPositioningAvailable: false });
    assert.equal(result?.displayBackend, "xwayland");
    assert.equal(result?.positioning, "electron");
    assert.equal(result?.state, "ready");
  });

  it("reports native Wayland without a compositor adapter as needing attention", () => {
    const result = classifyLinuxEnvironment({ platform: "linux", env: { XDG_SESSION_TYPE: "wayland" }, ozonePlatform: "wayland", hyprlandPositioningAvailable: false });
    assert.equal(result?.positioning, "unsupported");
    assert.equal(result?.state, "attention");
    assert.equal(result?.issue, "native-wayland-positioning-unsupported");
  });

  it("reports native Hyprland positioning as ready", () => {
    const result = classifyLinuxEnvironment({ platform: "linux", env: { XDG_SESSION_TYPE: "wayland", HYPRLAND_INSTANCE_SIGNATURE: "test" }, ozonePlatform: "wayland", hyprlandPositioningAvailable: true });
    assert.equal(result?.compositor, "hyprland");
    assert.equal(result?.positioning, "hyprland-ipc");
    assert.equal(result?.state, "ready");
  });

  it("detects Omarchy only from a bounded valid canonical version marker", () => {
    const home = mkdtempSync(join(tmpdir(), "openpets-omarchy-"));
    const root = join(home, ".local", "share", "omarchy");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "version"), "3.8.4\n");
    assert.equal(readOmarchyVersion(home), "3.8.4");

    writeFileSync(join(root, "version"), "not a version\n");
    assert.equal(readOmarchyVersion(home), undefined);
  });
});
