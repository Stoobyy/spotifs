'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const { SmtcBridge } = require('./smtc');
const { SpotifyProvider, REDIRECT_URI, DEFAULT_CLIENT_ID } = require('./spotify');
const { ArtworkResolver } = require('./artwork');
const { paletteFor } = require('./palette');
const fonts = require('./fonts');
const wallpaper = require('./wallpaper');

const ROOT = path.join(__dirname, '..', '..');
const ICON_ICO = path.join(ROOT, 'build', 'icon.ico');
const ICON_PNG = path.join(ROOT, 'build', 'icon-256.png');

let win = null;
let settingsWin = null;
let tray = null;
let bridge = null; // SmtcBridge
let spotify = null; // SpotifyProvider
let provider = null; // whichever of the two is active
let artwork = null;
let settings = null;
let currentState = { hasTrack: false, playing: false };
let currentDisplayId = null;
let quitting = false;

/* ------------------------------------------------------------------ settings */

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  const defaults = {
    displayId: null,
    launchAtLogin: false,
    playbackSource: 'system', // 'system' (SMTC, zero setup) | 'spotify' (Web API, opt-in)
    spotifyClientId: '', // from the user's own Spotify developer app; PKCE, so no secret
    theme: 'classic', // 'classic' | 'lockscreen' | 'split' | 'dial'
    background: 'cover', // 'cover' | 'hues' | 'solid' | 'image'
    backgroundColor: '#161a24', // used when background is 'solid'
    backgroundImage: '', // copy in userData, used when background is 'image'
    fontFamily: '', // '' = the built-in system stack
    clock24h: null, // null = follow the system locale
    customFonts: [], // [{ family, file }]
  };
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    const merged = Object.assign(defaults, raw);
    merged.customFonts = fonts.prune(merged.customFonts);
    merged.backgroundImage = wallpaper.prune(merged.backgroundImage);
    // A background of 'image' with no image left is just a black screen.
    if (merged.background === 'image' && !merged.backgroundImage) merged.background = 'cover';
    return merged;
  } catch (_) {
    return defaults;
  }
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('[settings]', err.message);
  }
}

/* -------------------------------------------------------------------- window */

function targetDisplay() {
  const displays = screen.getAllDisplays();
  const chosen = displays.find((d) => String(d.id) === String(settings.displayId));
  return chosen || screen.getPrimaryDisplay();
}

function createWindow() {
  win = new BrowserWindow({
    show: false,
    frame: false,
    // Windows keeps WS_THICKFRAME on frameless windows and DWM paints a hairline
    // of caption colour along the top edge. Dropping the resize frame removes
    // it, and squares off Windows 11's rounded corners at the same time. Costs
    // only the shadow and open/close animation, neither of which a display this
    // size wants.
    resizable: false,
    thickFrame: false,
    maximizable: false,
    backgroundColor: '#000000',
    fullscreenable: false,
    autoHideMenuBar: true,
    skipTaskbar: false,
    title: 'Now Playing',
    icon: fs.existsSync(ICON_PNG) ? ICON_PNG : undefined,
    webPreferences: {
      preload: path.join(__dirname, '..', 'renderer', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));

  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    hidePlayer();
  });

  // Links (if any) open in the real browser, never in the player.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// Deliberately *not* Electron's full-screen mode. The window is frameless, so
// full screen buys nothing visually, and on Windows leaving it while hiding
// leaves the compositor holding a black full-screen surface the user has to
// alt-tab away from. Sizing a frameless window to the display and pinning it
// above the taskbar looks the same and has no state to get stuck in.
function showPlayer() {
  if (!win || win.isDestroyed()) createWindow();

  const display = targetDisplay();
  win.setBounds(display.bounds);
  currentDisplayId = display.id;

  win.setAlwaysOnTop(true, 'screen-saver'); // 'screen-saver' clears the taskbar
  win.show();
  win.focus();
  win.webContents.send('player:visible', true);
  if (spotify) spotify.setVisible(true);
}

function hidePlayer() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('player:visible', false);
  win.setAlwaysOnTop(false);
  win.hide();
  if (spotify) spotify.setVisible(false);
}

function togglePlayer() {
  if (win && !win.isDestroyed() && win.isVisible()) hidePlayer();
  else showPlayer();
}

/* ---------------------------------------------------------------------- tray */

function trayImage() {
  const image = nativeImage.createFromPath(fs.existsSync(ICON_ICO) ? ICON_ICO : ICON_PNG);
  return image.isEmpty() ? nativeImage.createEmpty() : image;
}

