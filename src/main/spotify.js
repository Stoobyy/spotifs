'use strict';

const { EventEmitter } = require('events');
const { shell } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Spotify Web API playback source. Same contract as SmtcBridge — emits
 * 'state' with the normalised payload and 'status', accepts the same string
 * commands over send() — so main.js can swap one for the other.
 *
 * Auth is OAuth Authorization Code with PKCE. There is no client secret; the
 * user registers their own app in the Spotify dashboard, pastes the client ID
 * into Settings, and the redirect URI below must be added there verbatim.
 * Spotify matches redirect URIs exactly, ports included, which is why the
 * loopback port is fixed rather than picked at random.
 *
 * The Web API has no push channel, so this polls /me/player: 1s while the
 * player is on screen, backing off when it is hidden. Position is extrapolated
 * in the renderer between polls exactly as it is for the bridge.
 */

const AUTH_BASE = 'https://accounts.spotify.com';
const API_BASE = 'https://api.spotify.com/v1';
const CALLBACK_PORT = 48273;
const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}/callback`;
const SCOPES = ['user-read-playback-state', 'user-modify-playback-state', 'user-read-currently-playing'];

const POLL_VISIBLE_MS = 1000;
const POLL_HIDDEN_MS = 5000;
const POLL_AFTER_COMMAND_MS = 350; // the command has landed by then; confirm it
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;
const REFRESH_MARGIN_MS = 60 * 1000;

class SpotifyProvider extends EventEmitter {
  /**
   * @param {object} options
   * @param {() => string} options.clientId   read live so a paste in Settings applies without restart
   * @param {string} options.tokenFile        where the refresh token lives; not settings.json
   * @param {string} options.cacheDir         downloaded covers
   */
  constructor({ clientId, tokenFile, cacheDir }) {
    super();
    this.clientId = clientId;
    this.tokenFile = tokenFile;
    this.cacheDir = cacheDir;
    fs.mkdirSync(this.cacheDir, { recursive: true });

    this.tokens = this._loadTokens();
    this.running = false;
    this.visible = false;
    this.timer = null;
    this.polling = false;
    this.lastState = null;
    this.lastPlaying = false;
    this.pendingAuth = null;
    this.coverJobs = new Map();
  }

  /* ------------------------------------------------------------ lifecycle */

  get connected() {
    return !!(this.tokens && this.tokens.refresh_token);
  }

  start() {
    this.running = true;
    if (!this.connected) {
      this.emit('status', { connected: false, reason: 'not authorised' });
      this._emitEmpty();
      return;
    }
    this.emit('status', { connected: true });
    this._schedule(0);
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = null;
  }

  setVisible(visible) {
    this.visible = !!visible;
    // Coming back on screen: don't wait out the rest of a 5s hidden interval.
    if (this.running && this.visible) this._schedule(0);
  }

  /* ------------------------------------------------------------- commands */

  send(command) {
    if (!this.connected) return;
    const line = String(command).trim();
    let request = null;

    if (line === 'playpause') request = this.lastPlaying ? ['PUT', '/me/player/pause'] : ['PUT', '/me/player/play'];
    else if (line === 'play') request = ['PUT', '/me/player/play'];
    else if (line === 'pause') request = ['PUT', '/me/player/pause'];
    else if (line === 'next') request = ['POST', '/me/player/next'];
    else if (line === 'prev' || line === 'previous') request = ['POST', '/me/player/previous'];
    else {
      const seek = /^seek\s+(\d+)$/.exec(line);
      if (seek) request = ['PUT', `/me/player/seek?position_ms=${seek[1]}`];
    }
    if (!request) return;

    // Optimistic, like the bridge: flip local playing state so a second
    // playpause before the next poll does the right thing.
    if (line === 'playpause') this.lastPlaying = !this.lastPlaying;
    else if (line === 'play') this.lastPlaying = true;
    else if (line === 'pause') this.lastPlaying = false;

    this._api(request[0], request[1])
      .catch((err) => this.emit('log', { level: 'warn', message: `command '${line}' failed: ${err.message}` }))
      .finally(() => this._schedule(POLL_AFTER_COMMAND_MS));
  }

  /* ----------------------------------------------------------------- auth */

  /**
   * Opens the system browser on Spotify's consent page and waits for the one
   * redirect back to the loopback server. Resolves once tokens are stored.
   */
  authorize() {
    if (this.pendingAuth) return this.pendingAuth;

    const clientId = (this.clientId() || '').trim();
    if (!clientId) return Promise.reject(new Error('Add your Spotify client ID first.'));

    const verifier = base64url(crypto.randomBytes(64));
    const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
    const state = base64url(crypto.randomBytes(16));

    this.pendingAuth = new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        server.close();
        this.pendingAuth = null;
        if (err) reject(err);
        else resolve();
      };

      const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://127.0.0.1:${CALLBACK_PORT}`);
        if (url.pathname !== '/callback') {
          res.writeHead(404).end();
          return;
        }

        const error = url.searchParams.get('error');
        const code = url.searchParams.get('code');
        const gotState = url.searchParams.get('state');

        // Anything that isn't carrying our state is not our redirect - a stale
        // tab, a port scanner - and must not be allowed to abort the real one.
        if (gotState !== state) {
          res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Unexpected request.');
          return;
        }
        if (error || !code) {
          page(res, 'Spotify sign-in didn’t complete.', 'You can close this tab and try again from Settings.');
          finish(new Error(error === 'access_denied' ? 'Access was denied.' : 'Sign-in was rejected.'));
          return;
        }

        try {
          const tokens = await this._token({
            grant_type: 'authorization_code',
            code,
            redirect_uri: REDIRECT_URI,
            client_id: clientId,
            code_verifier: verifier,
          });
          this._saveTokens(tokens);
          page(res, 'Connected to Spotify.', 'You can close this tab and go back to Now Playing.');
          this.emit('status', { connected: true });
          if (this.running) this._schedule(0);
          finish();
        } catch (err) {
          page(res, 'Spotify sign-in failed.', err.message);
          finish(err);
        }
      });

      server.on('error', (err) => {
        finish(
          new Error(
            err.code === 'EADDRINUSE'
              ? `Port ${CALLBACK_PORT} is in use. Close whatever is listening on it and try again.`
              : err.message
          )
        );
      });

      const timeout = setTimeout(() => finish(new Error('Timed out waiting for Spotify.')), AUTH_TIMEOUT_MS);

      server.listen(CALLBACK_PORT, '127.0.0.1', () => {
        const params = new URLSearchParams({
          client_id: clientId,
          response_type: 'code',
          redirect_uri: REDIRECT_URI,
          code_challenge_method: 'S256',
          code_challenge: challenge,
          state,
          scope: SCOPES.join(' '),
        });
        shell.openExternal(`${AUTH_BASE}/authorize?${params}`);
      });
    });

    return this.pendingAuth;
  }

  disconnect() {
    this.stop();
    this.tokens = null;
    try {
      fs.unlinkSync(this.tokenFile);
    } catch (_) {
      /* already gone */
    }
    this.lastState = null;
    this.emit('status', { connected: false, reason: 'disconnected' });
    this._emitEmpty();
  }

  async _accessToken() {
    if (!this.tokens) throw new Error('not authorised');
    if (this.tokens.access_token && Date.now() < this.tokens.expires_at - REFRESH_MARGIN_MS) {
      return this.tokens.access_token;
    }
    // PKCE refreshes rotate the refresh token; whatever comes back is the new
    // one, and losing it means signing in again.
    const fresh = await this._token({
      grant_type: 'refresh_token',
      refresh_token: this.tokens.refresh_token,
      client_id: (this.clientId() || '').trim(),
    });
    if (!fresh.refresh_token) fresh.refresh_token = this.tokens.refresh_token;
    this._saveTokens(fresh);
    return this.tokens.access_token;
  }

  async _token(form) {
    const response = await fetch(`${AUTH_BASE}/api/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = body.error_description || body.error || `HTTP ${response.status}`;
      // A dead refresh token is the one failure that needs the user again.
      if (body.error === 'invalid_grant') {
        this.tokens = null;
        try { fs.unlinkSync(this.tokenFile); } catch (_) { /* ignore */ }
        this.emit('status', { connected: false, reason: 'sign-in expired' });
      }
      throw new Error(detail);
    }
    return body;
  }

  /** Authenticated call against the Web API. 204 is the normal success for commands. */
  async _api(method, endpoint) {
    const token = await this._accessToken();
    const response = await fetch(`${API_BASE}${endpoint}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Length': '0' },
    });
    if (response.status === 404) throw new Error('no active Spotify device');
    if (response.status === 403) throw new Error('not allowed (Premium required for playback control)');
    if (!response.ok && response.status !== 204) throw new Error(`HTTP ${response.status}`);
    return response;
  }

  _loadTokens() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.tokenFile, 'utf8'));
      return raw && raw.refresh_token ? raw : null;
    } catch (_) {
      return null;
    }
  }

  _saveTokens(response) {
    this.tokens = {
      access_token: response.access_token,
      refresh_token: response.refresh_token,
      expires_at: Date.now() + (Number(response.expires_in) || 3600) * 1000,
      scope: response.scope || SCOPES.join(' '),
    };
    fs.mkdirSync(path.dirname(this.tokenFile), { recursive: true });
    fs.writeFileSync(this.tokenFile, JSON.stringify(this.tokens, null, 2));
  }

  /* -------------------------------------------------------------- polling */

  _schedule(delay) {
    if (!this.running) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this._poll(), delay);
  }

  async _poll() {
    if (!this.running || this.polling) return;
    this.polling = true;
    let next = this.visible ? POLL_VISIBLE_MS : POLL_HIDDEN_MS;

    try {
      const token = await this._accessToken();
      const response = await fetch(`${API_BASE}/me/player`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (response.status === 204) {
        // Authorised, but nothing is playing anywhere on the account.
        this._emitEmpty();
      } else if (response.status === 429) {
        next = Math.max(next, (Number(response.headers.get('retry-after')) || 5) * 1000);
      } else if (response.status === 401) {
        // Access token rejected despite not being due; force a refresh next round.
        if (this.tokens) this.tokens.expires_at = 0;
      } else if (response.ok) {
        const body = await response.json();
        this._emitPlayer(body);
      } else {
        this.emit('log', { level: 'warn', message: `/me/player HTTP ${response.status}` });
      }
    } catch (err) {
      if (!this.connected) {
        this._emitEmpty();
        this.polling = false;
        return; // disconnected mid-poll; nothing to reschedule
      }
      this.emit('log', { level: 'warn', message: err.message });
      next = Math.max(next, 5000);
    }

    this.polling = false;
    this._schedule(next);
  }

  _emitEmpty() {
    const state = { playing: false, hasTrack: false };
    this.lastPlaying = false;
    this.lastState = state;
    this.emit('state', state);
  }

  _emitPlayer(body) {
    const item = body && body.item;
    if (!item || item.type !== 'track') {
      this._emitEmpty();
      return;
    }

    const now = Date.now();
    const artists = (item.artists || []).map((a) => a.name).filter(Boolean).join(', ');
    const album = (item.album && item.album.name) || '';
    const disallows = (body.actions && body.actions.disallows) || {};
    const image = pickImage(item.album && item.album.images);
    const albumId = (item.album && item.album.id) || item.id;

    this.lastPlaying = !!body.is_playing;

    const state = {
      hasTrack: true,
      playing: !!body.is_playing,
      status: body.is_playing ? 'playing' : 'paused',
      source: 'spotify',
      title: item.name || '',
      artist: artists,
      album,
      artPath: image ? this._coverPath(albumId, image) : '',
      positionMs: Number(body.progress_ms) || 0,
      durationMs: Number(item.duration_ms) || 0,
      updatedAt: now,
      canSeek: !disallows.seeking,
      canNext: !disallows.skipping_next,
      canPrevious: !disallows.skipping_prev,
      trackKey: `${item.name}|${artists}|${album}`,
    };

    this.lastState = state;
    this.emit('state', state);
  }

  /* -------------------------------------------------------------- artwork */

  /**
   * Covers are downloaded rather than handed to the renderer as URLs: the
   * palette extractor needs a file, the renderer's CSP is file-only, and it
   * keeps the two providers identical from the renderer's point of view.
   * Returns the cached path if present; otherwise '' now and a re-emit later.
   */
  _coverPath(albumId, url) {
    const file = path.join(this.cacheDir, `spotify-${albumId}.jpg`);
    if (fs.existsSync(file)) return file;

    if (!this.coverJobs.has(file)) {
      const job = fetch(url)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((buffer) => {
          fs.writeFileSync(file, Buffer.from(buffer));
          // The track may have changed while this was in flight.
          if (this.lastState && this.lastState.hasTrack && this.lastState.artPath === '') {
            this.lastState = Object.assign({}, this.lastState, { artPath: file });
            this.emit('state', this.lastState);
          }
        })
        .catch(() => {})
        .finally(() => this.coverJobs.delete(file));
      this.coverJobs.set(file, job);
    }
    return '';
  }
}

/* ------------------------------------------------------------------ helpers */

function pickImage(images) {
  if (!Array.isArray(images) || !images.length) return null;
  // Spotify lists largest first; take the biggest at or under 640 so the
  // download stays small. 640 is what they publish anyway.
  const sorted = images.slice().sort((a, b) => (b.width || 0) - (a.width || 0));
  return (sorted.find((i) => (i.width || 0) <= 640) || sorted[sorted.length - 1]).url;
}

function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function page(res, heading, detail) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>Now Playing</title>` +
      `<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#111;color:#eee;` +
      `font:15px/1.5 system-ui,sans-serif"><div style="text-align:center;padding:32px">` +
      `<h1 style="font-weight:600;font-size:22px;margin:0 0 8px">${heading}</h1>` +
      `<p style="margin:0;opacity:.7">${detail}</p></div>`
  );
}

module.exports = { SpotifyProvider, REDIRECT_URI, SCOPES };
