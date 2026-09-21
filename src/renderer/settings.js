'use strict';

/* Settings window. Every control writes straight through to the main process,
   which persists and applies it — there is no save button and no local copy of
   the truth beyond `state`, which is only ever replaced by what main returns. */

const el = (id) => document.getElementById(id);

const dom = {
  themes: el('themes'),
  bgGroup: el('bgGroup'),
  bgs: el('bgs'),
  bgColorRow: el('bgColorRow'),
  bgColor: el('bgColor'),
  bgColorHex: el('bgColorHex'),
  bgImageRow: el('bgImageRow'),
  bgImageBtn: el('bgImageBtn'),
  bgImageClear: el('bgImageClear'),
  bgHint: el('bgHint'),
  fontSelect: el('fontSelect'),
  fontPreview: el('fontPreview'),
  fontHint: el('fontHint'),
  importBtn: el('importBtn'),
  removeBtn: el('removeBtn'),
  clockSelect: el('clockSelect'),
  displaySelect: el('displaySelect'),
  sources: el('sources'),
  spotifyDisconnect: el('spotifyDisconnect'),
  spotifyStatusText: el('spotifyStatusText'),
  loginToggle: el('loginToggle'),
  closeBtn: el('closeBtn'),
};

const BG_HINT = 'Blurred cover, a flat colour, the album’s hues, or a picture of your own.';

const DEFAULT_HINT =
  "Any font installed on this PC, or import a .ttf, .otf, .ttc, .woff or .woff2.";

let state = null; // settings
let systemFonts = [];
let displays = [];
let spotify = { connected: false, redirectUri: '' };
let platform = { win: true, mac: false };

// Imported faces have to be declared here as well, or the preview falls back to
// the default stack and silently shows the wrong font.
const faceStyle = document.createElement('style');
document.head.appendChild(faceStyle);

/* ------------------------------------------------------------------ helpers */

async function apply(patch) {
  state = await window.settingsApi.set(patch);
  render();
}

function hint(text, isError) {
  dom.fontHint.textContent = text;
  dom.fontHint.classList.toggle('is-error', !!isError);
}

function isCustom(family) {
  return state.customFonts.some((f) => f.family === family);
}

/* ------------------------------------------------------------------- render */

function renderFontOptions() {
  const chosen = state.fontFamily || '';
  dom.fontSelect.replaceChildren();

  const add = (value, label, parent) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    if (value === chosen) option.selected = true;
    (parent || dom.fontSelect).appendChild(option);
  };

  add('', 'System default');

  if (state.customFonts.length) {
    const group = document.createElement('optgroup');
    group.label = 'Imported';
    state.customFonts.forEach((f) => add(f.family, f.family, group));
    dom.fontSelect.appendChild(group);
  }

  const installed = document.createElement('optgroup');
  installed.label = 'Installed';
  systemFonts.forEach((name) => add(name, name, installed));
  dom.fontSelect.appendChild(installed);

  // A font chosen before but since uninstalled would otherwise vanish silently.
  if (chosen && !isCustom(chosen) && !systemFonts.includes(chosen)) {
    const orphan = document.createElement('optgroup');
    orphan.label = 'Not installed';
    orphan.appendChild(Object.assign(document.createElement('option'), {
      value: chosen,
      textContent: chosen,
      selected: true,
    }));
    dom.fontSelect.appendChild(orphan);
  }
}

function renderBackground() {
  Array.from(dom.bgs.querySelectorAll('.bg')).forEach((button) => {
    button.classList.toggle('is-active', button.dataset.bg === state.background);
  });

  const colour = state.backgroundColor || '#161a24';
  dom.bgColorRow.hidden = state.background !== 'solid';
  dom.bgColor.value = colour;
  dom.bgColorHex.textContent = colour;

  dom.bgImageRow.hidden = state.background !== 'image';
  dom.bgImageBtn.textContent = state.backgroundImage ? 'Change image…' : 'Choose image…';
  dom.bgImageClear.hidden = !state.backgroundImage;

  // Both tiles are the real preview: the swatch shows the colour it selects,
  // and the image tile shows the picture it selects.
  const root = document.documentElement.style;
  root.setProperty('--bg-solid-preview', colour);
  root.setProperty(
    '--bg-image-preview',
    state.backgroundImageUrl ? `url("${state.backgroundImageUrl}")` : 'none'
  );
}

function renderPreview() {
  const family = state.fontFamily;
  document.documentElement.style.setProperty(
    '--preview-font',
    family ? `"${family}"` : 'inherit'
  );
  dom.removeBtn.hidden = !family || !isCustom(family);
}

function renderSource() {
  Array.from(dom.sources.querySelectorAll('.source')).forEach((button) => {
    button.classList.toggle('is-active', button.dataset.source === state.playbackSource);
    // The System source is the Windows media session; it does not exist elsewhere.
    if (button.dataset.source === 'system') button.hidden = !platform.win;
  });
  dom.sources.classList.toggle('sources-single', !platform.win);

  dom.spotifyDisconnect.hidden = !spotify.connected;

  if (spotify.connected) setStatus('Spotify account connected.', 'ok');
  else if (!dom.spotifyStatusText.classList.contains('is-error')) setStatus('');
}

