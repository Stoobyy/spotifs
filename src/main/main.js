'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const { SmtcBridge } = require('./smtc');
const { ArtworkResolver } = require('./artwork');
const { paletteFor } = require('./palette');

const ROOT = path.join(__dirname, '..', '..');
const ICON_ICO = path.join(ROOT, 'build', 'icon.ico');
const ICON_PNG = path.join(ROOT, 'build', 'icon-256.png');

let win = null;
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
  const defaults = { displayId: null, hiResArtwork: true, launchAtLogin: false };
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    return Object.assign(defaults, raw);
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

function buildTrayMenu() {
  const displays = screen.getAllDisplays();

  return Menu.buildFromTemplate([
    {
      label: 'Open Now Playing',
      click: showPlayer,
    },
    { type: 'separator' },
    {
      label: 'Display',
      submenu: displays.map((display, index) => ({
        label:
          (display.id === screen.getPrimaryDisplay().id ? 'Primary' : `Display ${index + 1}`) +
          `  ${display.size.width} × ${display.size.height}`,
        type: 'radio',
        checked:
          String(settings.displayId) === String(display.id) ||
          (!settings.displayId && display.id === screen.getPrimaryDisplay().id),
        click: () => {
          settings.displayId = display.id;
          saveSettings();
          currentDisplayId = null;
          if (win && win.isVisible()) showPlayer();
        },
      })),
    },
    {
      label: 'High-resolution artwork',
      type: 'checkbox',
      checked: settings.hiResArtwork,
      click: (item) => {
        settings.hiResArtwork = item.checked;
        saveSettings();
        if (item.checked) fetchHiResArtwork();
        pushState(true);
      },
    },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: settings.launchAtLogin,
      click: (item) => {
        settings.launchAtLogin = item.checked;
        saveSettings();
        app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] });
      },
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

    ipcMain.on('player:ready', () => pushState(true));
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
  });

  // Tray app: subscribing (even with a no-op) stops Electron quitting when the
  // player window goes away.
  app.on('window-all-closed', () => {});

  app.on('before-quit', () => {
    quitting = true;
    if (bridge) bridge.stop();
  });
}
