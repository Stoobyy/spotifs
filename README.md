# Now Playing

A full-screen now-playing display for Spotify. It lives in the system tray. Click the icon and the current track fills the screen.

Runs on Windows, macOS and Linux.

![Classic theme](docs/screenshots/classic.png)

On Windows it works with no sign-in at all. It reads the same media session that powers the volume-key overlay, so it picks up whatever Spotify is playing the moment you open it. On every platform you can connect a Spotify account instead, which gives you reliable seeking and artwork straight from Spotify.

## Themes

Four layouts. Switch between them live from Settings.

| | |
| --- | --- |
| **Classic**. Big cover, landscape. | **Lock Screen**. Date, clock, glass card. |
| ![Classic](docs/screenshots/classic.png) | ![Lock Screen](docs/screenshots/lockscreen.png) |
| **Split**. Clock left, card right. | **Dial**. Analogue clock, tall card. |
| ![Split](docs/screenshots/split.png) | ![Dial](docs/screenshots/dial.png) |

### Backgrounds

Every theme takes any of these.

| Option | What it shows |
| --- | --- |
| **Blurred cover** | The album art, zoomed and blurred. This is the default. |
| **Solid colour** | A flat colour of your choosing. |
| **Album hues** | Three soft fields of colour drawn from the cover, drifting slowly past each other. |
| **Image** | A picture of your own. |

### Fonts

Pick any font installed on your machine, or import a `.ttf`, `.otf`, `.ttc`, `.woff` or `.woff2` file. Imported fonts are copied into the app's data folder, so you can move or delete the original afterwards.

## Playback sources

| Source | Setup | What you get |
| --- | --- | --- |
| **System** | None. | Reads the Windows media session. Artwork is upgraded through the iTunes catalogue, since Windows only provides a small thumbnail. Seeking depends on the Spotify build. Windows only, and the default there. |
| **Spotify account** | Sign in once in your browser. | Reads the Spotify Web API directly. Reliable seeking, and covers straight from Spotify. Transport controls need Spotify Premium; that is a Spotify restriction. |

On macOS and Linux the Spotify account is the only source.

To connect, choose *Spotify account* in Settings or the tray menu. Spotify's consent page opens in your browser. Approve it and you are connected. The sign-in uses OAuth with PKCE and asks for only the three permissions the display needs: read playback state, modify playback state, and read the currently playing track. Tokens are stored locally and refreshed silently. *Disconnect* removes them.

## Controls

| Action | How |
| --- | --- |
| Open | Click the tray icon |
| Close | `Esc`, or the ✕ in the top right |
| Play or pause | `Space`, or the centre button |
| Next or previous | `N` or `P`, or the side buttons |
| Seek 5 seconds | `←` or `→` |
| Scrub | Drag the progress bar |

The controls and the close button fade out after a few seconds of stillness. Move the mouse and they come back. The clock stays.

## Install

You need Node.js 18 or newer to build, and the Spotify desktop app.

```sh
git clone https://github.com/Stoobyy/spotifs.git
cd spotifs
npm install
npm start
```

The app starts hidden. Look for the tray icon, or the menu bar on macOS. On GNOME the tray icon needs the AppIndicator extension.

To build an installer for your platform:

```sh
npm run dist
```

This produces an NSIS installer on Windows, a DMG on macOS, and an AppImage on Linux.
