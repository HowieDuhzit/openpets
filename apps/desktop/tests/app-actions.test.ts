import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseOpenPetsDesktopAction } from "../src/app-actions-core.js";

describe("OpenPets desktop action arguments", () => {
  it("accepts only fixed Waybar actions and Control Center routes", () => {
    assert.deepEqual(parseOpenPetsDesktopAction(["openpets", "--open-control-center=integrations"]), { type: "open-control-center", route: "integrations" });
    assert.deepEqual(parseOpenPetsDesktopAction(["--toggle-default-pet"]), { type: "toggle-default-pet" });
    assert.deepEqual(parseOpenPetsDesktopAction(["--toggle-default-pet-paused"]), { type: "toggle-default-pet-paused" });
    assert.equal(parseOpenPetsDesktopAction(["--open-control-center=secrets"]), null);
    assert.equal(parseOpenPetsDesktopAction(["--run=rm", "--url=https://example.com"]), null);
  });

  it("rejects conflicting actions while ignoring Electron arguments", () => {
    assert.deepEqual(parseOpenPetsDesktopAction(["--ozone-platform=wayland", "--open-control-center"]), { type: "open-control-center", route: "dashboard" });
    assert.equal(parseOpenPetsDesktopAction(["--toggle-default-pet", "--toggle-default-pet-paused"]), null);
  });
});
