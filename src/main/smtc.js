'use strict';

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const path = require('path');

// PowerShell can't read out of app.asar, so packaged builds unpack the script
// (see asarUnpack in package.json) and we point at the unpacked copy.
const SCRIPT = path.join(__dirname, 'smtc-bridge.ps1').replace('app.asar', 'app.asar.unpacked');

/**
 * Owns the long-lived PowerShell process that talks to Windows' System Media
 * Transport Controls. Emits:
 *   'state'  -> normalised now-playing payload
 *   'status' -> { connected: boolean, reason?: string }
 */
class SmtcBridge extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    this.buffer = '';
    this.stopped = false;
    this.retryDelay = 1000;
    this.lastState = null;
  }

  start() {
    this.stopped = false;
    this._spawn();
  }

  stop() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this._kill();
  }

  send(command) {
    if (this.child && this.child.stdin.writable) {
      try {
        this.child.stdin.write(command + '\n');
      } catch (_) {
        /* pipe closed; the restart path will pick it up */
      }
    }
  }

  _kill() {
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    try {
      child.stdin.write('quit\n');
    } catch (_) { /* ignore */ }
    setTimeout(() => {
      try { child.kill(); } catch (_) { /* ignore */ }
    }, 250);
  }

  _spawn() {
    if (this.stopped) return;

    this.child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
    );

    this.buffer = '';

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this._onData(chunk));

    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (text) => {
      const trimmed = String(text).trim();
      if (trimmed) console.error('[smtc]', trimmed);
    });

    this.child.on('error', (err) => {
      this.emit('status', { connected: false, reason: err.message });
      this._scheduleRestart();
    });

    this.child.on('exit', (code) => {
      if (this.stopped) return;
      this.emit('status', { connected: false, reason: `bridge exited (${code})` });
      this._scheduleRestart();
    });
  }

  _scheduleRestart() {
    if (this.stopped || this.retryTimer) return;
    this.child = null;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retryDelay = Math.min(this.retryDelay * 2, 15000);
      this._spawn();
    }, this.retryDelay);
  }

  _onData(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;

      let message;
      try {
        message = JSON.parse(line);
      } catch (_) {
        continue;
      }
      this._onMessage(message);
    }
  }

  _onMessage(message) {
    switch (message.type) {
      case 'ready':
        this.retryDelay = 1000;
        this.emit('status', { connected: true });
        break;

      case 'log':
        if (message.level === 'error') console.error('[smtc]', message.message);
        else console.log('[smtc]', message.message);
        break;

      case 'state': {
        const state = normalise(message);
        this.lastState = state;
        this.emit('state', state);
        break;
      }

      default:
        break;
    }
  }
}

function normalise(raw) {
  if (!raw.hasSession || (!raw.title && !raw.artist)) {
    return { playing: false, hasTrack: false };
  }

  // The bridge reports Windows' own clock; translate to this process's clock so
  // the renderer can extrapolate position smoothly between updates.
  const skew = Date.now() - (raw.serverNow || Date.now());
  const updatedAt = (raw.updatedAt || raw.serverNow || Date.now()) + skew;

  return {
    hasTrack: true,
    playing: raw.status === 'playing',
    status: raw.status,
    source: raw.source || '',
    title: raw.title || '',
    artist: raw.artist || '',
    album: raw.album || '',
    artPath: raw.art || '',
    positionMs: Number(raw.positionMs) || 0,
    durationMs: Number(raw.durationMs) || 0,
    updatedAt,
    canSeek: !!raw.canSeek,
    canNext: !!raw.canNext,
    canPrevious: !!raw.canPrevious,
    trackKey: `${raw.title}|${raw.artist}|${raw.album}`,
  };
}

module.exports = { SmtcBridge };
