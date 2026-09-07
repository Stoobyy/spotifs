'use strict';

const el = (id) => document.getElementById(id);

const dom = {
  body: document.body,
  stage: el('stage'),
  title: el('title'),
  artist: el('artist'),
  album: el('album'),
  artA: el('artA'),
  artB: el('artB'),
  ambientA: el('ambientA'),
  ambientB: el('ambientB'),
  scrub: el('scrub'),
  scrubTrack: el('scrubTrack'),
  scrubFill: el('scrubFill'),
  scrubKnob: el('scrubKnob'),
  elapsed: el('elapsed'),
  remaining: el('remaining'),
  playBtn: el('playBtn'),
  prevBtn: el('prevBtn'),
  nextBtn: el('nextBtn'),
  closeBtn: el('closeBtn'),
  clock: el('clock'),
  lockDate: el('lockDate'),
  lockClock: el('lockClock'),
};

// Kept in sync with the stack in styles.css; a chosen font is prepended to it
// rather than replacing it, so missing glyphs still fall back sensibly.
const DEFAULT_STACK =
  '"SF Pro Display", -apple-system, "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif';

const faceStyle = document.createElement('style');
document.head.appendChild(faceStyle);

let clock24h = null;

const track = {
  key: '',
  hasTrack: false,
  playing: false,
  positionMs: 0,
  durationMs: 0,
  updatedAt: Date.now(),
  canSeek: false,
};

let visible = true;
let dragging = false;
let dragRatio = 0;
let rafId = null;
let artUrl = '';
let artSlot = 'B';
let ambientSlot = 'B';
let washHues = [NaN, NaN, NaN];
let idleTimer = null;

/* ------------------------------------------------------------------ artwork */

function setArtwork(url) {
  if (url === artUrl) return;
  artUrl = url;

  if (!url) {
    dom.body.classList.add('no-art');
    dom.artA.classList.remove('is-active');
    dom.artB.classList.remove('is-active');
    dom.ambientA.classList.remove('is-active');
    dom.ambientB.classList.remove('is-active');
    return;
  }

  const preload = new Image();
  preload.onload = () => {
    if (artUrl !== url) return; // a newer track already won
    dom.body.classList.remove('no-art');

    artSlot = artSlot === 'A' ? 'B' : 'A';
    const incoming = artSlot === 'A' ? dom.artA : dom.artB;
    const outgoing = artSlot === 'A' ? dom.artB : dom.artA;
    incoming.src = url;
    incoming.classList.add('is-active');
    outgoing.classList.remove('is-active');

    ambientSlot = ambientSlot === 'A' ? 'B' : 'A';
    const nextAmbient = ambientSlot === 'A' ? dom.ambientA : dom.ambientB;
    const prevAmbient = ambientSlot === 'A' ? dom.ambientB : dom.ambientA;
    nextAmbient.style.backgroundImage = `url("${url}")`;
    nextAmbient.classList.add('is-active');
    prevAmbient.classList.remove('is-active');
  };
  preload.onerror = () => {
    if (artUrl === url) dom.body.classList.add('no-art');
  };
  preload.src = url;
}

function applyPalette(palette) {
  if (!palette) return;
  const root = document.documentElement.style;
  root.setProperty('--accent-h', String(palette.h));
  root.setProperty('--accent-s', `${palette.s}%`);
  root.setProperty('--accent-l', `${palette.l}%`);

  // Hues for the three drifting washes. Only the hue varies per track; their
  // saturation and lightness are fixed in CSS so a loud cover stays contained.
  const hues = palette.hues && palette.hues.length === 3 ? palette.hues : [palette.h, palette.h + 38, palette.h - 38];
  washHues = hues.map((hue, index) => nearestHue(washHues[index], hue));
  root.setProperty('--wash-1-h', String(washHues[0]));
  root.setProperty('--wash-2-h', String(washHues[1]));
  root.setProperty('--wash-3-h', String(washHues[2]));
}