function setStatus(text, kind) {
  dom.spotifyStatusText.textContent = text;
  dom.spotifyStatusText.classList.toggle('is-ok', kind === 'ok');
  dom.spotifyStatusText.classList.toggle('is-error', kind === 'error');
}

function renderDisplays() {
  dom.displaySelect.replaceChildren();
  displays.forEach((display) => {
    const option = document.createElement('option');
    option.value = String(display.id);
    option.textContent = `${display.label} · ${display.size}`;
    const chosen = state.displayId == null ? display.primary : String(state.displayId) === String(display.id);
    if (chosen) option.selected = true;
    dom.displaySelect.appendChild(option);
  });
}

function render() {
  Array.from(dom.themes.querySelectorAll('.theme')).forEach((button) => {
    button.classList.toggle('is-active', button.dataset.theme === state.theme);
  });

  renderBackground();
  renderFontOptions();
  renderPreview();
  renderDisplays();
  renderSource();

  dom.clockSelect.value = state.clock24h === true ? '24' : state.clock24h === false ? '12' : 'auto';
  dom.loginToggle.checked = !!state.launchAtLogin;
}

/* ------------------------------------------------------------------- events */

dom.themes.addEventListener('click', (event) => {
  const button = event.target.closest('.theme');
  if (button) apply({ theme: button.dataset.theme });
});

dom.bgs.addEventListener('click', (event) => {
  const button = event.target.closest('.bg');
  if (!button) return;
  // Choosing Image with nothing imported yet would switch to a blank screen and
  // leave the user to find the button underneath, so go straight to the picker.
  if (button.dataset.bg === 'image' && !state.backgroundImage) chooseImage();
  else apply({ background: button.dataset.bg });
});

async function chooseImage() {
  const result = await window.settingsApi.importImage();
  if (result.canceled) return;
  if (result.error) {
    dom.bgHint.textContent = result.error;
    dom.bgHint.classList.add('is-error');
    return;
  }
  dom.bgHint.textContent = BG_HINT;
  dom.bgHint.classList.remove('is-error');
  state = result.settings;
  render();
}

dom.bgImageBtn.addEventListener('click', chooseImage);

dom.bgImageClear.addEventListener('click', async () => {
  state = await window.settingsApi.clearImage();
  render();
});

// 'input' fires continuously while dragging in the picker, which is what makes
// the player update live; it is only ever a settings write plus an IPC send.
dom.bgColor.addEventListener('input', () => {
  dom.bgColorHex.textContent = dom.bgColor.value;
  apply({ backgroundColor: dom.bgColor.value });
});

dom.fontSelect.addEventListener('change', () => {
  hint(DEFAULT_HINT, false);
  apply({ fontFamily: dom.fontSelect.value });
});

dom.importBtn.addEventListener('click', async () => {
  const result = await window.settingsApi.importFont();
  if (result.canceled) return;
  if (result.error) {
    hint(result.error, true);
    return;
  }
  hint(`Imported ${result.font.family}.`, false);
  await refresh();
});

dom.removeBtn.addEventListener('click', async () => {
  const family = state.fontFamily;
  if (!family || !isCustom(family)) return;
  await window.settingsApi.removeFont(family);
  hint(`Removed ${family}.`, false);
  await refresh();
});

dom.clockSelect.addEventListener('change', () => {
  const value = dom.clockSelect.value;
  apply({ clock24h: value === 'auto' ? null : value === '24' });
});

dom.displaySelect.addEventListener('change', () => {
  apply({ displayId: Number(dom.displaySelect.value) });
});

dom.sources.addEventListener('click', async (event) => {
  const button = event.target.closest('.source');
  if (!button) return;
  const source = button.dataset.source;
  // Picking Spotify with no token yet is a sign-in, not a setting change; the
  // main process flips the setting itself once the redirect comes back.
  if (source === 'spotify' && !spotify.connected) {
    await connectSpotify();
    if (spotify.connected) apply({ playbackSource: 'spotify' });
    return;
  }
  apply({ playbackSource: source });
});

async function connectSpotify() {
  setStatus('Waiting for Spotify in your browser…');
  const result = await window.settingsApi.spotifyConnect();
  spotify = result.status || spotify;
  if (!result.ok) setStatus(result.error || 'Sign-in failed.', 'error');
  renderSource();
}

dom.spotifyDisconnect.addEventListener('click', async () => {
  spotify = await window.settingsApi.spotifyDisconnect();
  await refresh();
});

window.settingsApi.onSpotifyStatus((status) => {
  spotify = status;
  if (state) renderSource();
});
dom.loginToggle.addEventListener('change', () => apply({ launchAtLogin: dom.loginToggle.checked }));

dom.closeBtn.addEventListener('click', () => window.settingsApi.close());
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.settingsApi.close();
});

/* --------------------------------------------------------------------- boot */

async function refresh() {
  const data = await window.settingsApi.get();
  state = data.settings;
  systemFonts = data.systemFonts || [];
  displays = data.displays || [];
  platform = data.platform || platform;
  faceStyle.textContent = data.fontFaceCss || '';
  // Render before anything optional: if the main process is older than this
  // window and lacks a handler, the page must still come up fully populated.
  render();
  try {
    spotify = await window.settingsApi.spotifyStatus();
    renderSource();
  } catch (_) {
    setStatus('Restart Now Playing to enable Spotify sign-in.', 'error');
  }
}

refresh();
