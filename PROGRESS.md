# Progress

Last updated: 7 September 2026

## What we're building

A full-screen now-playing display for Spotify on Windows.

The app lives in the system tray. Click the tray icon and the current track
fills the screen — album art, title, artist, progress, transport controls — in a
landscape layout built for a laptop. Closing it drops back to the tray; Spotify
itself is never touched.

The starting reference was an iOS lock-screen now-playing shot: big cover, a
soft colour wash pulled from the artwork, minimal type. The brief was to keep
that mood but land it in landscape, as a real desktop surface rather than a
lock-screen imitation, and to follow Apple's design language rather than the
default "generic dark UI with a purple gradient" look.

## Decisions

| Decision | Choice | Why / what we gave up |
| --- | --- | --- |
| Now-playing data | Windows System Media Transport Controls (SMTC) | No Spotify login, no developer app, no client modification — it works the moment Spotify plays. Costs us a few things the Web API would give (see limitations). Spotify Web API stays the documented fallback. |
| Trigger surface | System tray icon | Stays out of the way; no always-on-top widget cluttering the desktop, no dependency on Spicetify being installed and surviving Spotify updates. |
| Stack | Electron | Web tech gives the fine visual control this design needs (large-radius blur, colour mixing, precise typography), and packages to a Windows installer. |
| SMTC access | Long-lived PowerShell + WinRT process | The obvious alternative — a native Node addon — is the usual reason a project like this dies on someone's machine with a node-gyp error. This way `npm install` pulls Electron and nothing else. |
| Bridge stdin | Raw `StreamReader` over `OpenStandardInput()`, never `[Console]::In` | `[Console]::In` is a `SyncTextReader`, whose `ReadLineAsync` runs *synchronously*. Using it blocked the poll loop until the parent sent a command — and the parent has nothing to say until the user presses a button, so no state ever reached the UI. |
| Window mode | Frameless window sized to the display, **not** Electron full screen | Full screen bought nothing visually — the window is already frameless — and on Windows, hiding a full-screen window left the compositor holding a black surface the user had to alt-tab out of. `resizable: false` / `thickFrame: false` additionally drop the DWM caption hairline along the top edge and Windows 11's rounded corners. Costs the window shadow and the open/close animation. |
| Background motion | Three gradient washes animated on the compositor | The Apple Music read: colour that shifts slowly enough that you notice it without catching it moving. Transform and opacity only — no blur, no `mix-blend-mode`, no JS — so frames cost GPU compositing and nothing on the CPU. The blurred cover behind them became static, which is *cheaper* than the drift it replaced, and was dropped to `opacity: 0.4` so the washes have something to read against rather than competing with a full-screen flat tone. |
| Lock screen proportions | Measured off the reference shot rather than eyeballed | Card 58% of screen width at 3.5:1, cover 82% of the card's height, title 30px. The first attempt was 45% wide at 4:1 with a 73%-height cover, which read as a thin strip instead of a glass slab. |
| Themes | One set of elements and one set of state code, rearranged per theme by a `data-theme` attribute | The lock-screen layout is a different arrangement of exactly the same title, artist, artwork, scrubber and controls. Two markup trees would have meant two of every state update; this way `app.js` never knows which theme is on. |
| Backgrounds | Four modes built from layers that already existed, switched by a `data-bg` attribute | Album hues is the existing arrangement. Solid hides the cover and washes and paints `.ambient` flat. Blurred cover brings the cover layer to full strength, zooms it to 1.85 and drops the washes. No new elements bar the image layer, and each mode reuses the vignette at a strength that suits it. Classic and Split both offer the picker; the lock screen theme is pinned to `hues` in `app.js` rather than every rule in the block having to name the themes it applies to. |
| Which wash hues are real | A bin must carry 18% of the busiest bin's weight to earn a wash; anything short of that is ignored, and missing washes are filled with neighbours 14° either side of the dominant hue | The first version took the three busiest bins with any weight at all, so a cover with a few percent of an unrelated colour promoted it to a full-screen field — the backdrop showed colours the artwork didn't. The old fallback fanned out 38° and 76°, which invented hues outright on a single-colour cover. |
| Blur radius per background | 84px for hues, 52px for blurred cover | At 1.85 zoom there is little detail left to hide, and 84px would flatten the cover back into a single tone — which is exactly what Album hues already is. The two modes have to look different to be worth having. |
| Font choice | Family name prepended to the built-in stack, never replacing it | A font that is missing a glyph — or that gets uninstalled — degrades to the default rather than to whatever the OS picks. Imported files are copied into userData so moving the original doesn't break the display. |
| Font enumeration | PowerShell `InstalledFontCollection` | Electron has no API for this. Chromium's `queryLocalFonts()` exists but needs a permission grant and a secure context; the machine already depends on PowerShell for the bridge, so this adds nothing new. |
| Background image | One picture, copied into userData, replaced rather than collected | Same bargain as an imported font: the display can't break because the original moved. A library of wallpapers would need a grid, thumbnails and a delete affordance for something the user changes about twice a year. |
| Split theme | Third `data-theme` arrangement, no new markup | The iPad lock screen is the same clock, date, cover, title, scrubber and transport again. `.meta` becomes `display: contents` so the scrubber and transport can span the full width of the card while the title sits beside the cover — the only structural thing theme 2 didn't already need. |
| Split clock tint | Accent *hue*, but fixed high saturation and lightness | The reference pulls its clock colour out of the wallpaper. The accent follows the artwork, but the palette clamps it to L 48–68 for sitting *on* a dark background, which is too dark for 260px of type over one. |
| Settings surface | A window, not a growing tray menu | Themes and a font list don't fit a context menu. The tray is back to three items — Open, Settings, Quit — and everything configurable moved into the window. |
| Artwork | SMTC thumbnail, upgraded via iTunes Search API | Spotify only publishes ~300px, which is mushy at full screen. The upgrade is best-effort and cached; the thumbnail is always the fallback. |
| Accent colour | Extracted in the main process, clamped | A `file://` canvas in the renderer would be tainted, so extraction happens in Node. Saturation and lightness are clamped into a narrow band so a loud cover can't blow the interface out. |

