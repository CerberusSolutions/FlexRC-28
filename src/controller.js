'use strict';

const EventEmitter = require('events');

// Default button action definitions
const DEFAULT_ACTIONS = {
  ptt_press:  'ptt',
  f1_press:   'tune_mode',
  f1_hold:    'mode_cycle',    // F1 hold = step through modes
  f2_press:   'rit_toggle',
  f2_hold:    'band_cycle',    // F2 hold = step through bands
};

// Tuning step sizes in Hz per velocity unit
const TUNE_STEPS = {
  slow: { hz: 10  },
  fast: { hz: 100 },
};

// Mode cycle order — press steps forward, wraps around
const MODE_CYCLE = ['LSB', 'USB', 'CW', 'AM'];

// Band cycle — freq in MHz, auto mode, display label
// Convention: LSB below 10MHz, USB above
const BAND_CYCLE = [
  { name: '160m', freq: 1.900,   mode: 'LSB' },
  { name: '80m',  freq: 3.750,   mode: 'LSB' },
  { name: '60m',  freq: 5.3715,  mode: 'USB' },
  { name: '40m',  freq: 7.150,   mode: 'LSB' },
  { name: '30m',  freq: 10.120,  mode: 'USB' },
  { name: '20m',  freq: 14.225,  mode: 'USB' },
  { name: '17m',  freq: 18.128,  mode: 'USB' },
  { name: '15m',  freq: 21.285,  mode: 'USB' },
  { name: '12m',  freq: 24.940,  mode: 'USB' },
  { name: '10m',  freq: 28.500,  mode: 'USB' },
  { name: '6m',   freq: 50.150,  mode: 'USB' },
];

class Controller extends EventEmitter {
  constructor(rc28, flex) {
    super();
    this.rc28 = rc28;
    this.flex = flex;

    this.actions = { ...DEFAULT_ACTIONS };
    this.tuneRate = 'slow';
    this.dialLocked = false;
    this._pttDown = false;
    this._pttLatched = false;
    this._pttPressTime = 0;
    this._pttLatchTimer = null;
    this._snapEnabled = false;
    this._weJustTuned = false;
    this._weJustTunedTimer = null;

    this._bindEvents();
  }

  setActions(actions) {
    this.actions = { ...this.actions, ...actions };
    this.emit('actionsChanged', this.actions);
  }

  getActions() {
    return { ...this.actions };
  }

  getAvailableActions() {
    return [
      { id: 'ptt',          label: 'PTT (Transmit)' },
      { id: 'tune_mode',    label: 'Toggle Fast/Slow Tuning' },
      { id: 'lock_dial',    label: 'Lock/Unlock Dial' },
      { id: 'mode_cycle',   label: 'Cycle Mode (LSB/USB/CW/AM)' },
      { id: 'band_cycle',   label: 'Cycle Band (160m–6m)' },
      { id: 'rit_toggle',   label: 'Toggle RIT Mode' },
      { id: 'rit_clear',    label: 'Clear RIT to Zero' },
      { id: 'snap_khz',     label: 'Snap to Nearest 1kHz' },
      { id: 'none',         label: 'No Action' },
    ];
  }

  setSnap(enabled) {
    this._snapEnabled = enabled;
  }

