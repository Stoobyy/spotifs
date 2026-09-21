'use strict';

const { app } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

/**
 * Font sources for the player: the families already installed on the machine,
 * and any font file the user imports.
 *
 * Imported fonts are copied into userData rather than referenced where they sit,
 * so moving or deleting the original doesn't silently break the display later.
 * The CSS family name is derived from the file name — @font-face lets us name a
 * face whatever we like, so there is no need to parse the font's own name table.
 */

const ALLOWED = new Set(['.ttf', '.otf', '.woff', '.woff2', '.ttc']);

// Enumerating installed families needs a shell out; the list only changes when
// the user installs a font, so it is read once and kept.
let systemCache = null;

function fontDir() {
  return path.join(app.getPath('userData'), 'fonts');
}

function listSystemFonts() {
  if (systemCache) return Promise.resolve(systemCache);

  // Windows: PowerShell's InstalledFontCollection. Everywhere else: fontconfig,
  // which every Linux desktop has and Homebrew installs on macOS; without it the
  // list is simply empty and importing a file still works.
  const command =
    process.platform === 'win32'
      ? [
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
            'Add-Type -AssemblyName System.Drawing; ' +
            '(New-Object System.Drawing.Text.InstalledFontCollection).Families | ' +
            'ForEach-Object { $_.Name }'],
        ]
      : ['fc-list', [':', 'family']];

  return new Promise((resolve) => {
    execFile(
      command[0],
      command[1],
      { windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          console.error('[fonts]', err.message);
          resolve([]);
          return;
        }
        const names = String(stdout)
          .split(/\r?\n/)
          // fc-list prints "Family A,Family B" for faces with several names.
          .flatMap((line) => line.split(','))
          .map((line) => line.trim())
          .filter(Boolean);
        systemCache = Array.from(new Set(names)).sort((a, b) => a.localeCompare(b));
        resolve(systemCache);
      }
    );
  });
}

/** Turns "JetBrains Mono NL.ttf" into "JetBrains Mono NL". */
function familyFromFile(filePath) {
  return path
    .basename(filePath, path.extname(filePath))
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueFamily(family, taken) {
  if (!taken.includes(family)) return family;
  let n = 2;
  while (taken.includes(`${family} ${n}`)) n += 1;
  return `${family} ${n}`;
}

/**
 * Copies a font file into userData and returns its record, or throws with a
 * message worth showing the user.
 */
function importFont(sourcePath, existing) {
  const ext = path.extname(sourcePath).toLowerCase();
  if (!ALLOWED.has(ext)) {
    throw new Error(`${ext || 'That file'} isn't a font file. Use .ttf, .otf, .ttc, .woff or .woff2.`);
  }

  const dir = fontDir();
  fs.mkdirSync(dir, { recursive: true });

  const family = uniqueFamily(
    familyFromFile(sourcePath) || 'Imported font',
    (existing || []).map((f) => f.family)
  );
  const target = path.join(dir, `${Date.now().toString(36)}${ext}`);
  fs.copyFileSync(sourcePath, target);

  return { family, file: target };
}

function removeFont(record) {
  if (!record || !record.file) return;
  try {
    fs.unlinkSync(record.file);
  } catch (_) {
    /* already gone; the record is being dropped either way */
  }
}

/** Drops records whose file has disappeared, so the UI never offers a dead font. */
function prune(customFonts) {
  return (customFonts || []).filter((f) => f && f.file && fs.existsSync(f.file));
}

/** @font-face rules for the imported fonts, injected into the player. */
function faceCss(customFonts) {
  return prune(customFonts)
    .map((f) => {
      const url = pathToFileURL(f.file).href;
      const name = String(f.family).replace(/["\\]/g, '');
      return `@font-face{font-family:"${name}";src:url("${url}");font-display:swap;}`;
    })
    .join('\n');
}

module.exports = { listSystemFonts, importFont, removeFont, prune, faceCss };
