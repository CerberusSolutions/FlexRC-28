'use strict';

/**
 * Mode definitions — single source of truth.
 *
 * SmartSDR sends mode as lowercase string (e.g. 'usb', 'cw').
 * We normalise to an integer ID on receipt to avoid all case-sensitivity issues.
 */

// Integer mode IDs
const MODE = {
  LSB:  0,
  USB:  1,
  CW:   2,
  AM:   3,
  DIGU: 4,
  DIGL: 5,
  SAM:  6,
  FM:   7,
  NFM:  8,
  DFM:  9,
  RTTY: 10,
};

// Reverse: integer → uppercase string (for sending to radio API)
const MODE_NAME = Object.fromEntries(
  Object.entries(MODE).map(([k, v]) => [v, k])
);

/**
 * Normalise any mode representation to an integer ID.
 * Handles lowercase, uppercase, already-integer. Unknown → USB.
 */
function modeId(val) {
  if (val == null) return MODE.USB;
  if (typeof val === 'number') return MODE_NAME[val] !== undefined ? val : MODE.USB;
  return MODE[String(val).toUpperCase()] !== undefined
    ? MODE[String(val).toUpperCase()]
    : MODE.USB;
}

/**
 * Get the API string name for a mode ID.
 */
function modeName(id) {
  return MODE_NAME[id] || 'USB';
}

// Minimum tuning step (Hz) per mode at slowest velocity
const MODE_TUNE_FLOOR = {
  [MODE.CW]:   10,   // zero-beat — finest steps
  [MODE.LSB]:  100,
  [MODE.USB]:  100,
  [MODE.DIGU]: 100,
  [MODE.DIGL]: 100,
  [MODE.RTTY]: 100,
  [MODE.SAM]:  100,
  [MODE.AM]:   500,  // wide modes — coarser floor
  [MODE.FM]:   500,
  [MODE.NFM]:  500,
  [MODE.DFM]:  500,
};

/**
 * Get the tuning floor in Hz for a mode (string or integer).
 */
function tuneFloor(val) {
  return MODE_TUNE_FLOOR[modeId(val)] || 100;
}

// Ordered list of mode IDs for the cycle button
const MODE_CYCLE = [MODE.LSB, MODE.USB, MODE.CW, MODE.AM];

module.exports = { MODE, modeName, modeId, tuneFloor, MODE_CYCLE };
