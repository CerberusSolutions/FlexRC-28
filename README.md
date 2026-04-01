# FlexRC-28

**Icom RC-28 USB encoder controller for FlexRadio SmartSDR**

FlexRC-28 connects an Icom RC-28 USB remote encoder to a FlexRadio FLEX-6000/8000 series radio running SmartSDR for Windows. It replaces the need for a mouse when tuning, gives you one-touch mode and band cycling, and adds PTT latch for comfortable ragchew operation.

![Status: Working](https://img.shields.io/badge/status-working-brightgreen)
![Platform: Windows](https://img.shields.io/badge/platform-Windows-blue)
![Electron](https://img.shields.io/badge/built%20with-Electron-47848F)
![Licence: GPL-3.0](https://img.shields.io/badge/licence-GPL--3.0-blue)

---

## Download

**[⬇ Download the latest installer from Releases](https://github.com/CerberusSolutions/FlexRC-28/releases/latest)**

No Node.js or build tools required — just download and run the installer.

---

## Features

- **Dial tuning** — velocity-sensitive, slow (10 Hz/step) and fast (100 Hz/step) modes
- **Step snapping** — switches between step sizes with automatic frequency boundary snap
- **Snap to 1 kHz** — detects panadapter clicks and snaps to nearest 1 kHz; ignores mouse wheel and dial tuning
- **PTT** — momentary press-and-hold, or hold 2.5 seconds to latch TX on; tap again to release
- **Mode cycle** — step through LSB → USB → CW → AM
- **Band cycle** — step through 160m to 6m with automatic mode selection per band
- **RIT** — toggle on/off, tune with dial, display shows offset; clear with button hold
- **Link LED** — solid green when connected to radio
- **TX LED** — lights during transmit, stays lit when latched
- **F1/F2 LEDs** — mirror app state (fast mode, RIT active)
- **Radio discovery** — automatically finds FlexRadio on local network
- **All button assignments configurable** — assign any action to any button press or hold
- **Settings persisted** — reconnects automatically on next launch

---

## Requirements

- Windows 10/11
- FlexRadio FLEX-6000 or FLEX-8000 series running SmartSDR for Windows
- Icom RC-28 USB remote encoder

---

## Installation

### Option 1 — Installer (recommended)

Download `FlexRC-28 Setup x.x.x.exe` from the [Releases page](https://github.com/CerberusSolutions/FlexRC-28/releases/latest) and run it. Creates a Start Menu shortcut and desktop icon. No additional software required.

### Option 2 — Run from source

Requires [Node.js 18+](https://nodejs.org).

```bash
git clone https://github.com/CerberusSolutions/FlexRC-28.git
cd FlexRC-28
npm install
npm start
```

---

## Usage

1. Plug in the RC-28 via USB
2. Start SmartSDR and open a slice
3. Launch FlexRC-28 — the RC-28 will be detected automatically
4. Enter your radio's IP address (or select from the discovery dropdown) and station name
5. Click **Connect**
6. The Link LED on the RC-28 will go solid green

### Default button assignments

| Button | Action |
|--------|--------|
| PTT press & hold | Transmit (momentary) |
| PTT hold 2.5s | Latch TX on — tap to release |
| F1 press | Toggle fast/slow tuning |
| F1 hold | Cycle mode (LSB → USB → CW → AM) |
| F2 press | Toggle RIT |
| F2 hold | Cycle band (160m → 80m → … → 6m) |

All assignments can be changed in the Button Assignments panel. Available actions:

- PTT (Transmit)
- Toggle Fast/Slow Tuning
- Lock/Unlock Dial
- Cycle Mode (LSB/USB/CW/AM)
- Cycle Band (160m–6m)
- Toggle RIT
- Clear RIT
- Snap to 1 kHz
- No Action

### Snap to 1 kHz

Enable the **Snap to 1kHz** toggle to automatically snap to the nearest 1 kHz whenever you click in the SmartSDR panadapter. Mouse wheel and dial tuning are not affected — the feature detects clicks by their sub-10 Hz frequency remainder, which only occurs on panadapter clicks.

### PTT Latch

- **Short press and hold** — transmits while held, releases on button release
- **Hold 2.5 seconds** — latches TX on; the TX badge changes to **TX LATCH**
- **Tap PTT while latched** — immediately releases TX

---

## Band cycle frequencies

| Band | Frequency | Mode |
|------|-----------|------|
| 160m | 1.900 MHz | LSB |
| 80m  | 3.750 MHz | LSB |
| 60m  | 5.372 MHz | USB |
| 40m  | 7.150 MHz | LSB |
| 30m  | 10.120 MHz | USB |
| 20m  | 14.225 MHz | USB |
| 17m  | 18.128 MHz | USB |
| 15m  | 21.285 MHz | USB |
| 12m  | 24.940 MHz | USB |
| 10m  | 28.500 MHz | USB |
| 6m   | 50.150 MHz | USB |

---

## File structure

```
FlexRC-28/
├── index.html          UI
├── package.json
└── src/
    ├── main.js         Electron main process
    ├── preload.js      IPC bridge
    ├── rc28.js         RC-28 HID driver (WebHID)
    ├── flex.js         SmartSDR TCP API client
    └── controller.js   RC-28 to radio action mapping
```

---

## RC-28 HID Protocol

Reverse-engineered from USB capture (USBPcap/Wireshark). The RC-28 presents as a USB HID device (VID `0x0C26`, PID `0x001E`).

### Input report (RC-28 to host, endpoint 0x81, 32 bytes)

| Byte | Meaning |
|------|---------|
| 0    | Report type — always `0x01` |
| 1    | Dial velocity (0 = stopped, 1–16+ = speed) |
| 2    | Always `0x00` |
| 3    | Dial direction: `0x01` = CW (freq up), `0x02` = CCW (freq down) |
| 4    | Always `0x00` |
| 5    | Button bitmask (active-low): bit 0 = PTT, bit 1 = F1, bit 2 = F2 |

Button state values:

| Value | State |
|-------|-------|
| `0x07` | Idle — all released |
| `0x06` | PTT held |
| `0x05` | F1 pressed |
| `0x03` | F2 pressed |

### Output report (host to RC-28, 32 bytes via WebHID)

```
[0x01][ledByte][0x00 x 30]
```

LED byte bitmask (all active-low):

| Bit | LED |
|-----|-----|
| 0   | TX/PTT LED |
| 1   | F1 LED |
| 2   | F2 LED |
| 3   | Link LED |

| Value | State |
|-------|-------|
| `0x0F` | All LEDs off |
| `0x07` | Link LED on |
| `0x06` | Link + TX on |
| `0x05` | Link + F1 on |
| `0x03` | Link + F2 on |

---

## SmartSDR API commands used

| Action | Command |
|--------|---------|
| Subscribe to slice status | `sub slice all` |
| Subscribe to TX status | `sub tx all` |
| Tune frequency | `slice tune <id> <MHz>` |
| Set mode | `slice set <id> mode=<mode>` |
| Set RIT offset | `slice set <id> rit_freq=<Hz>` |
| Enable/disable RIT | `slice set <id> rit_on=1/0` |
| PTT on/off | `xmit 1/0` |

Connects via TCP to port 4992. Radio discovery uses UDP broadcast on port 4992.

---

## Acknowledgements

Built with [Electron](https://electronjs.org). Uses Electron's built-in WebHID API for RC-28 communication — no native build tools required.

RC-28 HID protocol reverse-engineered using USBPcap and Wireshark.

SmartSDR TCP/IP API documented at [github.com/flexradio/smartsdr-api-docs](https://github.com/flexradio/smartsdr-api-docs).

---

## Licence

GNU General Public License v3.0 — see [LICENSE](LICENSE) for details.

---

## Troubleshooting

### Debug mode

If the app is not behaving as expected, run it in debug mode to see the raw SmartSDR API traffic in the activity log.

**From source:**
```bash
npm start -- --debug
```

**Installed app** (run from PowerShell or Command Prompt):
```powershell
& "$env:LOCALAPPDATA\Programs\FlexRC-28\FlexRC-28.exe" --debug
```

In debug mode the activity log will show all raw status messages from the radio, prefixed with `⬡`. This output is useful when reporting issues.

### RC-28 not detected

- Check the RC-28 is plugged in before launching the app
- Check Windows Device Manager — it should appear as *Icom RC-28 REMOTE ENCODER*
- Try a different USB port or cable

### Radio not found

- Confirm SmartSDR is running and a slice is open
- Check the IP address — use the discovery dropdown if unsure
- Confirm the radio and PC are on the same subnet
- FlexRC-28 does not currently support SmartLink remote connections (a VPN to your home network will work)

### Frequency display not updating

- Check the station name matches what is shown at the bottom of the SmartSDR window
- Disconnect and reconnect
