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
  hiResToggle: el('hiResToggle'),
  loginToggle: el('loginToggle'),
  closeBtn: el('closeBtn'),
};

const BG_HINT = 'Applies to the Classic and Split themes.';

const DEFAULT_HINT =
  "Any font installed on this PC, or import a .ttf, .otf, .ttc, .woff or .woff2.";

let state = null; // settings
let systemFonts = [];
let displays = [];

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
  // The lock screen theme is its own backdrop; the other two take a choice.
  dom.bgGroup.hidden = state.theme === 'lockscreen';

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

function renderDisplays() {
  dom.displaySelect.replaceChildren();
  displays.forEach((display) => {
    const option = document.createElement('option');
    option.value = String(display.id);
    option.textContent = `${display.label} — ${display.size}`;
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

  dom.clockSelect.value = state.clock24h === true ? '24' : state.clock24h === false ? '12' : 'auto';
  dom.hiResToggle.checked = !!state.hiResArtwork;
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

dom.hiResToggle.addEventListener('change', () => apply({ hiResArtwork: dom.hiResToggle.checked }));
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
  faceStyle.textContent = data.fontFaceCss || '';
  render();
}

refresh();