// Hue is a wheel but the CSS transition interpolates it as a plain number, so
// 351 -> 12 would sweep backwards through every colour between. Express the new
// hue as the value nearest the old one and it takes the 21-degree path instead.
function nearestHue(previous, next) {
  if (!Number.isFinite(previous)) return next;
  const delta = (((next - previous) % 360) + 540) % 360 - 180;
  return previous + delta;
}

/* -------------------------------------------------------------------- state */

function onState(state) {
  const changed = state.trackKey !== track.key;

  track.key = state.trackKey || '';
  track.hasTrack = !!state.hasTrack;
  track.playing = !!state.playing;
  track.positionMs = state.positionMs || 0;
  track.durationMs = state.durationMs || 0;
  track.updatedAt = state.updatedAt || Date.now();
  track.canSeek = !!state.canSeek || track.durationMs > 0;

  dom.body.classList.toggle('is-playing', track.playing);
  dom.body.classList.toggle('empty-state', !track.hasTrack);
  dom.body.classList.remove('loading');

  dom.playBtn.setAttribute('aria-label', track.playing ? 'Pause' : 'Play');
  dom.nextBtn.disabled = state.hasTrack && state.canNext === false;
  dom.prevBtn.disabled = state.hasTrack && state.canPrevious === false;
  dom.scrub.classList.toggle('is-disabled', !track.canSeek);

  if (changed || state.force) {
    dom.title.textContent = state.title || 'Nothing playing';
    dom.artist.textContent = state.artist || '';
    dom.album.textContent = state.album || '';
    // Theme 2 renders "Artist — Album" as one line, off this attribute.
    if (state.album) dom.artist.dataset.album = state.album;
    else delete dom.artist.dataset.album;
    document.title = state.title ? `${state.title} — ${state.artist}` : 'Now Playing';
    if (changed && state.hasTrack) replay();
  }

  applyPalette(state.palette);
  setArtwork(state.artHiRes || state.art || '');
  render();
  ensureLoop();
}

function replay() {
  dom.body.classList.remove('track-in');
  void dom.stage.offsetWidth; // restart the entrance animation
  dom.body.classList.add('track-in');
}

/* ----------------------------------------------------------------- position */

function position() {
  if (dragging) return dragRatio * track.durationMs;
  if (!track.playing) return clamp(track.positionMs, 0, track.durationMs);
  return clamp(track.positionMs + (Date.now() - track.updatedAt), 0, track.durationMs);
}

function render() {
  const duration = track.durationMs;
  const current = position();
  const ratio = duration > 0 ? clamp(current / duration, 0, 1) : 0;

  dom.scrubFill.style.width = `${ratio * 100}%`;
  dom.scrubKnob.style.left = `${ratio * 100}%`;
  dom.elapsed.textContent = format(current);
  dom.remaining.textContent = duration > 0 ? `-${format(duration - current)}` : '0:00';
}

