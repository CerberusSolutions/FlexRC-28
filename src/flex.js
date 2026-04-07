'use strict';

/**
 * FlexRadio SmartSDR TCP API Module
 *
 * Connects to the radio on port 4992 via plain TCP socket.
 * Commands are plain-text, newline terminated.
 * Format:  C<seq>|<command>\n
 * Response: R<seq>|<status>|<message>\n
 * Status:   Sxxxxxxxx|<key>=<val> ...\n  (unsolicited status)
 *
 * Key commands used:
 *   sub slice all                → subscribe to slice status
 *   slice X tune <freq_mhz>      → tune slice X to frequency
 *   slice X rit_freq <hz>        → set RIT offset in Hz
 *   slice X rit_on=1             → enable RIT
 *   slice X rit_on=0             → disable RIT
 *   transmit set transmit=1      → PTT on
 *   transmit set transmit=0      → PTT off
 *   info                         → get station/radio info
 */

const net = require('net');
const EventEmitter = require('events');
const dgram = require('dgram');
//const { modeId, modeName } = require('./modes');
const { modeId, modeName, tuneFloor } = require('./modes');

const FLEX_PORT = 4992;
const DISCOVERY_PORT = 4992;
const DISCOVERY_INTERVAL_MS = 2000;

class FlexRadio extends EventEmitter {
  constructor() {
    super();
    this.socket = null;
    this._seq = 1;
    this._pendingCmds = new Map();   // seq -> { resolve, reject, cmd }
    this._buffer = '';
    this._connected = false;
    this._handle = null;             // our client handle from radio
    this._slices = new Map();        // slice_id -> { freq_mhz, mode, rit_on, rit_freq, ... }
    this._activeSlice = null;
    this._stationName = null;
    this._radioIP = null;
    this._discoverySocket = null;
  }

  // ── Discovery ──────────────────────────────────────────────────────────

  /**
   * Listen for FlexRadio discovery UDP broadcasts.
   * Emits 'radioFound' with { ip, name, model, version }
   */
  startDiscovery() {
    if (this._discoverySocket) return;

    this._discoverySocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    this._discoverySocket.bind(4992, '0.0.0.0', () => {
      try {
        this._discoverySocket.setBroadcast(true);
      } catch (_) {}
    });

    this._discoverySocket.on('message', (msg, rinfo) => {
      const text = msg.toString();
      if (!text.includes('model=') && !text.includes('nickname=')) return;

      const fields = {};
      text.split(' ').forEach(pair => {
        const eqIdx = pair.indexOf('=');
        if (eqIdx > 0) {
          fields[pair.slice(0, eqIdx).trim()] = pair.slice(eqIdx + 1).trim();
        }
      });

      // Use sender IP as fallback if not in packet
      const ip = fields.ip || rinfo.address;
      this.emit('radioFound', {
        ip,
        name:    fields.nickname || fields.callsign || ip,
        model:   fields.model || 'FlexRadio',
        version: fields.version || '',
      });
    });

    this._discoverySocket.on('error', () => {
      // Discovery failure is non-fatal
    });
  }

  stopDiscovery() {
    if (this._discoverySocket) {
      try { this._discoverySocket.close(); } catch (_) {}
      this._discoverySocket = null;
    }
  }

  // ── Connection ──────────────────────────────────────────────────────────

  /**
   * Connect to radio at given IP.
   * @param {string} ip  Radio IP address
   * @param {string} stationName  Station name to listen for in sub slice
   */
  connect(ip, stationName = null) {
    this._radioIP = ip;
    this._stationName = stationName;

    return new Promise((resolve, reject) => {
      this.socket = new net.Socket();

      this.socket.connect(FLEX_PORT, ip, () => {
        this._connected = true;
        this.emit('connected', ip);
      });

      this.socket.on('data', (data) => {
        this._buffer += data.toString();
        this._processBuffer();
      });

      this.socket.on('close', () => {
        this._connected = false;
        this._slices.clear();
        this.emit('disconnected');
      });

      this.socket.on('error', (err) => {
        this._connected = false;
        reject(err);
        this.emit('error', err);
      });

      // Resolve once we receive the version handshake
      const onVersion = (version) => {
        this.removeListener('version', onVersion);
        resolve(version);
        this._init();
      };
      this.once('version', onVersion);

      setTimeout(() => {
        this.removeListener('version', onVersion);
        reject(new Error('Connection timeout — no response from radio'));
      }, 5000);
    });
  }

