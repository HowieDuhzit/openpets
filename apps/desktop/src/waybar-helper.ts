export const waybarHelperStart = "// OPENPETS:WAYBAR_HELPER:START";
export const waybarHelperEnd = "// OPENPETS:WAYBAR_HELPER:END";

export function buildWaybarHelper(): string {
  return `${waybarHelperStart}
"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

function output(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
function offline() { output({ text: "Pets", tooltip: "OpenPets is not running", class: "offline" }); }
function format(status) {
  const agents = Number.isInteger(status.activeAgentCount) && status.activeAgentCount > 0 ? status.activeAgentCount : 0;
  const pet = status.defaultPet && typeof status.defaultPet.displayName === "string" ? status.defaultPet.displayName.replace(/[\\r\\n\\0]/g, " ").slice(0, 80) : "Default pet";
  const state = status.paused ? "paused" : agents > 0 ? "agents" : status.defaultPetVisible ? "pet-visible" : "pet-hidden";
  const text = agents > 0 ? "Pets " + agents : "Pets";
  const tooltip = "OpenPets " + (typeof status.appVersion === "string" ? status.appVersion : "") + "\\nDefault pet: " + pet + "\\nPet: " + (status.defaultPetVisible ? "visible" : "hidden") + "\\nAgents: " + agents + " active";
  return { text, tooltip, class: state };
}
function discoveryPaths() {
  const paths = [];
  if (process.env.XDG_RUNTIME_DIR) paths.push(path.join(process.env.XDG_RUNTIME_DIR, "openpets", "ipc.json"));
  paths.push(path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "OpenPets", "runtime", "ipc.json"));
  return paths;
}
function readDiscovery() {
  const file = discoveryPaths().find((candidate) => fs.existsSync(candidate));
  if (!file) throw new Error("OpenPets discovery is unavailable");
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw new Error("OpenPets discovery is invalid");
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!value || typeof value.endpoint !== "string" || typeof value.token !== "string" || value.token.length < 32 || value.token.length > 256) throw new Error("OpenPets discovery is invalid");
  return value;
}
function connect() {
  let discovery;
  try { discovery = readDiscovery(); } catch { offline(); return; }
  const socket = discovery.endpoint.startsWith("tcp://") ? (() => { const url = new URL(discovery.endpoint); if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "[::1]") throw new Error("Unsafe endpoint"); return net.createConnection({ host: url.hostname.replace(/^\\[|\\]$/g, ""), port: Number(url.port) }); })() : net.createConnection(discovery.endpoint);
  const id = crypto.randomUUID();
  const request = JSON.stringify({ id, version: 1, token: discovery.token, method: "status.subscribe", params: {} }) + "\\n";
  let buffer = "";
  let emittedOffline = false;
  const stop = () => { if (!emittedOffline) { emittedOffline = true; offline(); } setTimeout(() => process.exit(0), 25); };
  socket.setEncoding("utf8");
  socket.setTimeout(3000, () => socket.destroy());
  socket.once("connect", () => { socket.setTimeout(0); socket.write(request); });
  socket.on("data", (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer, "utf8") > 16384) { socket.destroy(); return; }
    for (;;) {
      const newline = buffer.indexOf("\\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      try { const response = JSON.parse(line); if (response && response.ok === true && response.id === id && response.result && response.result.appRunning === true) output(format(response.result)); else socket.destroy(); } catch { socket.destroy(); }
    }
  });
  socket.once("error", stop);
  socket.once("end", stop);
  socket.once("close", stop);
  process.once("SIGTERM", () => { socket.end(); process.exit(0); });
  process.once("SIGINT", () => { socket.end(); process.exit(0); });
}
try { connect(); } catch { offline(); }
${waybarHelperEnd}
`;
}

export function shellQuote(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new Error("Command argument contains invalid control characters.");
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
