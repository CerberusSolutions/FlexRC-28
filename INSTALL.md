# FlexRC-28 — Installation Guide

## Prerequisites

Install the following before anything else:

1. **Node.js v20 LTS** — download from [nodejs.org](https://nodejs.org) (choose the "LTS" version). This also installs `npm` automatically.
2. **Git** — download from [git-scm.com](https://git-scm.com) (used to download the source code).

> Windows 10 or 11 (64-bit) is required.

---

## Option A — Run from Source (recommended for development/testing)

Open a **Command Prompt** or **PowerShell** window and run these commands one at a time:

```bat
git clone https://github.com/wa2n-code/FlexRC-28.git
cd FlexRC-28
npm install
npm start
```

- `git clone` downloads the project files.
- `npm install` downloads Electron and all other dependencies automatically (no separate Electron install needed).
- `npm start` launches the application.

To run it again in the future, just open a terminal in the `FlexRC-28` folder and type `npm start`.

---

## Option B — Build a Windows Installer (.exe)

If you want to create a standalone installer to distribute or install without needing Node.js on the target machine:

```bat
git clone https://github.com/wa2n-code/FlexRC-28.git
cd FlexRC-28
npm install
npm run build
```

The installer (`FlexRC-28 Setup 1.0.2.exe`) will be created in the `dist\` folder. Run that `.exe` to install the application like any normal Windows program — Node.js is **not** required on the machine where the installer is run.

---

## Notes

- **USB driver:** The RC-28 communicates via HID (Human Interface Device). Windows should recognize it automatically — no separate driver should be needed.
- **Firewall:** The app connects to SmartSDR on TCP port 4992. If your radio isn't discovered automatically, check that Windows Firewall isn't blocking outbound connections on that port.
- **Re-running the app:** If you used Option A, you must keep the `FlexRC-28` folder intact. If you used Option B, the installed app runs independently.
