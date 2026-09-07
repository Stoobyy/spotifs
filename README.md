# Now Playing

A full-screen now-playing display for Spotify on Windows. Lives in the system
tray; click the tray icon and the current track fills the screen.

No Spotify login, no developer account, no modifications to the Spotify client.
It reads the same system media session that powers the Windows volume-key
overlay, so it works the moment Spotify is playing.

## Requirements

- Windows 10 or 11
- Node.js 18+ (only to install and run; not needed once packaged)
- Spotify desktop app

## Run it

```powershell
cd D:\spotifs
npm install
npm start
```

The app starts hidden — look for the tray icon (you may need to expand the
hidden-icons arrow next to the clock, and can drag it onto the taskbar to keep
it visible).

## Build an installer

```powershell
npm run dist
```

Produces an NSIS installer under `dist\`.

## Using it

| Action | How |
| --- | --- |
| Open the full-screen view | Click the tray icon |
| Close it | `Esc`, or the ✕ top-right |
| Play / pause | `Space`, or the centre button |
| Next / previous | `N` / `P`, or the side buttons |
| Seek ±5s | `←` / `→` |
| Scrub | Drag the progress bar |

Right-click the tray icon for the display picker (multi-monitor), the
high-resolution artwork toggle, and "Start with Windows".

The clock, controls and close button fade out after ~3 seconds of stillness and
come back on any mouse movement.

## How it works

```
Spotify  ──▶  Windows System Media Transport Controls
                          │
              smtc-bridge.ps1  (long-lived PowerShell + WinRT)
                          │  NDJSON over stdout / commands over stdin
                   Electron main process
                          │  IPC
                    Renderer (the UI)
```

- **`src/main/smtc-bridge.ps1`** — one persistent PowerShell process that polls
  `GlobalSystemMediaTransportControlsSessionManager`, prefers the Spotify
  session, extracts the cover thumbnail, and emits a JSON line whenever
  something changes. Playback commands come back in over stdin. Deliberately no
  native Node addon, so `npm install` can never fail on a compiler.
- **`src/main/artwork.js`** — Spotify only publishes a ~300px thumbnail, which
  looks soft at full screen, so covers are quietly upgraded via Apple's public
  iTunes Search API and cached on disk. Fails silently back to the thumbnail;
  toggle it off in the tray menu.
- **`src/main/palette.js`** — pulls one accent colour from the cover in the main
  process (a `file://` canvas in the renderer would be tainted), with saturation
  and lightness clamped so a loud cover can't blow out the interface.
- **`src/renderer/`** — the display. Position is extrapolated between session
  updates so the progress bar moves smoothly rather than stepping once a second.

## If something looks wrong

**Tray icon appears but the screen says "Nothing playing".** Windows only
exposes a session while something is loaded — press play in Spotify once. If it
still doesn't appear, check that Spotify shows up in the volume-key overlay at
the top of the screen; if it doesn't, the OS isn't seeing it either.

**Seeking does nothing.** Some Spotify builds don't expose position control
through the system session. Play/pause and skip use a different channel and
should keep working.

**Nothing happens on `npm start`.** Run it from a terminal so you can see the
output — `[smtc]` lines report PowerShell-side problems. The script is invoked
with `-ExecutionPolicy Bypass`, so a locked-down execution policy shouldn't
block it, but a managed machine may still refuse.

**Artwork is soft.** Turn on "High-resolution artwork" in the tray menu; it
needs a working internet connection and only matches albums that exist in the
iTunes catalogue.

## Possible next step

If the system media session turns out to be too limited — no per-track duration
on some builds, no seek, no shuffle/repeat state — the fallback is the Spotify
Web API, which means an OAuth login but exposes the full player state. The
renderer wouldn't change; only the source feeding `player:state` would.
