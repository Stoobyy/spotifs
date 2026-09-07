'use strict';

/**
 * Windows only hands us a small thumbnail (Spotify publishes ~300px), which
 * looks soft blown up to full screen. When we're online we quietly look the
 * album up in Apple's public iTunes Search API and cache a high-resolution
 * cover next to it. Everything here fails silently — the SMTC thumbnail is
 * always the fallback.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const SIZE = '1400x1400';
const TIMEOUT = 6000;

class ArtworkResolver {
  constructor(cacheDir) {
    this.cacheDir = cacheDir;
    this.memory = new Map(); // trackKey -> filePath | null
    this.inFlight = new Map();
    fs.mkdirSync(this.cacheDir, { recursive: true });
  }

  /** @returns {Promise<string|null>} absolute path to a cached hi-res cover */
  resolve(track) {
    const key = `${track.artist}|${track.album || track.title}`.toLowerCase();
    if (this.memory.has(key)) return Promise.resolve(this.memory.get(key));
    if (this.inFlight.has(key)) return this.inFlight.get(key);

    const hash = crypto.createHash('md5').update(key).digest('hex');
    const file = path.join(this.cacheDir, `${hash}.jpg`);
    if (fs.existsSync(file) && fs.statSync(file).size > 1024) {
      this.memory.set(key, file);
      return Promise.resolve(file);
    }

    const job = this._fetch(track, file)
      .then((result) => {
        this.memory.set(key, result);
        this.inFlight.delete(key);
        return result;
      })
      .catch(() => {
        this.memory.set(key, null);
        this.inFlight.delete(key);
        return null;
      });

    this.inFlight.set(key, job);
    return job;
  }

  async _fetch(track, file) {
    if (!track.artist && !track.title) return null;

    const term = [track.artist, track.album || track.title].filter(Boolean).join(' ');
    const entity = track.album ? 'album' : 'song';
    const url =
      'https://itunes.apple.com/search?media=music&limit=5&entity=' +
      entity +
      '&term=' +
      encodeURIComponent(term);

    const body = await get(url);
    const payload = JSON.parse(body);
    const results = Array.isArray(payload.results) ? payload.results : [];
    if (!results.length) return null;

    const wanted = normalise(track.album || track.title);
    const best =
      results.find((item) => normalise(item.collectionName || item.trackName || '') === wanted) ||
      results[0];

    const small = best.artworkUrl100 || best.artworkUrl60;
    if (!small) return null;

    const large = small.replace(/\/\d+x\d+bb\.(jpg|png)$/i, `/${SIZE}bb.jpg`);
    const image = await get(large, true);
    if (!image || image.length < 4096) return null;

    fs.writeFileSync(file, image);
    return file;
  }
}

function get(url, binary = false, redirects = 0) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      { headers: { 'User-Agent': 'spotifs/1.0' }, timeout: TIMEOUT },
      (response) => {
        const status = response.statusCode || 0;

        if (status >= 300 && status < 400 && response.headers.location && redirects < 3) {
          response.resume();
          resolve(get(response.headers.location, binary, redirects + 1));
          return;
        }
        if (status !== 200) {
          response.resume();
          reject(new Error(`HTTP ${status}`));
          return;
        }

        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const buffer = Buffer.concat(chunks);
          resolve(binary ? buffer : buffer.toString('utf8'));
        });
      }
    );

    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
  });
}

function normalise(text) {
  return String(text)
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

module.exports = { ArtworkResolver };