// Everything configurable now lives in the settings window; the tray stays a
// three-item menu so the common actions are one click away.
function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Open Now Playing', click: showPlayer },
    { label: 'Settings…', click: openSettings },
    { type: 'separator' },
    {
      label: 'Playback source',
      submenu: [
        {
          label: 'System (default)',
          type: 'radio',
          checked: settings.playbackSource !== 'spotify',
          click: () => applySettings({ playbackSource: 'system' }),
        },
        {
          label: spotify && spotify.connected ? 'Spotify account' : 'Spotify account (sign in…)',
          type: 'radio',
          checked: settings.playbackSource === 'spotify',
          click: () => chooseSpotify(),
        },
      ],
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
}

function createTray() {
  tray = new Tray(trayImage());
  tray.setToolTip('Now Playing');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', togglePlayer);
  tray.on('double-click', showPlayer);

  screen.on('display-added', () => tray.setContextMenu(buildTrayMenu()));
  screen.on('display-removed', () => tray.setContextMenu(buildTrayMenu()));
}

function updateTrayTooltip(state) {
  if (!tray) return;
  tray.setToolTip(
    state.hasTrack ? `${state.title}\n${state.artist}`.slice(0, 127) : 'Nothing playing'
  );
}

/* --------------------------------------------------------------------- state */

function toFileUrl(filePath) {
  if (!filePath) return '';
  try {
    return fs.existsSync(filePath) ? pathToFileURL(filePath).href : '';
  } catch (_) {
    return '';
  }
}

function pushState(force = false) {
  if (!win || win.isDestroyed()) return;

  const hiRes = currentState.hiResPath || '';
  const source = hiRes || currentState.artPath;

  const payload = Object.assign({}, currentState, {
    art: toFileUrl(currentState.artPath),
    artHiRes: toFileUrl(hiRes),
    palette: source ? paletteFor(source) : null,
    sentAt: Date.now(),
    force,
  });
  win.webContents.send('player:state', payload);
}

// The SMTC thumbnail is ~300px, so the system source always upgrades through
// the iTunes catalogue. The Spotify source already hands us 640px covers.
function fetchHiResArtwork() {
  if (!artwork || settings.playbackSource === 'spotify') return;
  if (!currentState.hasTrack || currentState.hiResPath) return;

  const key = currentState.trackKey;
  artwork.resolve(currentState).then((file) => {
    if (!file || currentState.trackKey !== key) return;
    currentState.hiResPath = file;
    pushState();
  });
}

function onState(state) {
  const trackChanged = state.trackKey !== currentState.trackKey;
  currentState = Object.assign({}, state, {
    hiResPath: trackChanged ? '' : currentState.hiResPath,
  });

  updateTrayTooltip(currentState);
  pushState();

  if (trackChanged) fetchHiResArtwork();
}

/* ------------------------------------------------------------- providers */

function onProviderLog(entry) {
  if (!entry) return;
  (entry.level === 'error' ? console.error : console.log)('[spotify]', entry.message);
}

function createSpotify() {
  const instance = new SpotifyProvider({
    clientId: () => settings.spotifyClientId,
    // Separate from settings.json on purpose: the refresh token is a
    // credential, and %APPDATA%\spotifs is where it was asked to live.
    tokenFile: path.join(app.getPath('appData'), 'spotifs', 'spotify-auth.json'),
    cacheDir: path.join(app.getPath('userData'), 'artwork'),
  });
  instance.on('log', onProviderLog);
  instance.on('status', (status) => {
    if (tray) tray.setContextMenu(buildTrayMenu());
    if (!status.connected && status.reason) console.log('[spotify]', status.reason);
    broadcastSpotifyStatus();
  });
  return instance;
}

/**
 * Starts whichever source settings ask for and stops the other. The bridge is
 * a PowerShell process, so it is actually shut down rather than left polling,
 * and the two are never both feeding state.
 */
function startProvider() {
  const wantSpotify = settings.playbackSource === 'spotify';
  if (provider) provider.removeListener('state', onState);

  if (wantSpotify) {
    if (bridge) {
      bridge.stop();
      bridge = null;
    }
    if (!spotify) spotify = createSpotify();
    provider = spotify;
  } else {
    if (spotify) spotify.stop();
    if (!bridge) {
      bridge = new SmtcBridge();
      bridge.on('status', (status) => {
        if (!status.connected) console.error('[bridge]', status.reason || 'disconnected');
      });
    }
    provider = bridge;
  }

  provider.on('state', onState);
  currentState = { hasTrack: false, playing: false };
  pushState(true);
  provider.start();
  if (provider === spotify) spotify.setVisible(!!(win && !win.isDestroyed() && win.isVisible()));
  if (tray) tray.setContextMenu(buildTrayMenu());
}

