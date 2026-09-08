# Omarchy Integration

OpenPets should feel native on Omarchy rather than merely running as an
Electron application under Hyprland. This roadmap covers reliable native
Wayland startup, managed shell setup, context-aware pet behavior, safe Omarchy
actions, and visual theme synchronization.

The integration is an OpenPets product feature for Omarchy users. Local config
customizations are useful prototypes, but shipped behavior must be detectable,
reversible, least-privileged, and maintainable across Omarchy updates.

## Design boundaries

- Keep compositor, process, and filesystem authority in the Electron main
  process. Renderers receive normalized state through narrow preload APIs.
- Never expose arbitrary process execution to plugins. Omarchy actions use a
  fixed host-owned executable and argument allowlist.
- Read only privacy-safe compositor state such as workspace ID, active monitor,
  fullscreen state, and special-workspace state. Do not collect window titles,
  keystrokes, clipboard contents, or screen contents.
- Manage only user configuration under `~/.config/`. Never modify Omarchy's
  source under `~/.local/share/omarchy/`.
- Every managed edit is atomic, marked, idempotent, repairable, and removable
  without changing unrelated user configuration.
- Treat Omarchy and Hyprland versions as detected capabilities rather than
  assumptions. Unsupported environments degrade to normal OpenPets behavior.

## Architecture

The trusted desktop host owns a small Omarchy adapter. Omarchy hooks, the
Hyprland event socket, validated theme colors, and allowlisted user actions enter
through that adapter and become normalized shell events or capabilities.

```text
Omarchy hooks ---------+
Hyprland event IPC ----+--> Omarchy adapter --> normalized shell events
theme colors ----------+                           |-- pet behavior
allowlisted actions ---+                           |-- Waybar status
                                                   `-- Control Center