function ensureLoop() {
  const wanted = visible && track.hasTrack;
  if (wanted && rafId === null) {
    const tick = () => {
      render();
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  } else if (!wanted && rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function format(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/* ----------------------------------------------------------------- controls */

function send(command, value) {
  window.player.command(command, value);
}

function togglePlay() {
  // Optimistic: the UI should never wait on Spotify to acknowledge.
  track.positionMs = position();
  track.updatedAt = Date.now();
  track.playing = !track.playing;
  dom.body.classList.toggle('is-playing', track.playing);
  send('playpause');
}

function seekTo(ms) {
  const target = clamp(ms, 0, track.durationMs);
  track.positionMs = target;
  track.updatedAt = Date.now();
  render();
  send('seek', target);
}

function seekBy(deltaMs) {
  if (track.durationMs > 0) seekTo(position() + deltaMs);
}

dom.playBtn.addEventListener('click', togglePlay);
dom.nextBtn.addEventListener('click', () => send('next'));
dom.prevBtn.addEventListener('click', () => send('prev'));
dom.closeBtn.addEventListener('click', () => window.player.close());

/* ---------------------------------------------------------------- scrubbing */

function ratioFromEvent(event) {
  const rect = dom.scrubTrack.getBoundingClientRect();
  return clamp((event.clientX - rect.left) / rect.width, 0, 1);
}

dom.scrub.addEventListener('pointerdown', (event) => {
  if (!track.canSeek || track.durationMs <= 0) return;
  dragging = true;
  dragRatio = ratioFromEvent(event);
  dom.scrub.classList.add('is-dragging');
  dom.scrub.setPointerCapture(event.pointerId);
  render();
});

dom.scrub.addEventListener('pointermove', (event) => {
  if (!dragging) return;
  dragRatio = ratioFromEvent(event);
  render();
});

function endDrag(event) {
  if (!dragging) return;
  dragging = false;
  dom.scrub.classList.remove('is-dragging');
  try {
    dom.scrub.releasePointerCapture(event.pointerId);
  } catch (_) {
    /* pointer already released */
  }
  seekTo(dragRatio * track.durationMs);
}

dom.scrub.addEventListener('pointerup', endDrag);
dom.scrub.addEventListener('pointercancel', endDrag);

/* ----------------------------------------------------------------- keyboard */

window.addEventListener('keydown', (event) => {
  switch (event.key) {
    case ' ':
      event.preventDefault();
      togglePlay();
      break;
    case 'ArrowRight':
      event.preventDefault();
      seekBy(5000);
      break;
    case 'ArrowLeft':
      event.preventDefault();
      seekBy(-5000);
      break;
    case 'Escape':
      window.player.close();
      break;
    case 'n':
    case 'N':
      send('next');
      break;
    case 'p':
    case 'P':
      send('prev');
      break;
    default:
      return;
  }
  wake();
});

/* --------------------------------------------------------- auto-hide chrome */

function wake() {
  dom.body.classList.remove('idle');
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!dragging) dom.body.classList.add('idle');
  }, 2800);
}

['mousemove', 'mousedown', 'wheel'].forEach((type) =>
  window.addEventListener(type, wake, { passive: true })
);

/* --------------------------------------------------------------- appearance */

function applyAppearance(appearance) {
  if (!appearance) return;

  const theme = appearance.theme || 'classic';
  document.documentElement.dataset.theme = theme;

  // The lock screen theme has no background picker — it is the drifting washes
  // by definition — so it pins the mode here rather than every background rule
  // in styles.css having to name the themes it applies to.
  document.documentElement.dataset.bg =
    theme === 'lockscreen' ? 'hues' : appearance.background || 'cover';

  const root = document.documentElement.style;
  root.setProperty('--bg-solid', appearance.backgroundColor || '#161a24');
  root.setProperty(
    '--bg-image',
    appearance.backgroundImage ? `url("${appearance.backgroundImage}")` : 'none'
  );

  // The imported faces have to be declared before anything can name them.
  faceStyle.textContent = appearance.fontFaceCss || '';
  document.documentElement.style.setProperty(
    '--font-stack',
    appearance.fontFamily ? `"${appearance.fontFamily}", ${DEFAULT_STACK}` : DEFAULT_STACK
  );

  clock24h = appearance.clock24h;
  tickClock();
}

/* -------------------------------------------------------------------- clock */

function timeOptions() {
  const options = { hour: 'numeric', minute: '2-digit' };
  // null means follow the locale, which is the default.
  if (clock24h === true) {
    options.hour12 = false;
    options.hour = '2-digit';
  } else if (clock24h === false) {
    options.hour12 = true;
  }
  return options;
}

function tickClock() {
  const now = new Date();
  dom.clock.textContent = now.toLocaleTimeString([], timeOptions());

  // Only theme 2 shows these, but keeping them current costs nothing and means
  // switching themes never shows a stale time for a frame.
  if (dom.lockClock) dom.lockClock.textContent = now.toLocaleTimeString([], timeOptions());
  if (dom.lockDate) {
    dom.lockDate.textContent = now.toLocaleDateString([], {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    });
  }
}

tickClock();
setInterval(tickClock, 15000);

/* --------------------------------------------------------------------- boot */

window.player.onVisibility((isVisible) => {
  visible = isVisible;
  if (isVisible) {
    tickClock();
    wake();
  }
  ensureLoop();
});

window.player.onState(onState);
window.player.onAppearance(applyAppearance);
window.player.ready();
wake();
