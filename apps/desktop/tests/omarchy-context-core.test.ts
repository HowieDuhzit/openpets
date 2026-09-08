import assert from "node:assert/strict";

import { getHyprlandMonitorCenter, isRelevantHyprlandEvent, parseHyprlandContext, shouldShowDefaultPetInContext } from "../src/omarchy-context-core.js";

assert.equal(isRelevantHyprlandEvent("fullscreen>>1"), true);
assert.equal(isRelevantHyprlandEvent("focusedmon>>DP-1,2"), true);
assert.equal(isRelevantHyprlandEvent("activewindow>>secret title"), false, "window metadata must not trigger context processing");
assert.equal(isRelevantHyprlandEvent(`fullscreen>>${"x".repeat(8192)}`), false, "oversized events must be ignored");

const snapshot = parseHyprlandContext([
  { name: "DP-1", x: -1920, y: 0, width: 1920, height: 1080, scale: 1, focused: false },
  { name: "eDP-1", x: 0, y: 0, width: 3840, height: 2160, scale: 2, focused: true, description: "not retained" },
], { hasfullscreen: true, lastwindowtitle: "not retained" });

assert.deepEqual(snapshot, {
  activeMonitor: { name: "eDP-1", x: 0, y: 0, width: 3840, height: 2160, scale: 2 },
  fullscreen: true,
});
assert.deepEqual(getHyprlandMonitorCenter(snapshot.activeMonitor!), { x: 960, y: 540 });
assert.deepEqual(parseHyprlandContext([{ focused: true, name: "bad", x: 0, y: 0, width: 1, height: 1, scale: 0 }], {}), { activeMonitor: null, fullscreen: false });
assert.equal(shouldShowDefaultPetInContext(true, true), false, "fullscreen must suppress without changing user intent");
assert.equal(shouldShowDefaultPetInContext(true, false), true, "leaving fullscreen restores a user-visible pet");
assert.equal(shouldShowDefaultPetInContext(false, false), false, "leaving fullscreen must not resurrect a user-hidden pet");

console.log("Omarchy context parsing validation passed.");