  _bindEvents() {
    // ── Dial ──
    this.rc28.on('dial', (steps, speed) => {
      if (this.dialLocked) return;
      const hz = TUNE_STEPS[this.tuneRate].hz;
      const deltaHz = steps * hz;
      // Flag that WE are tuning so snap doesn't fire on our own dial updates
      this._weJustTuned = true;
      if (this._weJustTunedTimer) clearTimeout(this._weJustTunedTimer);
      this._weJustTunedTimer = setTimeout(() => {
        this._weJustTuned = false;
        this._weJustTunedTimer = null;
      }, 1000);
      this.flex.tune(deltaHz).catch((e) => {
        this.emit('error', `Tune failed: ${e.message}`);
      });
      this.emit('dialMoved', steps, deltaHz, this.tuneRate);
    });

    // ── Button Down ──
    this.rc28.on('buttonDown', (btn) => {
      if (btn === 'ptt') {
        if (this._pttLatched) {
          // Already latched — any press unlatches immediately
          this._pttLatched = false;
          this._pttDown = false;
          if (this._pttLatchTimer) { clearTimeout(this._pttLatchTimer); this._pttLatchTimer = null; }
          this.flex.setPTT(false).catch(() => {});
          this.rc28.setTxLED(false);
          this.emit('ptt', false);
          this.emit('pttLatch', false);
          return;
        }
        // Start momentary TX
        this._pttDown = true;
        this._pttPressTime = Date.now();
        this.flex.setPTT(true).catch((e) => {
          this.emit('error', `PTT on failed: ${e.message}`);
          this._pttDown = false;
        });
        this.rc28.setTxLED(true);
        this.emit('ptt', true);

        // Start latch countdown — fires at 2.5s while button still held
        this._pttLatchTimer = setTimeout(() => {
          this._pttLatchTimer = null;
          if (this._pttDown && !this._pttLatched) {
            this._pttLatched = true;
            this.emit('pttLatch', true);
            this.emit('actionExecuted', { action: 'ptt_latch', btn: 'ptt', type: 'hold', value: 'LATCHED' });
          }
        }, 2500);
      }
    });

    // ── Button Up ──
    this.rc28.on('buttonUp', (btn, duration) => {
      if (btn === 'ptt') {
        // Cancel latch timer if released before 2.5s
        if (this._pttLatchTimer) {
          clearTimeout(this._pttLatchTimer);
          this._pttLatchTimer = null;
        }

        if (this._pttLatched) return; // latched — ignore release, stay on TX

        // Short press — release TX
        this._pttDown = false;
        this.flex.setPTT(false).catch((e) => {
          this.emit('error', `PTT off failed: ${e.message}`);
        });
        this.rc28.setTxLED(false);
        this.emit('ptt', false);
      }
    });

    // ── Short Press ──
    this.rc28.on('buttonPress', (btn) => {
      if (btn === 'ptt') return;
      const action = this.actions[`${btn}_press`];
      this._executeAction(action, btn, 'press');
    });

    // ── Long Hold ──
    this.rc28.on('buttonHold', (btn) => {
      if (btn === 'ptt') return;
      const action = this.actions[`${btn}_hold`];
      this._executeAction(action, btn, 'hold');
    });

    // ── Radio status → Link LED ──
    this.flex.on('connected', () => {
      setTimeout(() => this.rc28.setLinkLED('solid'), 300);
      this.emit('linkStatus', 'connected');
    });

    this.flex.on('disconnected', () => {
      this.rc28.setLinkLED('blink');
      this.rc28.setF2LED(false);
      this.emit('linkStatus', 'disconnected');
    });

    // F2 LED mirrors RIT state from radio
    this.flex.on('sliceUpdated', (id, slice) => {
      if (slice.rit_on !== undefined) {
        this.rc28.setF2LED(!!slice.rit_on);
      }

      // Snap tuning — detect panadapter CLICKS vs mouse wheel/dial
      // SmartSDR mouse wheel always lands on multiples of 10Hz (its minimum step)
      // A panadapter click lands on arbitrary sub-Hz values
      // So: if sub-10Hz remainder is non-zero → it was a click → snap it
      if (this._snapEnabled && slice.freq_mhz && !this._weJustTuned) {
        const freqHz = Math.round(slice.freq_mhz * 1_000_000);
        const sub10 = freqHz % 10;
        const isClick = sub10 !== 0;  // wheel/dial always lands on 10Hz boundaries
        if (isClick) {
          const snapped = Math.round(freqHz / 1000) * 1000;
          if (freqHz !== snapped) {
            const snappedMHz = snapped / 1_000_000;
            this.flex.sendCmd(`slice tune ${id} ${snappedMHz.toFixed(6)}`).catch(() => {});
            this.emit('actionExecuted', { action: 'snap_khz', btn: 'auto', type: 'snap', value: `${snappedMHz.toFixed(3)} MHz` });
          }
        }
      }
    });
  }