## What's built

```
D:\spotifs
├── package.json                  electron + electron-builder, NSIS config
├── README.md                     setup, controls, troubleshooting
├── PROGRESS.md                   this file
├── build/                        app + tray icons (.ico, .png)
└── src/
    ├── main/
    │   ├── main.js               lifecycle, tray menu, window, IPC, settings
    │   ├── smtc.js               spawns + supervises the bridge, parses NDJSON
    │   ├── smtc-bridge.ps1       WinRT poller; JSON out, commands in
    │   ├── artwork.js            hi-res cover lookup + disk cache
    │   ├── fonts.js              installed-font list, font import, @font-face
    │   ├── wallpaper.js          background-image import into userData
    │   └── palette.js            accent + wash hues from the cover
    └── renderer/
        ├── index.html            markup + inline SF-style control glyphs
        ├── styles.css            the design, both themes
        ├── app.js                state, position extrapolation, scrubbing
        ├── preload.js            context-isolated IPC surface
        ├── settings.html         settings window
        ├── settings.css          settings window design
        ├── settings.js           settings window logic
        └── settings-preload.js   settings IPC surface
```

**Data flow**

```
Spotify ──▶ Windows System Media Transport Controls
                        │
            smtc-bridge.ps1 (persistent PowerShell + WinRT)
                        │  NDJSON on stdout / commands on stdin
                 Electron main process
                        │  IPC
                  Renderer (the UI)
```

**Working features**

- Tray icon with Open, Settings and Quit. Settings persist to disk.
- Full-screen player: ambient artwork backdrop (blurred, vignetted), hero cover
  with hairline edge and drop shadow, two-line clamped title, artist, album,
  hairline scrubber, transport controls, clock.
- Background motion: three soft colour fields drawn from the cover's three
  busiest hues, drifting on 23s / 31s / 43s cycles. Those periods are prime, so
  they share no factor, the three never resynchronise, and the loop never
  becomes visible.
  Hues crossfade between tracks through `@property`-typed custom properties, and
  are unwrapped first so the interpolation takes the short way round the wheel.
- Three themes, switchable live from Settings: **Classic** (big cover,
  landscape), **Lock Screen** (centred date and large clock, transport in a
  floating glass card, after macOS) and **Split** (oversized tinted clock and
  date left, one wide glass card right, after the iPad lock screen). Same
  elements, rearranged by `data-theme`.
- Four backgrounds for Classic and Split, switchable live: the cover zoomed to
  1.85 and blurred at full strength (the default), album hues (the drifting
  washes), a solid colour chosen with a colour well, or an image of the user's
  own. Measured 21/255 mean apart from the hues mode on structured artwork, so
  the choice is visible rather than nominal.
