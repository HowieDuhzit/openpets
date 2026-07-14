import assert from "node:assert/strict";

import { _setHyprlandPositioningForTesting, getWindowPosition, setWindowPosition } from "../src/window-position.js";

const commands: string[] = [];
let nativeSetPositionCalls = 0;
const window = {
  id: 7,
  isDestroyed: () => false,
  getTitle: () => "OpenPets — Default Pet [7]",
  getPosition: (): [number, number] => [40, 50],
  setPosition: () => { nativeSetPositionCalls += 1; },
} as any;

_setHyprlandPositioningForTesting(true, {
  listClients: async () => [{
    address: "0xabc123",
    pid: process.pid,
    title: "OpenPets — Default Pet [7]",
    class: "open-pets-desktop",
    initialClass: "open-pets-desktop",
    at: [40, 50],
  }],
  dispatch: async (command) => { commands.push(command); },
});

setWindowPosition(window, 120.4, 230.6);
await waitFor(() => commands.length === 1);
assert.equal(nativeSetPositionCalls, 0, "native Wayland movement bypasses Electron setPosition");
assert.equal(commands[0], "dispatch movewindowpixel exact 120 231,address:0xabc123");
assert.deepEqual(getWindowPosition(window), { x: 120, y: 231 }, "logical position follows compositor writes");

const multiWindowCommands: string[] = [];
let failFirstDispatch = true;
let listClientsCalls = 0;
const secondWindow = {
  id: 8,
  isDestroyed: () => false,
  getTitle: () => "OpenPets — Robot [8]",
  getPosition: (): [number, number] => [300, 400],
  setPosition: () => { throw new Error("native setPosition must not be used"); },
} as any;
_setHyprlandPositioningForTesting(true, {
  listClients: async () => {
    listClientsCalls += 1;
    const first = { address: "0xabc123", pid: process.pid, title: "OpenPets — Default Pet [7]", class: "open-pets-desktop", at: [120, 231] };
    const second = { address: "0xdef456", pid: process.pid, title: "OpenPets — Robot [8]", class: "open-pets-desktop", at: [300, 400] };
    return listClientsCalls === 1 ? [first] : [first, second];
  },
  dispatch: async (command) => {
    multiWindowCommands.push(command);
    if (failFirstDispatch) { failFirstDispatch = false; throw new Error("temporary IPC failure"); }
  },
});
setWindowPosition(secondWindow, 500, 600);
await waitFor(() => multiWindowCommands.length === 2);
assert.ok(multiWindowCommands.every((command) => command.endsWith("address:0xdef456")), "matches the intended window by unique title");
assert.equal(multiWindowCommands[1], "dispatch movewindowpixel exact 500 600,address:0xdef456", "retries a failed compositor write");

_setHyprlandPositioningForTesting(false);
setWindowPosition(window, 10, 20);
assert.equal(nativeSetPositionCalls, 1, "non-Hyprland backends retain Electron positioning");

_setHyprlandPositioningForTesting(null);

console.log("window-position tests passed.");

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Hyprland IPC dispatch.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
