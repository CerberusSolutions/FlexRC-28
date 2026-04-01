'use strict';

/**
 * RC28 HID Module
 * 
 * Protocol (from USB capture analysis):
 * Report: 32 bytes, only first 6 matter
 * [b0=0x01][b1=speed][b2=0x00][b3=dir][b4=0x00][b5=buttons]
 *
 * b1 = dial velocity (0 = stopped, 1-16+ = speed)
 * b3 = direction: 0x01=CW(freq up), 0x02=CCW(freq down)
 * b5 = active-low button bitmask:
 *      0x07 = idle (all released)
 *      0x06 = PTT held  (bit 0 = 0)
 *      0x05 = F1 pressed (bit 1 = 0)
 *      0x03 = F2 pressed (bit 2 = 0)
 *
 * LED output (host -> device, ep 0x01):
 *      0x01 0x07 ... = Link LED slow blink (not connected)
 *      0x01 0x0F ... = Link LED solid (connected)
 */

const EventEmitter = require('events');

// RC-28 USB identifiers
const RC28_VID = 0x0C26;
const RC28_PID = 0x001E;

// LED output byte values (byte index 2 of report, after 0x00 reportId and 0x01 header)
// Active-low bitmask mirroring button bits:
//   bit 0 = TX/PTT LED  (0 = lit)
//   bit 1 = F1 LED      (0 = lit)
//   bit 2 = F2 LED      (0 = lit)
// From USB capture: 0x07 = all off/blink, 0x0F = link solid
const LED = {
  LINK_BLINK:  0x07,  // 0b00000111 — link blinking, all button LEDs off
  LINK_SOLID:  0x0F,  // 0b00001111 — link solid on
  TX_ON:       0x0E,  // 0b00001110 — TX LED on  (bit 0 clear)
  F1_ON:       0x0D,  // 0b00001101 — F1 LED on  (bit 1 clear)
  F2_ON:       0x0B,  // 0b00001011 — F2 LED on  (bit 2 clear)
};

// Hold threshold in ms to distinguish short press from long hold
const HOLD_THRESHOLD_MS = 600;

