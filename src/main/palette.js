'use strict';

const { nativeImage } = require('electron');

/**
 * Pulls one accent colour out of a cover. Deliberately conservative: hues get
 * bucketed, the busiest colourful bucket wins, then saturation and lightness
 * are clamped into a narrow band so a neon album cover can't blow out the UI.
 * Runs in the main process — a file:// canvas in the renderer would be tainted.
 */

const SIZE = 36;
const cache = new Map();
const NEUTRAL = { h: 220, s: 10, l: 60, hues: [220, 258, 182] };

// Two washes drifting past a third read as slowly shifting colour. Any closer
// than this in hue and the movement stops being visible.
const HUE_SPREAD = 26;

// A hue has to account for at least this share of the busiest bin's weight
// before it earns a wash. Without a floor, a cover with a few percent of some
// unrelated colour promotes it to a full-screen field, which is what made the
// backdrop look like it had colours the artwork doesn't.
const MIN_SHARE = 0.18;

// When a cover genuinely has only one or two hues, the rest are derived as
// close neighbours of the dominant one. Fanning further out invents colours
// that are nowhere in the artwork.
const ANALOGOUS_STEP = 14;

function paletteFor(filePath) {
  if (!filePath) return NEUTRAL;
  if (cache.has(filePath)) return cache.get(filePath);

  let result = NEUTRAL;
  try {
    const image = nativeImage.createFromPath(filePath);
    if (!image.isEmpty()) {
      const small = image.resize({ width: SIZE, height: SIZE, quality: 'good' });
      result = analyse(small.toBitmap(), small.getSize());
    }
  } catch (_) {
    result = NEUTRAL;
  }

  cache.set(filePath, result);
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return result;
}

function analyse(bitmap, size) {
  const total = size.width * size.height;
  if (!bitmap || bitmap.length < total * 4) return NEUTRAL;

  const bins = new Array(24).fill(null).map(() => ({ weight: 0, s: 0, l: 0, x: 0, y: 0 }));
  let colourful = 0;

  for (let i = 0; i < total; i += 1) {
    const offset = i * 4;
    // Electron hands back BGRA on Windows.
    const b = bitmap[offset];
    const g = bitmap[offset + 1];
    const r = bitmap[offset + 2];
    const a = bitmap[offset + 3];
    if (a < 200) continue;

    const [h, s, l] = rgbToHsl(r, g, b);
    if (l < 0.12 || l > 0.93 || s < 0.14) continue;

    // Mid-tones describe an image's character better than its extremes.
    const weight = s * (1 - Math.abs(l - 0.5) * 0.9);
    const bin = bins[Math.min(23, Math.floor((h / 360) * 24))];
    const radians = (h * Math.PI) / 180;

    bin.weight += weight;
    bin.s += s * weight;
    bin.l += l * weight;
    bin.x += Math.cos(radians) * weight;
    bin.y += Math.sin(radians) * weight;
    colourful += 1;
  }

  if (colourful < total * 0.02) return NEUTRAL;

  const ranked = bins.filter((bin) => bin.weight > 0).sort((a, b) => b.weight - a.weight);
  if (ranked.length === 0) return NEUTRAL;

  const best = ranked[0];
  const hue = binHue(best);

  // The busiest bins that aren't near-neighbours *and* carry real weight, for
  // the ambient washes. Same scan, same bins — a sort over 24 entries.
  const floor = best.weight * MIN_SHARE;
  const hues = [];
  for (const bin of ranked) {
    if (bin.weight < floor) break; // ranked descending, so nothing after this qualifies
    const candidate = binHue(bin);
    if (hues.every((existing) => hueGap(existing, candidate) >= HUE_SPREAD)) hues.push(candidate);
    if (hues.length === 3) break;
  }
  // A cover with only one significant hue still needs three washes. Sit them
  // either side of the dominant hue so the backdrop stays in its colour family.
  const offsets = [0, ANALOGOUS_STEP, -ANALOGOUS_STEP, 2 * ANALOGOUS_STEP];
  for (let i = 1; hues.length < 3; i += 1) {
    hues.push(Math.round((hue + offsets[i] + 360) % 360));
  }

  return {
    h: Math.round(hue),
    s: Math.round(clamp(best.s / best.weight, 0.3, 0.62) * 100),
    l: Math.round(clamp(best.l / best.weight, 0.48, 0.68) * 100),
    hues,
  };
}

function binHue(bin) {
  let hue = (Math.atan2(bin.y, bin.x) * 180) / Math.PI;
  if (hue < 0) hue += 360;
  return Math.round(hue);
}

function hueGap(a, b) {
  const delta = Math.abs(a - b) % 360;
  return Math.min(delta, 360 - delta);
}

function rgbToHsl(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const delta = max - min;

  if (delta === 0) return [0, 0, l];

  const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let h;
  if (max === rn) h = ((gn - bn) / delta) % 6;
  else if (max === gn) h = (bn - rn) / delta + 2;
  else h = (rn - gn) / delta + 4;

  h *= 60;
  if (h < 0) h += 360;
  return [h, s, l];
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

module.exports = { paletteFor };
