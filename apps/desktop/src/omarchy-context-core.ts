export interface HyprlandMonitorContext {
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
}

export interface OmarchyContextSnapshot {
  readonly activeMonitor: HyprlandMonitorContext | null;
  readonly fullscreen: boolean;
}

const relevantEvents = new Set(["focusedmon", "workspace", "workspacev2", "fullscreen", "monitoradded", "monitoraddedv2", "monitorremoved"]);

export function isRelevantHyprlandEvent(line: string): boolean {
  const separator = line.indexOf(">>");
  if (separator <= 0 || line.length > 8_192) return false;
  return relevantEvents.has(line.slice(0, separator));
}

export function parseHyprlandContext(monitorsValue: unknown, workspaceValue: unknown): OmarchyContextSnapshot {
  const monitors = Array.isArray(monitorsValue) ? monitorsValue : [];
  const focused = monitors.find((value) => isRecord(value) && value.focused === true);
  const activeMonitor = parseMonitor(focused);
  const fullscreen = isRecord(workspaceValue) && workspaceValue.hasfullscreen === true;
  return { activeMonitor, fullscreen };
}

export function getHyprlandMonitorCenter(monitor: HyprlandMonitorContext): { x: number; y: number } | null {
  const logicalWidth = monitor.width / monitor.scale;
  const logicalHeight = monitor.height / monitor.scale;
  if (![logicalWidth, logicalHeight, monitor.x, monitor.y].every(Number.isFinite) || logicalWidth <= 0 || logicalHeight <= 0) return null;
  return { x: Math.round(monitor.x + logicalWidth / 2), y: Math.round(monitor.y + logicalHeight / 2) };
}

export function shouldShowDefaultPetInContext(userWantsVisible: boolean, fullscreenSuppressed: boolean): boolean {
  return userWantsVisible && !fullscreenSuppressed;
}

function parseMonitor(value: unknown): HyprlandMonitorContext | null {
  if (!isRecord(value) || typeof value.name !== "string" || !value.name || value.name.length > 128) return null;
  const numbers = [value.x, value.y, value.width, value.height, value.scale];
  if (!numbers.every((item) => typeof item === "number" && Number.isFinite(item))) return null;
  const [x, y, width, height, scale] = numbers as number[];
  if (width <= 0 || height <= 0 || scale <= 0 || scale > 8) return null;
  return { name: value.name, x, y, width, height, scale };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