- Background image import: `.jpg` / `.png` / `.webp` / `.gif` / `.bmp` / `.avif`,
  copied into userData and shown full-bleed under a lighter vignette than the
  cover modes use. One at a time — a new pick replaces and deletes the old copy.
  A file that disappears underneath the app drops the mode back to blurred cover
  on next launch rather than showing a black screen.
- Any installed font, or an imported `.ttf` / `.otf` / `.ttc` / `.woff` /
  `.woff2`, with a live preview in Settings. Imported files are copied into
  userData; a removed or uninstalled font falls back rather than breaking.
- Settings window (tray -> Settings): theme, background, font, clock format,
  display picker, high-resolution artwork, start with Windows. Every control writes straight
  through to the main process; there is no save button.
- Playback: play/pause, next, previous, drag-to-scrub, ±5s seek. Commands are
  applied optimistically so the UI never waits on Spotify to acknowledge.
- Keyboard: `Space`, `←`/`→`, `N`/`P`, `Esc`.
- Chrome auto-hides after ~3s of stillness (cursor included) and returns on
  movement; artwork, type, progress and the clock stay. The clock is deliberately
  outside the fading group — the fade is carried by the close button and the
  transport controls individually, not by their container.
- Per-track accent colour, crossfaded artwork and ambient layers, staggered
  text entrance on track change.
- Progress extrapolated between session updates, so the bar glides rather than
  stepping once a second.
- Empty state when nothing is playing; placeholder when a track has no cover.
- Bridge auto-restarts with backoff if PowerShell dies. Single-instance lock.
- `prefers-reduced-motion` respected — including the washes, which are stopped
  by animation *name* rather than duration, so the catch-all rule can't leave
  them looping `alternate` at 0.01ms.

## Fixed on the first live run

- **Nothing ever played.** The bridge blocked forever on its first stdin read
  (see the decisions table). It emitted `ready`, then never reached the poll.
- **Closing left a black screen.** Electron's full-screen mode; removed
  entirely rather than reordered.
- **Hairline along the top edge.** DWM painting caption colour on a frameless
  window that still carried `WS_THICKFRAME`.
- **Ascenders and descenders sheared off the title, artist and album.** `line-height: 1.08` is
  tighter than the font's natural line height (~1.33em), so the half-leading
  went negative and the ink overflowed the content box — which the
  `overflow: hidden` that `-webkit-line-clamp` requires then clipped. Fixed with
  `padding-block: 0.18em` and a matching negative margin, so the glyphs get room
  without the layout moving. Loosening the leading would have worked too, at the
  cost of the tight display setting the design wants. The first fix used 0.18em,
  which was enough for Segoe UI but not for a font with deeper metrics — an
  imported SF Pro Rounded still clipped. Now 0.34em on the title, and .artist
  and .album got the same treatment: they need `overflow: hidden` for their
  ellipsis and had no bleed room at all.
- **The washes were invisible.** Not the motion — the balance. The blurred cover
  at `opacity: 0.72` filled the screen with one flat tone, and three same-family
  washes underneath a heavy vignette had nothing to read against. The cover
  dropped to 0.4, the washes came up, and the veil was softened.

## Verified so far

- The bridge runs against live Spotify: the session is picked up, metadata and
  position arrive, and the app tracks playback.
- Tray icon, opening the player, and closing back to the tray.
- Palette extraction, unit-checked against synthetic covers with `nativeImage`
  mocked: a three-band cover returns those three hues (38 / 176 / 263), a
  single-hue cover fans out around the accent (263 / 301 / 339), a greyscale
  cover falls back to neutral. The accent is unchanged by the wash work — still
  the busiest bin.
- The washes, rendered headless at 1600x900 through the real `index.html` /
  `styles.css`: two captures 12s apart differ by mean 14/255, max 59, with 71%
  of pixels moving at least 8/255. The perceptual threshold across a large flat
  area is nearer 2-3/255, so the motion is comfortably above it. Before the
  rebalance the same measurement was imperceptible.
- The title fix, rendered with "pretty isn't pretty" and with an
  ascender/descender torture string: no clipping top or bottom, and no third
  line peeking through the new bottom padding under `-webkit-line-clamp`.
- Every JS file parses (`node --check`); the bridge parses
  (`[Parser]::ParseFile`); `package.json` is valid.
- The renderer was rendered in headless Chromium at 1600×900 using the real
  `index.html` / `styles.css` / `app.js` with mocked player state — active,
  idle (chrome hidden) and empty states all check out, and the progress bar
  ticks correctly between frames. *Predates the wash work.*

