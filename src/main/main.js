'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const { SmtcBridge } = require('./smtc');
const { ArtworkResolver } = require('./artwork');
const { paletteFor } = require('./palette');
const fonts = require('./fonts');

const ROOT = path.join(__dirname, '..', '..');
const ICON_ICO = path.join(ROOT, 'build', 'icon.ico');
const ICON_PNG = path.join(ROOT, 'build', 'icon-256.png');

let win = null;
let settingsWin = null;
let tray = null;
let bridge = null;
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
    hiResArtwork: true,
    launchAtLogin: false,
    theme: 'classic', // 'classic' | 'lockscreen'
    background: 'cover', // classic only: 'cover' | 'hues' | 'solid'
    backgroundColor: '#161a24', // used when background is 'solid'
    fontFamily: '', // '' = the built-in system stack
    clock24h: null, // null = follow the system locale
    customFonts: [], // [{ family, file }]
  };
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    const merged = Object.assign(defaults, raw);
    merged.customFonts = fonts.prune(merged.customFonts);
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
}

function hidePlayer() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('player:visible', false);
  win.setAlwaysOnTop(false);
  win.hide();
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

  const hiRes = settings.hiResArtwork ? currentState.hiResPath : '';
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

function fetchHiResArtwork() {
  if (!artwork || !settings.hiResArtwork) return;
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

/* --------------------------------------------------------------- appearance */

function appearance() {
  return {
    theme: settings.theme,
    background: settings.background,
    backgroundColor: settings.backgroundColor,
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

const SETTINGS_SIZE = { width: 460, height: 782 };

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

  if ('hiResArtwork' in patch && patch.hiResArtwork !== before.hiResArtwork) {
    if (patch.hiResArtwork) fetchHiResArtwork();
    pushState(true);
  }

  if (
    'theme' in patch ||
    'background' in patch ||
    'backgroundColor' in patch ||
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

    bridge = new SmtcBridge();
    bridge.on('state', onState);
    bridge.on('status', (status) => {
      if (!status.connected) console.error('[bridge]', status.reason || 'disconnected');
    });
    bridge.start();

    ipcMain.on('player:ready', () => {
      pushAppearance();
      pushState(true);
    });
    ipcMain.on('player:close', hidePlayer);
    ipcMain.on('player:command', (_event, command, value) => {
      if (!bridge) return;
      switch (command) {
        case 'playpause':
        case 'play':
        case 'pause':
        case 'next':
        case 'prev':
          bridge.send(command);
          break;
        case 'seek':
          if (Number.isFinite(value)) bridge.send(`seek ${Math.max(0, Math.round(value))}`);
          break;
        default:
          break;
      }
    });

    ipcMain.handle('settings:get', async () => ({
      settings,
      displays: displayList(),
      systemFonts: await fonts.listSystemFonts(),
      // The preview has to be able to name imported faces too.
      fontFaceCss: fonts.faceCss(settings.customFonts),
    }));

    ipcMain.handle('settings:set', (_event, patch) => applySettings(patch || {}));

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
        return { canceled: false, font: record, settings };
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
      return applySettings(patch);
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
  });
}