class RC28 extends EventEmitter {
  constructor() {
    super();
    this.device = null;
    this.HID = null;
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

  /**
   * Find and open the RC-28 device.
   * Returns true if found, false if not plugged in.
   */
  open() {
    try {
      // Lazy-load node-hid so the module can be required even without it installed
      this.HID = require('node-hid');
    } catch (e) {
      this.emit('error', new Error('node-hid not installed. Run: npm install node-hid'));
      return false;
    }

    const devices = this.HID.devices();
    const rc28 = devices.find(d => d.vendorId === RC28_VID && d.productId === RC28_PID);

    if (!rc28) {
      this.emit('error', new Error('RC-28 not found. Is it plugged in?'));
      return false;
    }

    try {
      this.device = new this.HID.HID(rc28.path);
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
      this.emit('error', e);
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

  isConnected() {
    return this._connected;
  }

  // ── LED Control ──────────────────────────────────────────────────────────

  /**
   * Set the Link LED state.
   * @param {'blink'|'solid'} state
   */
  /**
   * Send LED state to RC-28.
   * USB capture shows host sends: 01 <ledByte> 00 00 ... (32 bytes)
   * node-hid prepends 0x00 report ID on Windows, so array is 33 bytes.
   */
  _sendLED(ledByte) {
    if (!this.device) return;
    try {
      const report = new Array(33).fill(0);
      report[0] = 0x00;
      report[1] = 0x01;
      report[2] = ledByte;
      this.device.write(report);
    } catch (e) {
      // ignore silently
    }
  }

  setLinkLED(state) {
    this._linkSolid = (state === 'solid');
    this._updateLEDs();
  }

  setTxLED(on) {
    this._txOn = on;
    this._updateLEDs();
  }

  setF1LED(on) {
    this._f1On = on;
    this._updateLEDs();
  }

  setF2LED(on) {
    this._f2On = on;
    this._updateLEDs();
  }

  _updateLEDs() {
    // Confirmed from hardware test:
    //   0x07 = 0b0111 → Link LED SOLID ON (bit3=0 = link on, active-low)
    //   0x0F = 0b1111 → Link LED OFF/blink (bit3=1 = link off)
    // All bits active-low:
    //   bit 0 = TX LED  (0 = lit)
    //   bit 1 = F1 LED  (0 = lit)
    //   bit 2 = F2 LED  (0 = lit)
    //   bit 3 = Link    (0 = solid on, 1 = off)
    let b = 0x0F;                     // start: all off including link
    if (this._linkSolid) b &= ~0x08;  // bit 3 low = link solid on
    if (this._txOn)      b &= ~0x01;  // bit 0 low = TX on
    if (this._f1On)      b &= ~0x02;  // bit 1 low = F1 on
    if (this._f2On)      b &= ~0x04;  // bit 2 low = F2 on
    this._sendLED(b);
  }

  _onData(data) {
    if (!data || data.length < 6) return;

    const b0 = data[0];
    if (b0 !== 0x01) return;  // not our report

    const speed = data[1];   // dial velocity
    const dir   = data[3];   // 0x01=CW, 0x02=CCW
    const btns  = data[5];   // active-low button bitmask

    // ── Dial ──
    if (speed > 0 && (dir === 0x01 || dir === 0x02)) {
      this._handleDial(dir, speed);
    }

    // ── Buttons ──
    if (btns !== this._buttonState) {
      this._handleButtons(btns, this._buttonState);
      this._buttonState = btns;
    }
  }

  _handleDial(dir, speed) {
    // Accumulate steps and emit as a single event
    // speed is proportional to rotation velocity (1=slow, 16+=fast)
    const steps = dir === 0x01 ? speed : -speed;

    // Throttle: accumulate over 10ms window then emit
    this._dialAccumulator += steps;
    if (this._dialTimer) return;

    this._dialTimer = setTimeout(() => {
      this._dialTimer = null;
      const totalSteps = this._dialAccumulator;
      this._dialAccumulator = 0;
      /**
       * Event: 'dial'
       * @param {number} steps  positive=CW/up, negative=CCW/down
       * @param {number} speed  absolute velocity (1-16+)
       */
      this.emit('dial', totalSteps, Math.abs(totalSteps));
    }, 10);
  }

  _handleButtons(newBtns, oldBtns) {
    const now = Date.now();

    // Correct bit mapping (from USB capture):
    // Idle = 0x07 = 0b111 (all bits high)
    // PTT  = 0x06 = 0b110 → bit 0 goes low
    // F1   = 0x05 = 0b101 → bit 1 goes low
    // F2   = 0x03 = 0b011 → bit 2 goes low
    const buttons = [
      { bit: 0, name: 'ptt' },
      { bit: 1, name: 'f1'  },
      { bit: 2, name: 'f2'  },
    ];

    for (const btn of buttons) {
      const wasPressed = (oldBtns & (1 << btn.bit)) === 0;  // active-low
      const isPressed  = (newBtns & (1 << btn.bit)) === 0;

      if (!wasPressed && isPressed) {
        // Button just pressed
        this._buttonPressTime[btn.name] = now;
        /**
         * Event: 'buttonDown'
         * @param {string} button  'ptt'|'f1'|'f2'
         */
        this.emit('buttonDown', btn.name);

      } else if (wasPressed && !isPressed) {
        // Button just released
        const pressDuration = now - (this._buttonPressTime[btn.name] || now);
        const isHold = pressDuration >= HOLD_THRESHOLD_MS;

        /**
         * Event: 'buttonUp'
         * @param {string} button  'ptt'|'f1'|'f2'
         * @param {number} duration  ms held
         */
        this.emit('buttonUp', btn.name, pressDuration);

        if (isHold) {
          /**
           * Event: 'buttonHold'
           * @param {string} button  'ptt'|'f1'|'f2'
           */
          this.emit('buttonHold', btn.name);
        } else {
          /**
           * Event: 'buttonPress'  (short press only)
           * @param {string} button  'ptt'|'f1'|'f2'
           */
          this.emit('buttonPress', btn.name);
        }
      }
    }
  }
}

module.exports = { RC28, RC28_VID, RC28_PID, LED };