  _executeAction(action, btn, type) {
    if (!action || action === 'none') return;

    switch (action) {

      case 'ptt': {
        this._pttDown = !this._pttDown;
        this.flex.setPTT(this._pttDown).catch(() => {});
        this.rc28.setTxLED(this._pttDown);
        this.emit('ptt', this._pttDown);
        break;
      }

      case 'tune_mode': {
        this.tuneRate = this.tuneRate === 'slow' ? 'fast' : 'slow';
        this.rc28.setF1LED(this.tuneRate === 'fast');
        // Snap to step boundary when switching rate
        const stepHz = TUNE_STEPS[this.tuneRate].hz;
        const slice = this.flex.getActiveSlice();
        if (slice && slice.freq_mhz) {
          const freqHz = Math.round(slice.freq_mhz * 1_000_000);
          const snapped = Math.round(freqHz / stepHz) * stepHz;
          const snappedMHz = snapped / 1_000_000;
          if (snappedMHz !== slice.freq_mhz) {
            slice.freq_mhz = snappedMHz;
            this.flex.sendCmd(`slice tune ${slice.id} ${snappedMHz.toFixed(6)}`).catch(() => {});
            // Update display immediately — don't wait for radio status response
            this.flex.emit('sliceUpdated', slice.id, { ...slice });
          }
        }
        this.emit('tuneModeChanged', this.tuneRate);
        break;
      }

      case 'lock_dial': {
        this.dialLocked = !this.dialLocked;
        this.rc28.setF1LED(this.dialLocked);
        this.emit('dialLockChanged', this.dialLocked);
        break;
      }

      case 'mode_cycle': {
        const slice = this.flex.getActiveSlice();
        if (!slice) break;
        const currentMode = (slice.mode || 'USB').toUpperCase();
        const idx = MODE_CYCLE.indexOf(currentMode);
        const nextMode = MODE_CYCLE[(idx + 1) % MODE_CYCLE.length];
        this.flex.setMode(slice.id, nextMode).catch((e) => {
          this.emit('error', `Mode change failed: ${e.message}`);
        });
        this.emit('actionExecuted', { action, btn, type, value: nextMode });
        return; // skip default emit below
      }

      case 'band_cycle': {
        const slice = this.flex.getActiveSlice();
        if (!slice) break;
        // Find which band we're currently on (nearest match)
        const currentFreq = slice.freq_mhz || 14.0;
        let currentBandIdx = 0;
        let closestDiff = Infinity;
        BAND_CYCLE.forEach((band, i) => {
          const diff = Math.abs(currentFreq - band.freq);
          if (diff < closestDiff) { closestDiff = diff; currentBandIdx = i; }
        });
        const nextBand = BAND_CYCLE[(currentBandIdx + 1) % BAND_CYCLE.length];
        this.flex.changeBand(slice.id, nextBand.freq, nextBand.mode).catch((e) => {
          this.emit('error', `Band change failed: ${e.message}`);
        });
        this.emit('actionExecuted', { action, btn, type, value: nextBand.name });
        return;
      }

      case 'rit_toggle': {
        const slice = this.flex.getActiveSlice();
        if (slice) {
          this.flex.enableRIT(slice.id, !slice.rit_on).catch(() => {});
        }
        break;
      }

      case 'rit_clear': {
        const slice = this.flex.getActiveSlice();
        if (slice) {
          this.flex.clearRIT(slice.id).catch(() => {});
        }
        break;
      }

      case 'snap_khz':
        this.flex.snapToKHz().catch(() => {});
        break;
    }

    this.emit('actionExecuted', { action, btn, type });
  }
}

module.exports = { Controller, DEFAULT_ACTIONS };