  disconnect() {
    if (this.socket) {
      try { this.socket.destroy(); } catch (_) {}
      this.socket = null;
    }
    this._connected = false;
  }

  isConnected() {
    return this._connected;
  }

  async _init() {
    // Do NOT send "client gui" — that creates a new MultiFLEX station
    // Just subscribe to status and we'll use xmit for PTT

    const cmds = [
      'sub slice all',
      'sub tx all',
      'sub atu all',
      'info',
      'slice list',
    ];

    for (const cmd of cmds) {
      try {
        await this.sendCmd(cmd);
      } catch (e) {
        this.emit('log', `init cmd failed: ${cmd} — ${e.message}`);
      }
    }
  }

  // ── Command Interface ───────────────────────────────────────────────────

  /**
   * Send a command and return a promise that resolves with the response.
   * @param {string} cmd
   */
  sendCmd(cmd) {
    return new Promise((resolve, reject) => {
      if (!this._connected) {
        return reject(new Error('Not connected to radio'));
      }
      const seq = this._seq++;
      this._pendingCmds.set(seq, { resolve, reject, cmd });
      this.socket.write(`C${seq}|${cmd}\n`);

      setTimeout(() => {
        if (this._pendingCmds.has(seq)) {
          this._pendingCmds.delete(seq);
          reject(new Error(`Command timeout: ${cmd}`));
        }
      }, 3000);
    });
  }

  // ── Tuning ──────────────────────────────────────────────────────────────

  /**
   * Tune the active slice by a number of Hz.
   * @param {number} deltaHz  Positive = up, negative = down
   */
  /*
  async tune(deltaHz) {
    const slice = this._getActiveSlice();
    if (!slice) return;

    if (slice.rit_on) {
      const newRit = (slice.rit_freq || 0) + deltaHz;
      await this.setRIT(slice.id, newRit);
    } else {
      if (!slice.freq_mhz) return;
      const newFreq = slice.freq_mhz + (deltaHz / 1_000_000);
      if (newFreq < 0.1 || newFreq > 60) return;
      slice.freq_mhz = newFreq;
      await this.sendCmd(`slice tune ${slice.id} ${newFreq.toFixed(6)}`);
    }
  }
*/
  async tune(deltaHz) {
  const slice = this._getActiveSlice();
  if (!slice) return;

  if (slice.rit_on) {
    const newRit = (slice.rit_freq || 0) + deltaHz;
    await this.setRIT(slice.id, newRit);
  } else {
    if (!slice.freq_mhz) return;

    const floorHz = tuneFloor(slice.mode);
    let freqHz = Math.round(slice.freq_mhz * 1_000_000);

    // Snap current frequency to the mode floor before applying wheel delta
    const remainder = freqHz % floorHz;
    if (remainder !== 0) {
      freqHz = Math.round(freqHz / floorHz) * floorHz;
    }

    const newFreqHz = freqHz + deltaHz;
    const newFreq = newFreqHz / 1_000_000;

    if (newFreq < 0.1 || newFreq > 60) return;

    slice.freq_mhz = newFreq;
    await this.sendCmd(`slice tune ${slice.id} ${newFreq.toFixed(6)}`);
  }
}

  /**
   * Set slice frequency in MHz.
   */
  async setFrequency(sliceId, freqMHz) {
    const slice = this._slices.get(sliceId);
    if (!slice) return;
    // Don't update local cache here — wait for the radio's status response
    // which will come back via 'S' message and trigger sliceUpdated properly
    await this.sendCmd(`slice tune ${sliceId} ${freqMHz.toFixed(6)}`);
  }

