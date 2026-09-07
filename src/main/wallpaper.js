'use strict';

const { app } = require('electron');
const path = require('path');
const fs = require('fs');

/**
 * The picture behind the player when the background is set to "Image".
 *
 * Same bargain as an imported font: the file is copied into userData rather
 * than referenced where it sits, so moving or deleting the original later
 * doesn't leave the display on a broken background. Only one is kept — this is
 * a wallpaper, not a library — so importing a second one replaces the first.
 */

const ALLOWED = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif', '.avif']);

function dir() {
  return path.join(app.getPath('userData'), 'backgrounds');
}

/** Copies an image into userData and returns its path, or throws. */
function importImage(sourcePath, previous) {
  const ext = path.extname(sourcePath).toLowerCase();
  if (!ALLOWED.has(ext)) {
    throw new Error(`${ext || 'That file'} isn't an image. Use .jpg, .png, .webp, .gif or .bmp.`);
  }

  const target = path.join(dir(), `${Date.now().toString(36)}${ext}`);
  fs.mkdirSync(dir(), { recursive: true });
  fs.copyFileSync(sourcePath, target);

  // One wallpaper at a time; the old copy is dead weight the moment this lands.
  if (previous && previous !== target) removeImage(previous);

  return target;
}

function removeImage(filePath) {
  if (!filePath) return;
  try {
    fs.unlinkSync(filePath);
  } catch (_) {
    /* already gone; the setting is being cleared either way */
  }
}

/** '' if the file has disappeared, so the UI never offers a dead background. */
function prune(filePath) {
  if (!filePath) return '';
  try {
    return fs.existsSync(filePath) ? filePath : '';
  } catch (_) {
    return '';
  }
}

module.exports = { importImage, removeImage, prune };