```

The adapter extends the existing Linux/Hyprland boundary in
`apps/desktop/src/window-position.ts`; it does not grant compositor access to
plugin hosts or renderers.

## Roadmap

### Current implementation

The Integrations page now detects packaged OpenPets builds running on Omarchy
and offers managed Install, Repair, Doctor, and Remove actions. The initial
managed scope is deliberately narrow:

- `~/.config/hypr/openpets.conf` contains the transparent, floating, pinned
  OpenPets rules used by Omarchy's current Hyprland compatibility config.
- A marked source block in `~/.config/hypr/hyprland.conf` loads that dedicated
  file while preserving unrelated configuration.
- `~/.config/autostart/openpets.desktop` launches the stable packaged executable
  with native Wayland enabled. AppImage launches prefer the stable `APPIMAGE`
  path over Electron's temporary mounted executable.
- `~/.config/waybar/config.jsonc` receives a JSONC-aware, ownership-marked
  `custom/openpets` module without replacing comments or unrelated modules.
- `~/.config/OpenPets/waybar.cjs` is a standalone, marker-owned status helper. It
  runs under the packaged Electron binary in Node mode and subscribes to the
  authenticated local IPC status stream.
- `~/.config/elephant/menus/openpets.toml` adds a dedicated Walker provider with
  fixed actions for Control Center, visibility, and pause. It does not enable
  desktop-entry actions globally or modify Walker's provider configuration.

All three artifacts have explicit ownership markers. Existing unmanaged files,
duplicate or malformed markers, symlinks, non-regular files, and oversized files
are reported as conflicts or errors rather than overwritten. Writes use
same-directory temporary files and unique backups; removal touches only safely
owned content. Exact OpenPets rules previously added inline are migrated into the
dedicated include during Install so they are not applied twice. The generic Linux
launch-at-login setting remains unsupported so it cannot drift this managed setup
independently.

### Phase 0: Linux reliability and diagnostics

- Diagnose Electron GPU/EGL failures before adding more startup integration.
- Record sanitized startup backend and GPU-process exit information in
  `openpets.log`.
- Show a read-only Omarchy/Linux environment diagnostic in Control Center.
- Verify native Wayland startup, transparency, movement, restart, and autostart.
- Keep the documented Hyprland version and rules validated against current
  Omarchy releases.

### Phase 1: Managed setup

- Detect Omarchy, Hyprland, Wayland, and relevant versions.
- Add Install, Repair, Doctor, and Remove actions to an Omarchy integration card.
- Manage a dedicated Hyprland include, a marked source directive, Omarchy hooks,
  UWSM-aware autostart, and an optional Waybar module.
- Report drift without silently overwriting user changes.

The first three bullets are implemented for Hyprland rules and autostart. Omarchy
hooks remain future Phase 1 work; the Waybar module is now part of managed setup.

### Phase 2: Native shell presence

- Add a Waybar module for application health, pet visibility, and active agent
  count with actions for Control Center and pet state.
- Add Walker-visible desktop actions for Control Center, show/hide, pause/resume,
  logs, and integration diagnostics.
- Prefer event-driven status updates over periodic process polling.

The initial Waybar presence is implemented. It displays offline, paused,
active-agent, visible-pet, and hidden-pet states; left click opens Control Center,
right click toggles default-pet pause, and middle click toggles visibility. The
helper holds one authenticated IPC subscription while connected. Waybar's
bounded restart interval is only an offline/crash recovery mechanism, not state
polling. Walker actions for Control Center, pause, and visibility are available
through Walker's provider list or directly with
`omarchy launch walker -m menus:openpets`; logs and Doctor actions remain future
work.

### Phase 3: Context-aware companion

- Subscribe to Hyprland's event socket with bounded parsing and reconnection.
- Optionally follow the active monitor and hide during fullscreen or presentation
  mode.
- Pause or quiet the companion while locked or idle.
- Normalize low-battery, connectivity, display, theme, boot, and update events.
- Use Omarchy hooks only where Electron or Hyprland do not already provide the
  event reliably.

The first context-aware slice is implemented for the default pet. Two
disabled-by-default settings appear on supported packaged Omarchy/native-Wayland
installations: hide the default pet while the focused workspace is fullscreen,
and follow the focused monitor. Fullscreen hiding is temporary and never changes
the user's launch/visibility preference. Monitor following restores the saved
per-monitor position, or uses a safe bottom-right position on a monitor not seen
before. Agent pets remain governed by leases and terminal confinement, and
plugin-spawned pets retain plugin-owned visibility and movement semantics.

The trusted main process connects to Hyprland's event socket with bounded line
parsing and capped reconnect backoff. Allowlisted events are treated only as
resync signals; bounded `monitors` and `activeworkspace` snapshots are reduced to
focused-monitor geometry and a fullscreen flag. Window titles and raw event
payloads are neither retained nor exposed to renderers.

### Phase 4: System command companion

- Add an Omarchy submenu to the pet's context menu.
- Support fixed actions such as notification silencing, night light, idle lock,
  wallpaper cycling, theme selection, reminders, and screenshots.
- Execute exact binaries and arguments without shell interpolation and only from
  explicit user gestures.

### Phase 5: Visual theme synchronization

- Parse a bounded subset of the active Omarchy `colors.toml` into OpenPets design
  tokens.
- Apply validated colors to Control Center, bubbles, menus, and status surfaces.
- Refresh from the `theme-set` hook or a bounded file watcher.
- Reject malformed colors and preserve readable fallback contrast. Never import
  arbitrary theme CSS into an OpenPets renderer.

## First vertical slice

The first implementation sequence is:

1. Omarchy detection and a read-only environment diagnostic.
2. Sanitized startup and GPU child-process diagnostics.
3. Managed Hyprland rules and UWSM-aware autostart.
4. Waybar status and Control Center action.
5. Fullscreen auto-hide and active-monitor following. (Implemented for the default pet.)
6. Theme synchronization, then the remaining Omarchy commands and hooks.

## Validation

- Installation, repair, and removal preserve unrelated config and are
  idempotent.
- System actions map to fixed argument vectors without shell interpolation.
- Malformed compositor events and theme files cannot crash the app.
- The Hyprland event connection recovers after compositor reloads.
- Theme parsing rejects invalid colors and maintains readable contrast.
- `hyprctl reload` and `hyprctl configerrors` remain clean on supported versions.
- Native Wayland startup and pet movement survive application and compositor
  restarts.

See [desktop.md](desktop.md) for the Electron process and Linux backend model,
[wayland.md](wayland.md) for current compositor behavior, and
[testing-and-validation.md](testing-and-validation.md) for repository quality
gates.
