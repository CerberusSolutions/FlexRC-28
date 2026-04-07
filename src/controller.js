'use strict';

const EventEmitter = require('events');
const { MODE, modeId, modeName, tuneFloor, MODE_CYCLE } = require('./modes');

// Default button action definitions
const DEFAULT_ACTIONS = {
  ptt_press:  'ptt',
  f1_press:   'tune_mode',
  f1_hold:    'mode_cycle',    // F1 hold = step through modes
  f2_press:   'rit_toggle',
  f2_hold:    'band_cycle',    // F2 hold = step through bands
};

// Mode groups — determines which velocity curve floor to use
// Velocity curve — multipliers on top of mode's tuneFloor (defined in modes.js)
const VELOCITY_MULTIPLIERS = [
  { maxVelocity: 2,        mult: 1  },  // barely moving
  { maxVelocity: 4,        mult: 2  },  // gentle
  { maxVelocity: 7,        mult: 5  },  // medium
  { maxVelocity: 11,       mult: 10 },  // fast
  { maxVelocity: Infinity, mult: 20 },  // full spin
];

const FAST_MODE_MULTIPLIER = 5;
const VELOCITY_HYSTERESIS = 0.5;
const EXTERNAL_SNAP_DEBOUNCE_MS = 120;
const MIN_SNAP_DISTANCE_HZ = 120;
const CLICK_JUMP_MIN_HZ = 200;

function getStepHz(velocity, isFast, modeVal) {
  const floor = tuneFloor(modeVal);  // modes.js handles int or string, any case
  const entry = VELOCITY_MULTIPLIERS.find(e => Math.abs(velocity) <= e.maxVelocity);
  const hz = floor * (entry ? entry.mult : 20);
  return isFast ? hz * FAST_MODE_MULTIPLIER : hz;
}