- The Split theme and the image background, rendered at 1600x900 through the
  real `index.html` / `styles.css` / `app.js` with mocked state: the layout
  matches the reference — clock and date left, cover, title, `Artist — Album`,
  full-width scrubber with the times either side and centred transport in the
  card — across all four backgrounds, plus the empty state, which keeps the
  clock and moves the message into the right half. The lock screen theme was
  rendered in the same pass with `background: 'solid'` set and correctly ignored
  it. The image loads over `file://`, which is the path the app actually uses.
- The settings window rendered against a mocked settings API: three theme tiles,
  four background tiles, and the image tile previewing the picture it selects.

## Not yet verified — needs a run on the machine

- The settings window against a real font list, and an actual font import.
- An actual image import through the file dialog, and the copy into userData.
- Themes 2 and 3 on the machine: they have been rendered headless, not run.
- The washes against real album art on the actual machine. They have been
  measured and eyeballed in a headless render with synthetic covers only.
- Whether Spotify exposes seek through the session (it varies by build).
- Transport commands beyond those exercised so far.
- The iTunes artwork upgrade end to end.
- Multi-monitor: the display picker, and reopening on the chosen screen.
- `npm run dist` packaging, and whether the unpacked `.ps1` path resolves
  correctly inside an installed build.

## Known limitations

- **Volume.** SMTC exposes play/pause/skip/seek but not Spotify's own volume —
  only the system's. In-app volume needs the Web API. This is why the current
  UI has no volume control rather than a misleading one.
- **Seek may be unavailable.** Some Spotify builds don't set
  `IsPlaybackPositionEnabled`. The scrubber attempts the seek anyway and
  degrades quietly.
- **No shuffle / repeat / queue state.** The session doesn't expose it reliably.
- **Artwork resolution** depends on the iTunes catalogue having the album and on
  a working connection; otherwise it's Spotify's ~300px thumbnail upscaled.
- **Windows only**, by design — SMTC is a Windows API.
- **Font import is checked by extension, not by content.** A renamed file will
  be accepted, copied, and then simply fail to load, leaving the display on the
  fallback stack with no explanation. There is no size cap either. Neither is
  dangerous — the file is only ever handed to the renderer as a `@font-face`
  source — but the failure is silent, which is the part worth fixing.
- **A background image is checked by extension, not by content**, and there is
  no size cap — the same silent failure the font importer has, for the same
  reason, and worth fixing in the same change.
- **Installed fonts are listed once per app run** and cached. A font installed
  while the app is open won't appear until it is restarted.

## Future scope

**Near term**

- Global hotkey to open the player without reaching for the tray.
- Auto-open when playback starts, and/or an idle "ambient" mode that takes over
  a second monitor.
- Remember the last display and reopen there.

**The Web API port**

The documented fallback if the session proves too limited. It costs an OAuth
login and a Spotify developer app, and buys: reliable seek, volume, shuffle and
repeat state, the queue, richer metadata, and artwork straight from Spotify at
full resolution. The renderer wouldn't change — only the source feeding
`player:state`. Worth doing as a *second* provider behind the same interface
rather than a replacement, so the app still works offline and without a login.

**Design and feature ideas**

- Lyrics panel (synced if a source is available), as a second layout the view
  can switch to.
- Up-next / queue peek on hover.
- A restrained audio-reactive element — the temptation here is a spectrum
  analyser, which would undo the whole design; something much quieter, if
  anything.
- More themes. The `data-theme` split means a new one is a block of CSS and an
  entry in the picker, with no new state code — an adaptive light theme for
  bright covers in bright rooms is the obvious next one, and a minimal
  cover-only screen with no chrome at all is the other.
- Tune the washes across a wide spread of covers. The opacities and the 34°
  minimum hue separation are first guesses, and very dark covers may still read
  flat.

**Engineering**

- Package and sign the installer; auto-update.
- Cap the artwork cache and prune it.
- Validate imported fonts by actually loading them, and report the failure in
  the settings window rather than falling back silently. A size cap belongs in
  the same change.
- Re-read the installed font list when the settings window opens rather than
  once per run.
- Move the bridge poll from a fixed 220ms interval to event subscriptions
  (`MediaPropertiesChanged`, `PlaybackInfoChanged`) to cut idle CPU further.
- Measure the renderer on a low-end machine. The washes are *designed* to be
  compositor-only, but that is reasoning rather than a measurement — worth
  confirming in DevTools that no layer re-rasterises per frame.
