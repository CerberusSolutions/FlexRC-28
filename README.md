# FlexRC-28

Connects an Icom RC-28 USB encoder to a FlexRadio SmartSDR station via the SmartSDR TCP API.

## Features

- Dial tuning with velocity-proportional step size
- RIT mode (F2 by default)
- Configurable button assignments — short press and long hold independently
- Link LED mirrors radio connection state
- TX LED mirrors transmit state
- Radio discovery (auto-finds Flex on local subnet)
- Settings saved between sessions
- Optional snap-to-1kHz tuning

## Requirements

- Node.js 18+
- npm
- Electron
- Icom RC-28 plugged in via USB
- FlexRadio SmartSDR running on local network

## Install & Run

```bash
npm install
npm start
```

## HID Protocol (decoded from USB capture)

32-byte interrupt report from RC-28 (endpoint 0x81):

| Byte | Meaning |
|------|---------|
| b0   | Report ID = 0x01 |
| b1   | Dial velocity (0=stopped, 1–16+=speed) |
| b2   | Always 0x00 |
| b3   | Direction: 0x01=CW (freq up), 0x02=CCW (freq down) |
| b4   | Always 0x00 |
| b5   | Button bitmask (active-low): bit0=PTT, bit1=F1, bit2=F2 |

Button state values:
- `0x07` = idle
- `0x06` = PTT held
- `0x05` = F1 pressed
- `0x03` = F2 pressed

LED output (32-byte report to endpoint 0x01, byte 1):
- `0x07` = Link LED blinking (not connected)
- `0x0F` = Link LED solid (connected)

## Default Button Assignments

| Button   | Action |
|----------|--------|
| PTT Press | Transmit |
| F1 Press  | Toggle fast/slow tuning |
| F1 Hold   | Lock/unlock dial |
| F2 Press  | Toggle RIT mode |
| F2 Hold   | Clear RIT to zero |

All assignments are configurable in the UI.

## Flex API

Connects to radio on port 4992 (TCP). Key commands:
- `sub slice all` — subscribe to slice status
- `slice N tune <MHz>` — tune slice
- `slice set N rit_freq=<Hz>` — set RIT offset
- `slice set N rit_on=1/0` — enable/disable RIT
- `transmit set transmit=1/0` — PTT control

## File Structure

```
flexrc28/
├── index.html          UI
├── package.json
└── src/
    ├── main.js         Electron main process
    ├── preload.js      IPC bridge
    ├── rc28.js         RC-28 HID module
    ├── flex.js         FlexRadio TCP API module
    └── controller.js   Wires RC-28 to Flex with configurable actions
```
