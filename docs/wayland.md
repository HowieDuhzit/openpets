# Linux Wayland drag notes

OpenPets supports pet dragging on Linux Wayland by using Electron/Chromium's
native draggable region path for the visible pet sprite. This lets the compositor
move the window with `xdg_toplevel.move` instead of relying on manual
`BrowserWindow.setBounds()` calls from renderer mouse coordinates.

## Why manual dragging is not reliable

The normal OpenPets drag path tracks renderer `screenX/screenY` and applies
window bounds in the main process. That works on platforms where Electron can
read and set stable global window coordinates. On KDE Plasma Wayland, the pet
receives mouse events, but compositor-managed global positioning makes the manual
`setBounds()` loop unreliable.

Source inspection confirmed the expected Wayland path:

- Electron `v42.0.0` maps draggable regions to Chromium non-client hit testing.
- Chromium's Wayland toplevel window sends compositor-managed movement requests.
- KWin accepts move requests via `XdgToplevelInterface::moveRequested` and starts
  interactive move/resize from a valid pointer serial.

## Accepted Wayland trade-offs

Using native draggable regions fixes the important failure: the pet can be moved
on KDE Wayland. It has two accepted limitations:

- The pet sprite does not receive normal drag mouse events while the compositor
  owns the move, so drag-time sprite animation is not available.
- Right-click on the draggable sprite region is handled as non-client/system
  input by Electron/KWin. We tried intercepting Electron's Linux
  `system-context-menu` event and showing the OpenPets menu, but the menu did not
  appear reliably in the KDE Wayland VM. Treat right-click on the sprite as a
  known Wayland limitation.

Speech bubbles and other non-drag UI remain regular client content. Emoji/status
glyph rendering is handled by the bundled `NotoColorEmoji.ttf`, so fresh Linux
installs do not depend on system emoji fonts.

Passive pet windows are created as non-focusable on Linux and are shown inactive,
so the transparent overlay should not take keyboard focus when it appears or
re-assert focus during the session. Pet windows temporarily opt back into
focusability when the rendered plugin bubble includes an inline input/select,
because those controls need keyboard focus after the user clicks them. This
addresses the focus-stealing class of issues on Wayland compositors such as Niri,
without breaking plugin bubbles that need typed input, but it does not change the
accepted native Wayland limitations around cross-workspace stickiness or
compositor-controlled window placement.

## Hyprland native Wayland setup

OpenPets defaults to XWayland on Linux because that backend permits the window
positioning and z-order operations used by pet motion. On Hyprland, an XWayland
pet may not appear on some systems. Native Wayland can be enabled explicitly by
launching OpenPets with `OPENPETS_ALLOW_WAYLAND=1` and
`--ozone-platform=wayland`. For a desktop entry, prefix its `Exec` command with
the environment variable and append the Ozone argument.

Hyprland themes may blur transparent windows by default. That makes the pet's
otherwise transparent surface appear as a translucent rectangle. Match the
OpenPets window class in the user Hyprland config and disable compositor blur,
shadow, and decorations:

```ini
windowrule = decorate off, match:class open-pets-desktop
windowrule = border_size 0, match:class open-pets-desktop
windowrule = rounding 0, match:class open-pets-desktop
windowrule = no_shadow on, match:class open-pets-desktop
windowrule = no_blur on, match:class open-pets-desktop
windowrule = float on, match:class open-pets-desktop
windowrule = pin on, match:class open-pets-desktop
```

This syntax is validated against Hyprland 0.56. After editing the config, run
`hyprctl reload` and `hyprctl configerrors`; the latter should produce no
output. Restart OpenPets so static window rules are applied to a newly created
pet window.

Control Center → Integrations reports whether the running app is using X11,
XWayland, or native Wayland and whether trusted Hyprland IPC positioning is
active. Use that runtime diagnostic instead of inferring the app backend from
`XDG_SESSION_TYPE` alone: OpenPets can intentionally use XWayland inside a
Wayland login session.

Packaged Omarchy users can install these rules from Control Center → Integrations
instead of editing them manually. OpenPets writes the rules to a dedicated
`~/.config/hypr/openpets.conf`, adds one marked source block to the user's
`hyprland.conf`, and creates a native-Wayland autostart entry. Repair and removal
operate only on marker-owned content and retain unique backups of changed files.
The managed file uses the compatibility configuration format shipped by Omarchy
3.8.4; future Lua-format migration must be capability-detected rather than
silently changing existing Omarchy configurations.

Keep GPU acceleration enabled when using this native Wayland path. A local
source launch can be validated with:

```bash
OPENPETS_ALLOW_WAYLAND=1 pnpm --dir apps/desktop exec electron --ozone-platform=wayland .
```

On hybrid-GPU systems, Chromium may crash its GPU process when OpenPets is
forced through XWayland even though the native Wayland renderer is stable. If
the app appears in the taskbar but no pet or Control Center is painted, check
the log for `GPU process exited unexpectedly`, confirm the process is using
`--ozone-platform=wayland`, and apply the rules above. `--disable-gpu` is useful
only as a diagnostic fallback; it is not required for normal native Wayland
operation.

When this mode is active on Hyprland, the desktop host routes trusted position
writes through Hyprland IPC instead of Electron's ignored Wayland
`setPosition()` call. Walkabout, gravity, follow-cursor, pet-state coordinates,
reclamping, and Airmail delivery movement therefore continue to work. Writes
are matched to an OpenPets window from the current process and use numeric
coordinates generated by the host; plugins do not receive shell or compositor
IPC access.

Native Wayland remains opt-in. On compositors other than Hyprland, global
placement and stacking stay compositor-controlled and autonomous movement is
unsupported. Hyprland also retains the documented native-drag right-click
limitation, and pinning/transparent rendering still depend on the window rules
above.

On a packaged Omarchy installation, Settings → Movement additionally offers
disabled-by-default fullscreen hiding and active-monitor following for the
default pet. The host listens to Hyprland events as invalidation signals and
queries bounded monitor/workspace state after startup and compositor reloads.
Fullscreen suppression preserves explicit user visibility, while monitor
following restores the pet's saved position for the focused display. Lease-bound
agent pets and plugin-spawned pets are not moved or hidden by these settings.

## Reproduction and validation notes

The KDE Wayland repro VM lives at:

```text
/Volumes/external/vmware/ubuntu24-kde-wayland
```

Validated behavior in KDE Plasma Wayland:

- Default/manual `setBounds()` drag path: pet appears, but dragging is unreliable.
- Forced X11/XWayland inside a Plasma Wayland session: Electron starts, but the
  pet was not a usable workaround in the VM.
- Native draggable sprite region on real Wayland: pet dragging works; drag-time
  sprite animation and right-click menu on the sprite do not.

Do not document a stronger Wayland workaround unless it has been verified in the
VM. For deeper source inspection, the relevant local read-only clones are listed
in `AGENTS.md` under "Cloned Dependency Source".