function spotifyStatus() {
  return {
    connected: !!(spotify && spotify.connected),
    redirectUri: REDIRECT_URI,
    hasBundledClientId: !!DEFAULT_CLIENT_ID,
  };
}

function broadcastSpotifyStatus() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send('spotify:status', spotifyStatus());
  }
}

/** Sign in if there is no token yet; constructing the provider does not poll. */
async function connectSpotify() {
  if (!spotify) spotify = createSpotify();
  await spotify.authorize();
  broadcastSpotifyStatus();
}

/** Tray path into the Spotify source. */
async function chooseSpotify() {
  if (spotify && spotify.connected) {
    applySettings({ playbackSource: 'spotify' });
    return;
  }
  if (!settings.spotifyClientId && !DEFAULT_CLIENT_ID) {
    // Nothing to sign in with yet; Settings is where the client ID goes.
    if (tray) tray.setContextMenu(buildTrayMenu()); // un-tick the radio
    openSettings();
    return;
  }
  try {
    await connectSpotify();
    applySettings({ playbackSource: 'spotify' });
  } catch (err) {
    console.error('[spotify]', err.message);
    if (tray) tray.setContextMenu(buildTrayMenu());
  }
}

/* --------------------------------------------------------------- appearance */

function appearance() {
  return {
    theme: settings.theme,
    background: settings.background,
    backgroundColor: settings.backgroundColor,
    backgroundImage: toFileUrl(settings.backgroundImage),
    fontFamily: settings.fontFamily,
    clock24h: settings.clock24h,
    fontFaceCss: fonts.faceCss(settings.customFonts),
  };
}

function pushAppearance() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('player:appearance', appearance());
}

/* ----------------------------------------------------------------- settings */

