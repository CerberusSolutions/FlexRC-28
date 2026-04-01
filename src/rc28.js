'use strict';

/**
 * RC28 HID Module
 * Uses WebHID API (available in Electron renderer/main via session)
 * Falls back to node-hid if available.
 *
 * IMPORTANT: In Electron, WebHID is accessed via the utility process or
 * via IPC from renderer. This module is designed to be called from main
 * process using Electron's HID APIs.
 */

const EventEmitter = require('events');

const RC28_VID = 0x0C26;
const RC28_PID = 0x001E;
const HOLD_THRESHOLD_MS = 600;

class RC28 extends EventEmitter {
  constructor() {
    super();
    this.device = null;
    this._buttonState = 0x07;
    this._buttonPressTime = {};
    this._dialAccumulator = 0;
    this._dialTimer = null;
    this._connected = false;
    this._linkSolid = false;
    this._txOn = false;
    this._f1On = false;
    this._f2On = false;
  }

  open() {
    // Try node-hid first (works in main process)
    try {
      const HID = require('node-hid');
      const devices = HID.devices();
      const rc28 = devices.find(d => d.vendorId === RC28_VID && d.productId === RC28_PID);

      if (!rc28) {
        this.emit('error', new Error('RC-28 not found. Is it plugged in?'));
        return false;
      }

      this.device = new HID.HID(rc28.path);
      this._useNodeHID = true;
      this._connected = true;

      this.device.on('data', (data) => this._onData(data));
      this.device.on('error', (err) => {
        this._connected = false;
        this.emit('disconnected');
        this.emit('error', err);
      });

      this.emit('connected', rc28);
      this.setLinkLED('blink');
      return true;

    } catch (e) {
      // node-hid not available — emit helpful error
      this.emit('error', new Error(
        `RC-28: Could not load HID driver. Error: ${e.message}`
      ));
      return false;
    }
  }

  close() {
    if (this.device) {
      try { this.device.close(); } catch (_) {}
      this.device = null;
    }
    this._connected = false;
  }

  isConnected() { return this._connected; }

  // ── LED Control ──────────────────────────────────────────────────────────

  setLinkLED(state) { this._linkSolid = (state === 'solid'); this._updateLEDs(); }
  setTxLED(on)      { this._txOn = on; this._updateLEDs(); }
  setF1LED(on)      { this._f1On = on; this._updateLEDs(); }
  setF2LED(on)      { this._f2On = on; this._updateLEDs(); }

  _updateLEDs() {
    let b = 0x0F;
    if (this._linkSolid) b &= ~0x08;
    if (this._txOn)      b &= ~0x01;
    if (this._f1On)      b &= ~0x02;
    if (this._f2On)      b &= ~0x04;
    this._sendLED(b);
  }

  _sendLED(ledByte) {
    if (!this.device) return;
    try {
      const report = new Array(33).fill(0);
      report[0] = 0x00;
      report[1] = 0x01;
      report[2] = ledByte;
      this.device.write(report);
    } catch (_) {}
  }

  // ── Data Parsing ─────────────────────────────────────────────────────────

  _onData(data) {
    if (!data || data.length < 6) return;
    if (data[0] !== 0x01) return;

    const speed = data[1];
    const dir   = data[3];
    const btns  = data[5];

    if (speed > 0 && (dir === 0x01 || dir === 0x02)) {
      this._handleDial(dir, speed);
    }
    if (btns !== this._buttonState) {
      this._handleButtons(btns, this._buttonState);
      this._buttonState = btns;
    }
  }

  _handleDial(dir, speed) {
    const steps = dir === 0x01 ? speed : -speed;
    this._dialAccumulator += steps;
    if (this._dialTimer) return;
    this._dialTimer = setTimeout(() => {
      this._dialTimer = null;
      const total = this._dialAccumulator;
      this._dialAccumulator = 0;
      this.emit('dial', total, Math.abs(total));
    }, 10);
  }

  _handleButtons(newBtns, oldBtns) {
    const now = Date.now();
    const buttons = [
      { bit: 0, name: 'ptt' },
      { bit: 1, name: 'f1'  },
      { bit: 2, name: 'f2'  },
    ];
    for (const btn of buttons) {
      const wasPressed = (oldBtns & (1 << btn.bit)) === 0;
      const isPressed  = (newBtns & (1 << btn.bit)) === 0;
      if (!wasPressed && isPressed) {
        this._buttonPressTime[btn.name] = now;
        this.emit('buttonDown', btn.name);
      } else if (wasPressed && !isPressed) {
        const duration = now - (this._buttonPressTime[btn.name] || now);
        this.emit('buttonUp', btn.name, duration);
        if (duration >= HOLD_THRESHOLD_MS) {
          this.emit('buttonHold', btn.name);
        } else {
          this.emit('buttonPress', btn.name);
        }
      }
    }
  }
}

module.exports = { RC28, RC28_VID, RC28_PID };