  /**
   * Set RIT offset in Hz.
   */
  async setRIT(sliceId, hz) {
    const slice = this._slices.get(sliceId);
    if (!slice) return;
    const clamped = Math.max(-9999, Math.min(9999, Math.round(hz)));
    slice.rit_freq = clamped;
    await this.sendCmd(`slice set ${sliceId} rit_freq=${clamped}`);
    this.emit('ritChanged', sliceId, clamped);
    this.emit('sliceUpdated', sliceId, { ...slice });
  }

  async clearRIT(sliceId) {
    await this.sendCmd(`slice set ${sliceId} rit_freq=0`);
    const slice = this._slices.get(sliceId);
    if (slice) { slice.rit_freq = 0; this.emit('sliceUpdated', sliceId, { ...slice }); }
    this.emit('ritChanged', sliceId, 0);
  }

  async enableRIT(sliceId, enabled) {
    const slice = this._slices.get(sliceId);
    if (!slice) return;
    slice.rit_on = enabled;
    await this.sendCmd(`slice set ${sliceId} rit_on=${enabled ? 1 : 0}`);
    this.emit('ritModeChanged', sliceId, enabled);
    this.emit('sliceUpdated', sliceId, { ...slice });
  }

  // ── PTT ────────────────────────────────────────────────────────────────

  async setPTT(on) {
    // Correct SmartSDR API PTT command is "xmit 1" / "xmit 0"
    // NOT "transmit set transmit=1" which requires interlock ownership
    await this.sendCmd(`xmit ${on ? 1 : 0}`);
    this.emit('pttChanged', on);
  }

  // ── Snap Tuning ────────────────────────────────────────────────────────

  /**
   * Snap the active slice to nearest 1kHz step.
   */
  async snapToKHz() {
    const slice = this._getActiveSlice();
    if (!slice || !slice.freq_mhz) return;
    const snapped = Math.round(slice.freq_mhz * 1000) / 1000;
    slice.freq_mhz = snapped;
    await this.sendCmd(`slice tune ${slice.id} ${snapped.toFixed(6)}`);
  }

  /**
   * Change the mode of a slice.
   * @param {number} sliceId
   * @param {string} mode  e.g. 'USB', 'LSB', 'CW', 'AM', 'DIGU'
   */
  async setMode(sliceId, mode) {
    const slice = this._slices.get(sliceId);
    if (!slice) return;
    slice.mode = modeId(mode);
    await this.sendCmd(`slice set ${sliceId} mode=${modeName(slice.mode)}`);
    this.emit('sliceUpdated', sliceId, { ...slice });
  }

  /**
   * Jump to a band — tunes to frequency and sets mode.
   * @param {number} sliceId
   * @param {number} freqMHz
   * @param {string} mode
   */
  async changeBand(sliceId, freqMHz, mode) {
    const slice = this._slices.get(sliceId);
    if (!slice) return;
    // Set mode first, then tune
    slice.mode = modeId(mode);
    slice.freq_mhz = freqMHz;
    await this.sendCmd(`slice set ${sliceId} mode=${modeName(slice.mode)}`);
    await this.sendCmd(`slice tune ${sliceId} ${freqMHz.toFixed(6)}`);
    this.emit('sliceUpdated', sliceId, { ...slice });
  }

  // ── Slice Management ───────────────────────────────────────────────────

  getSlices() {
    return Array.from(this._slices.values()).map(s => ({ ...s }));
  }

  getActiveSlice() {
    return this._getActiveSlice();
  }

  setActiveSlice(sliceId) {
    this._activeSlice = sliceId;
    this.emit('activeSliceChanged', sliceId);
  }

  _getActiveSlice() {
    if (this._activeSlice !== null && this._slices.has(this._activeSlice)) {
      return this._slices.get(this._activeSlice);
    }
    // Default to first slice
    const first = this._slices.values().next().value;
    if (first) this._activeSlice = first.id;
    return first || null;
  }

  // ── Protocol Parser ────────────────────────────────────────────────────