const SETTINGS_SIZE = { width: 460, height: 940 };

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }

  settingsWin = new BrowserWindow({
    width: SETTINGS_SIZE.width,
    height: SETTINGS_SIZE.height,
    show: false,
    frame: false,
    resizable: false,
    maximizable: false,
    backgroundColor: '#1b1b1d',
    title: 'Now Playing Settings',
    icon: fs.existsSync(ICON_PNG) ? ICON_PNG : undefined,
    webPreferences: {
      preload: path.join(__dirname, '..', 'renderer', 'settings-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  settingsWin.loadFile(path.join(ROOT, 'src', 'renderer', 'settings.html'));

  // The player sits at screen-saver level, so the settings window has to as
  // well or it opens behind the thing it is configuring.
  settingsWin.setAlwaysOnTop(true, 'screen-saver');

  settingsWin.once('ready-to-show', () => {
    settingsWin.show();
    settingsWin.focus();
  });

  settingsWin.on('closed', () => {
    settingsWin = null;
  });
}

function displayList() {
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((display, index) => ({
    id: display.id,
    label: display.id === primary ? 'Primary display' : `Display ${index + 1}`,
    size: `${display.size.width} x ${display.size.height}`,
    primary: display.id === primary,
  }));
}

/**
 * What the settings window sees. The stored background image is an absolute
 * path, which a renderer can't load; it needs the file URL alongside it for the
 * preview tile.
 */
function settingsForUi() {
  return Object.assign({}, settings, {
    backgroundImageUrl: toFileUrl(settings.backgroundImage),
  });
}

/** Applies a patch of changed keys, doing whatever each one needs. */
function applySettings(patch) {
  const before = Object.assign({}, settings);
  Object.assign(settings, patch);
  saveSettings();

  if ('launchAtLogin' in patch && patch.launchAtLogin !== before.launchAtLogin) {
    app.setLoginItemSettings({ openAtLogin: !!patch.launchAtLogin, args: ['--hidden'] });
  }

  if ('displayId' in patch && String(patch.displayId) !== String(before.displayId)) {
    currentDisplayId = null;
    if (win && !win.isDestroyed() && win.isVisible()) showPlayer();
  }

  if ('playbackSource' in patch && patch.playbackSource !== before.playbackSource) {
    startProvider();
  }

  if (
    'theme' in patch ||
    'background' in patch ||
    'backgroundColor' in patch ||
    'backgroundImage' in patch ||
    'fontFamily' in patch ||
    'clock24h' in patch ||
    'customFonts' in patch
  ) {
    pushAppearance();
  }

  return settings;
}

/* ----------------------------------------------------------------- lifecycle */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showPlayer);

  app.whenReady().then(() => {
    settings = loadSettings();
    artwork = new ArtworkResolver(path.join(app.getPath('userData'), 'artwork'));

    createWindow();
    createTray();

    startProvider();

    ipcMain.on('player:ready', () => {
      pushAppearance();
      pushState(true);
    });
    ipcMain.on('player:close', hidePlayer);
    ipcMain.on('player:command', (_event, command, value) => {
      if (!provider) return;
      switch (command) {
        case 'playpause':
        case 'play':
        case 'pause':
        case 'next':
        case 'prev':
          provider.send(command);
          break;
        case 'seek':
          if (Number.isFinite(value)) provider.send(`seek ${Math.max(0, Math.round(value))}`);
          break;
        default:
          break;
      }
    });

    ipcMain.handle('spotify:status', () => spotifyStatus());
    ipcMain.handle('spotify:connect', async () => {
      try {
        await connectSpotify();
        return { ok: true, status: spotifyStatus() };
      } catch (err) {
        return { ok: false, error: err.message, status: spotifyStatus() };
      }
    });
    ipcMain.handle('spotify:disconnect', () => {
      if (spotify) spotify.disconnect();
      if (settings.playbackSource === 'spotify') applySettings({ playbackSource: 'system' });
      broadcastSpotifyStatus();
      return spotifyStatus();
    });

    ipcMain.handle('settings:get', async () => ({
      settings: settingsForUi(),
      displays: displayList(),
      systemFonts: await fonts.listSystemFonts(),
      // The preview has to be able to name imported faces too.
      fontFaceCss: fonts.faceCss(settings.customFonts),
    }));

    ipcMain.handle('settings:set', (_event, patch) => {
      applySettings(patch || {});
      return settingsForUi();
    });

    ipcMain.handle('settings:importFont', async () => {
      const parent = settingsWin && !settingsWin.isDestroyed() ? settingsWin : undefined;
      const result = await dialog.showOpenDialog(parent, {
        title: 'Choose a font file',
        properties: ['openFile'],
        filters: [{ name: 'Fonts', extensions: ['ttf', 'otf', 'ttc', 'woff', 'woff2'] }],
      });
      if (result.canceled || result.filePaths.length === 0) return { canceled: true };

      try {
        const record = fonts.importFont(result.filePaths[0], settings.customFonts);
        applySettings({
          customFonts: settings.customFonts.concat([record]),
          fontFamily: record.family,
        });
        return { canceled: false, font: record, settings: settingsForUi() };
      } catch (err) {
        return { canceled: false, error: err.message };
      }
    });

    ipcMain.handle('settings:removeFont', (_event, family) => {
      const record = settings.customFonts.find((f) => f.family === family);
      if (!record) return settings;
      fonts.removeFont(record);
      const patch = { customFonts: settings.customFonts.filter((f) => f.family !== family) };
      // Don't leave the player pointing at a font that no longer exists.
      if (settings.fontFamily === family) patch.fontFamily = '';
      applySettings(patch);
      return settingsForUi();
    });

    ipcMain.handle('settings:importImage', async () => {
      const parent = settingsWin && !settingsWin.isDestroyed() ? settingsWin : undefined;
      const result = await dialog.showOpenDialog(parent, {
        title: 'Choose a background image',
        properties: ['openFile'],
        filters: [
          { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'avif'] },
        ],
      });
      if (result.canceled || result.filePaths.length === 0) return { canceled: true };

      try {
        const file = wallpaper.importImage(result.filePaths[0], settings.backgroundImage);
        // Picking a picture is only ever meant one way: show it.
        applySettings({ backgroundImage: file, background: 'image' });
        return { canceled: false, settings: settingsForUi() };
      } catch (err) {
        return { canceled: false, error: err.message };
      }
    });

    ipcMain.handle('settings:clearImage', () => {
      wallpaper.removeImage(settings.backgroundImage);
      const patch = { backgroundImage: '' };
      // 'image' with nothing to show would leave a bare black screen.
      if (settings.background === 'image') patch.background = 'cover';
      applySettings(patch);
      return settingsForUi();
    });

    ipcMain.on('settings:close', () => {
      if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
    });
  });

  // Tray app: subscribing (even with a no-op) stops Electron quitting when the
  // player window goes away.
  app.on('window-all-closed', () => {});

  app.on('before-quit', () => {
    quitting = true;
    if (bridge) bridge.stop();
    if (spotify) spotify.stop();
  });
}