function selectVelocityBucket(absVelocity, lastIndex = null) {
  if (lastIndex === null || lastIndex === undefined) {
    return VELOCITY_MULTIPLIERS.findIndex(e => absVelocity <= e.maxVelocity);
  }

  let idx = lastIndex;

  while (
    idx < VELOCITY_MULTIPLIERS.length - 1 &&
    absVelocity > (VELOCITY_MULTIPLIERS[idx].maxVelocity + VELOCITY_HYSTERESIS)
  ) {
    idx += 1;
  }

  while (
    idx > 0 &&
    absVelocity < (VELOCITY_MULTIPLIERS[idx - 1].maxVelocity - VELOCITY_HYSTERESIS)
  ) {
    idx -= 1;
  }

  return idx;
}

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
    this._snapSuppressUntil = 0;
    this._lastSnapFreq = null;
    this._lastSnapSlice = null;
    this._pendingLocalUntil = 0;
    this._pendingLocalReason = null;
    this._lastVelocityBucket = null;
    this._lastSliceTelemetry = new Map();
    this._pendingSnapTimers = new Map();
    this._localPendingBySlice = new Map();

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

  _suppressSnap(ms = 500) {
    this._snapSuppressUntil = Date.now() + ms;
  }

  _markLocalCommand(reason, ms = 700) {
    this._pendingLocalUntil = Date.now() + ms;
    this._pendingLocalReason = reason;
  }

  _traceTuneDecision(details) {
    this.emit('tuneTrace', details);
    this.emit('log', `[tune] ${JSON.stringify(details)}`);
  }

  _bindEvents() {
    // ── Dial ──
    this.rc28.on('dial', (dial) => {
      if (this.dialLocked) return;
      const detents = typeof dial === 'object' && dial !== null ? (dial.detents || 0) : (dial || 0);
      const velocity = typeof dial === 'object' && dial !== null ? (dial.velocity || 0) : 0;
      const absVelocity = Math.abs(velocity);

      // Velocity-sensitive: step size scales with spin speed and current mode
      // CW=10Hz floor, SSB=100Hz floor, AM/FM=500Hz floor
      // F1 fast mode multiplies the entire curve by 5
      const currentMode = this.flex.getActiveSlice()?.mode;  // integer from modes.js
      const bucket = selectVelocityBucket(absVelocity, this._lastVelocityBucket);
      this._lastVelocityBucket = bucket;
      const bucketVelocity = VELOCITY_MULTIPLIERS[bucket]?.maxVelocity ?? absVelocity;
      const stepHz = getStepHz(bucketVelocity, this.tuneRate === 'fast', currentMode);
      const deltaHz = detents * stepHz;

      this._traceTuneDecision({
        source: 'dial',
        detents,
        velocity,
        selectedBucket: bucket,
        stepHz,
        deltaHz,
        suppression: {
          weJustTuned: this._weJustTuned,
          pendingLocalUntil: this._pendingLocalUntil,
          snapSuppressUntil: this._snapSuppressUntil,
        },
      });

      // Flag that WE are tuning so snap doesn't fire on our own dial updates
      this._weJustTuned = true;
      this._markLocalCommand('dial_tune', 900);
      this._suppressSnap(800);
      if (this._weJustTunedTimer) clearTimeout(this._weJustTunedTimer);
      this._weJustTunedTimer = setTimeout(() => {
        this._weJustTuned = false;
        this._weJustTunedTimer = null;
      }, 1000);
      this.flex.tune(deltaHz).catch((e) => {
        this.emit('error', `Tune failed: ${e.message}`);
      });
      this.emit('dialMoved', detents, deltaHz, this.tuneRate);
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

    this.flex.on('pendingAction', (action) => {
      if (action && action.sliceId !== undefined) {
        const targetFreqHz = Number.isFinite(action.targetFreqMHz)
          ? Math.round(action.targetFreqMHz * 1_000_000)
          : null;
        this._localPendingBySlice.set(action.sliceId, {
          until: Date.now() + 1400,
          reason: action.type || 'pending_action',
          targetFreqHz,
        });
        this._markLocalCommand(action.type || 'pending_action', 1100);
      }
      this.emit('pendingAction', action);
    });

    // F2 LED mirrors RIT state from radio
    this.flex.on('sliceUpdated', (id, slice) => {
      if (slice.rit_on !== undefined) {
        this.rc28.setF2LED(!!slice.rit_on);
      }

      if (this._snapEnabled && slice.freq_mhz) {
        const now = Date.now();
        const freqHz = Math.round(slice.freq_mhz * 1_000_000);
        const localPending = this._localPendingBySlice.get(id);
        if (localPending && now < localPending.until) {
          const matchesTarget = (
            localPending.targetFreqHz === null ||
            Math.abs(localPending.targetFreqHz - freqHz) <= 1500
          );
          if (matchesTarget) {
            this._traceTuneDecision({
              source: 'sliceUpdated',
              freqHz,
              snapReason: 'suppressed_local_pending',
              suppression: localPending,
            });
            return;
          }
        }

        const suppressed = (
          this._weJustTuned ||
          now < this._snapSuppressUntil ||
          now < this._pendingLocalUntil
        );
        if (suppressed) {
          this._traceTuneDecision({
            source: 'sliceUpdated',
            freqMHz: slice.freq_mhz,
            suppression: {
              weJustTuned: this._weJustTuned,
              snapSuppressUntil: this._snapSuppressUntil,
              pendingLocalUntil: this._pendingLocalUntil,
              pendingLocalReason: this._pendingLocalReason,
            },
            snapReason: 'suppressed',
          });
          return;
        }

        const prev = this._lastSliceTelemetry.get(id);
        this._lastSliceTelemetry.set(id, { freqHz, at: now });

        const jumpHz = prev ? Math.abs(freqHz - prev.freqHz) : 0;
        const elapsedMs = prev ? (now - prev.at) : null;
        const isFineResolutionLanding = Math.abs(freqHz % 10) !== 0;
        const isLikelyClick = !!prev && jumpHz >= CLICK_JUMP_MIN_HZ && isFineResolutionLanding;

        if (!isLikelyClick) {
          this._traceTuneDecision({
            source: 'sliceUpdated',
            freqHz,
            jumpHz,
            elapsedMs,
            isFineResolutionLanding,
            snapReason: 'not_click_signature',
          });
          return;
        }

        if (this._pendingSnapTimers.has(id)) {
          clearTimeout(this._pendingSnapTimers.get(id));
        }

        const timer = setTimeout(() => {
          this._pendingSnapTimers.delete(id);
          const latest = this._lastSliceTelemetry.get(id);
          if (!latest || latest.freqHz !== freqHz) return;

          const snapped = Math.round(freqHz / 1000) * 1000;
          const snapDistanceHz = Math.abs(freqHz - snapped);
          if (snapDistanceHz < MIN_SNAP_DISTANCE_HZ) {
            this._traceTuneDecision({
              source: 'sliceUpdated',
              freqHz,
              snapped,
              snapDistanceHz,
              snapReason: 'too_close_to_boundary',
            });
            return;
          }
          if (freqHz === snapped) return;

          const snappedMHz = snapped / 1_000_000;
          if (
            this._lastSnapSlice === id &&
            this._lastSnapFreq !== null &&
            Math.abs(this._lastSnapFreq - snappedMHz) < 0.000001
          ) {
            return;
          }

          this._lastSnapSlice = id;
          this._lastSnapFreq = snappedMHz;
          this._markLocalCommand('auto_snap', 900);
          this._suppressSnap(800);
          this._traceTuneDecision({
            source: 'sliceUpdated',
            freqHz,
            snapped,
            snapDistanceHz,
            snapReason: 'auto_snap_execute',
            suppression: {
              pendingLocalUntil: this._pendingLocalUntil,
              snapSuppressUntil: this._snapSuppressUntil,
            },
          });

          this.flex.sendCmd(`slice tune ${id} ${snappedMHz.toFixed(6)}`)
            .then(() => {
              this.emit('actionExecuted', {
                action: 'snap_khz',
                btn: 'auto',
                type: 'snap',
                value: `${snappedMHz.toFixed(3)} MHz`
              });
            })
            .catch((e) => {
              this.emit('error', `Snap failed: ${e.message}`);
            });
        }, EXTERNAL_SNAP_DEBOUNCE_MS);
        this._pendingSnapTimers.set(id, timer);
      }
    });
  }

  /**
   * Snap slice frequency to the floor boundary of the given mode.
   * Zeros digits below the new minimum step size.
   * e.g. CW→USB (10Hz→100Hz floor): 14.149.083 → 14.149.100
   */
  _snapToModeFloor(slice, nextModeId) {
    if (!slice || !slice.freq_mhz) return;
    const newFloor = tuneFloor(nextModeId);

    // Always snap to the new mode's floor boundary
    // This zeros sub-floor digits when moving to a coarser mode (CW→USB, USB→AM)
    // and is a no-op when already on a boundary or moving to a finer mode
    const freqHz = Math.round(slice.freq_mhz * 1_000_000);
    const snapped = Math.round(freqHz / newFloor) * newFloor;
    if (snapped !== freqHz) {
      const snappedMHz = snapped / 1_000_000;
      this._markLocalCommand('mode_floor_snap', 900);
      this.flex.sendCmd(`slice tune ${slice.id} ${snappedMHz.toFixed(6)}`).catch(() => {});
    }
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

        // Snap to current mode's floor boundary
        // e.g. in USB (100Hz floor): 14.149.540 → 14.149.500
        const slice = this.flex.getActiveSlice();
        if (slice && slice.freq_mhz) {
          const floor = tuneFloor(slice.mode);
          const freqHz = Math.round(slice.freq_mhz * 1_000_000);
          const snapped = Math.round(freqHz / floor) * floor;
          if (snapped !== freqHz) {
            const snappedMHz = snapped / 1_000_000;
            this._markLocalCommand('tune_mode_floor_snap', 900);
            this.flex.sendCmd(`slice tune ${slice.id} ${snappedMHz.toFixed(6)}`).catch(() => {});
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
        const currentModeId = modeId(slice.mode);
        const idx = MODE_CYCLE.indexOf(currentModeId);
        const nextModeId = MODE_CYCLE[(idx + 1) % MODE_CYCLE.length];

        // Snap frequency to the new mode's floor boundary
        // e.g. switching from CW (10Hz floor) to USB (100Hz floor)
        // zeros the sub-100Hz digits
        this._snapToModeFloor(slice, nextModeId);

        this.flex.setMode(slice.id, nextModeId).catch((e) => {
          this.emit('error', `Mode change failed: ${e.message}`);
        });
        this.emit('actionExecuted', { action, btn, type, value: modeName(nextModeId) });
        return;
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