  _processBuffer() {
    const lines = this._buffer.split('\n');
    this._buffer = lines.pop();  // keep incomplete line

    for (const line of lines) {
      const l = line.trim();
      if (!l) continue;
      this._parseLine(l);
    }
  }

  _parseLine(line) {
    const type = line[0];

    switch (type) {
      case 'V': {
        // Version: V1.0.0.0
        const version = line.slice(1);
        this.emit('version', version);
        break;
      }
      case 'H': {
        // Handle: H<hex_handle>
        this._handle = line.slice(1);
        break;
      }
      case 'R': {
        // Response: R<seq>|<status>|<message>
        const parts = line.slice(1).split('|');
        const seq = parseInt(parts[0], 10);
        const status = parseInt(parts[1], 16);
        const pending = this._pendingCmds.get(seq);
        if (pending) {
          this._pendingCmds.delete(seq);
          if (status === 0) {
            pending.resolve(parts[2] || '');
          } else {
            pending.reject(new Error(`Command failed (0x${parts[1]}): ${pending.cmd}`));
          }
        }
        break;
      }
      case 'S': {
        // Status: S<handle>|<object> <key>=<val> ...
        const pipeIdx = line.indexOf('|');
        if (pipeIdx < 0) break;
        const body = line.slice(pipeIdx + 1);
        this._parseStatus(body);
        break;
      }
      case 'M': {
        // Message from radio
        const pipeIdx = line.indexOf('|');
        if (pipeIdx >= 0) {
          this.emit('message', line.slice(pipeIdx + 1));
        }
        break;
      }
    }
  }

  _parseStatus(body) {
    this.emit('raw', body);

    // SmartSDR status body format:
    //   "slice 0 RF_frequency=14.225000 mode=USB ..."
    //   "transmit transmit=0 ..."
    //   "info model=FLEX-6400 ..."
    //
    // Object is one or two tokens before the first key=value pair.
    // Detect by checking if token[1] is a number (slice/display/panadapter)
    // or a key=value (single-token objects like transmit, info)

    const tokens = body.split(' ');
    let objectType, objectId, kvStart;

    if (tokens.length > 1 && /^\d+$/.test(tokens[1])) {
      // Two-token object: "slice 0", "panadapter 0x..."
      objectType = tokens[0];
      objectId   = tokens[1];
      kvStart    = tokens.slice(2);
    } else {
      // Single-token object: "transmit", "info", "atu"
      objectType = tokens[0];
      objectId   = null;
      kvStart    = tokens.slice(1);
    }

    // Parse key=value pairs
    const kv = {};
    kvStart.forEach(pair => {
      const eqIdx = pair.indexOf('=');
      if (eqIdx > 0) {
        kv[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
      }
    });

    if (objectType === 'slice' && objectId !== null) {
      const id = parseInt(objectId, 10);
      if (isNaN(id)) return;

      if (!this._slices.has(id)) {
        this._slices.set(id, { id });
      }
      const slice = this._slices.get(id);

      if (kv.RF_frequency !== undefined) slice.freq_mhz = parseFloat(kv.RF_frequency);
      if (kv.mode         !== undefined) slice.mode = modeId(kv.mode);  // normalise to integer
      if (kv.rit_on       !== undefined) slice.rit_on = kv.rit_on === '1';
      if (kv.rit_freq     !== undefined) slice.rit_freq = parseInt(kv.rit_freq, 10);
      if (kv.active       !== undefined && kv.active === '1') this._activeSlice = id;

      this.emit('sliceUpdated', id, { ...slice });
      return;
    }

    if (objectType === 'transmit') {
      if (kv.transmit !== undefined) {
        this.emit('pttChanged', kv.transmit === '1');
      }
      return;
    }

    if (objectType === 'info') {
      this.emit('radioInfo', kv);
    }
  }

  /**
   * Dump all raw lines from the radio to help debug — call during development.
   * Usage: flex.on('raw', line => console.log('RAW:', line))
   */
  enableRawLogging() {
    this.on('raw', line => console.log('[FLEX RAW]', line));
    this.on('log', msg  => console.log('[FLEX]', msg));
  }
}

module.exports = { FlexRadio };