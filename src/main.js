'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// Prefer a project-local userData directory to avoid OS cache permission issues
try {
  const localUserData = path.join(__dirname, '..', 'userData');
  if (!fs.existsSync(localUserData)) fs.mkdirSync(localUserData, { recursive: true });
  app.setPath('userData', localUserData);
} catch (e) {
  // ignore and fall back to default
}

// Global error handlers to avoid hard crashes from native modules (HID)
process.on('uncaughtException', (err) => {
  console.error('[FlexRC-28] Uncaught exception:', err && err.stack ? err.stack : err);
  if (win && !win.isDestroyed()) send('app:error', { message: err && err.message ? err.message : String(err) });
});

process.on('unhandledRejection', (reason) => {
  console.error('[FlexRC-28] Unhandled rejection:', reason);
  if (win && !win.isDestroyed()) send('app:error', { message: reason && reason.message ? reason.message : String(reason) });
});

const { RC28 } = require('./rc28');
const { FlexRadio } = require('./flex');
const { Controller } = require('./controller');

// ── Persist settings ────────────────────────────────────────────────────────

const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    }
  } catch (_) {}
  return {
    radioIP: '',
    stationName: '',
    actions: {},
    snapTuning: false,
    velocityTuning: true,
    tuningSensitivityLevel: 5,
  };
}

function saveSettings(settings) {
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  } catch (_) {}
}

// ── App ─────────────────────────────────────────────────────────────────────

let win;
let rc28, flex, controller;
let settings = loadSettings();

function createWindow() {
  win = new BrowserWindow({
    width: 560,
    height: 680,
    minWidth: 480,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0a0e1a',
      symbolColor: '#4af',
      height: 32,
    },
    backgroundColor: '#0a0e1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'index.html'));
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  createWindow();
  // Small delay so window is fully shown before hardware init
  setTimeout(initHardware, 300);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  cleanup();
  if (process.platform !== 'darwin') app.quit();
});

// ── Hardware Init ────────────────────────────────────────────────────────────

function initHardware() {
  rc28 = new RC28();
  flex = new FlexRadio();
  controller = new Controller(rc28, flex);

  // Apply saved actions
  if (settings.actions && Object.keys(settings.actions).length > 0) {
    controller.setActions(settings.actions);
  }

  // Apply saved snap setting
  controller.setSnap(!!settings.snapTuning);

  // Apply saved velocity setting (default on for new installs)
  controller.setVelocity(settings.velocityTuning !== false);
    // Apply saved tuning sensitivity level
    if (typeof controller.setTuningSensitivityLevel === 'function') {
      controller.setTuningSensitivityLevel(settings.tuningSensitivityLevel || settings.reducedTuningLevel || 5);
  }

  // ── RC-28 events → renderer ──
  rc28.on('connected', (info) => {
    send('rc28:connected', info);
  });

  rc28.on('disconnected', () => {
    send('rc28:disconnected');
  });

  rc28.on('error', (err) => {
    send('rc28:error', err.message);
  });

  // ── Flex events → renderer ──
  flex.on('connected', (ip) => {
    send('flex:connected', ip);
  });

  flex.on('disconnected', () => {
    send('flex:disconnected');
  });

  flex.on('error', (err) => {
    send('flex:error', err.message);
  });

  flex.on('sliceUpdated', (id, slice) => {
    send('flex:sliceUpdated', { id, ...slice });
  });

  flex.on('pttChanged', (on) => {
    send('flex:pttChanged', on);
  });

  flex.on('radioFound', (radio) => {
    send('flex:radioFound', radio);
  });

  // ── Controller events → renderer ──
  controller.on('dialMoved', (steps, deltaHz, rate) => {
    send('ctrl:dialMoved', { steps, deltaHz, rate });
  });

  controller.on('ptt', (on) => {
    send('ctrl:ptt', on);
  });

  controller.on('pttLatch', (latched) => {
    send('ctrl:pttLatch', latched);
  });

  controller.on('tuneModeChanged', (rate) => {
    send('ctrl:tuneModeChanged', rate);
  });

  controller.on('dialLockChanged', (locked) => {
    send('ctrl:dialLockChanged', locked);
  });

  controller.on('actionExecuted', (info) => {
    send('ctrl:actionExecuted', info);
  });

  controller.on('error', (msg) => {
    send('ctrl:error', msg);
  });

  controller.on('linkStatus', (status) => {
    send('ctrl:linkStatus', status);
  });

  // Try to open RC-28 immediately
  setTimeout(() => rc28.open(), 500);

  // Start Flex discovery
  flex.startDiscovery();

  // Raw protocol logging — off by default
  // Enable with:  npm start -- --debug
  // Installed app: FlexRC-28.exe --debug
  const debugMode = process.argv.includes('--debug');
  if (debugMode) {
    flex.enableRawLogging();
    flex.on('raw', (line) => {
      send('flex:raw', line.slice(0, 200));
    });
    console.log('[FlexRC-28] Debug mode enabled — raw Flex output visible in activity log');
  }

  // Notify renderer that hardware initialization is complete
  send('app:ready');
}

function cleanup() {
  if (rc28) { rc28.close(); }
  if (flex)  { flex.disconnect(); flex.stopDiscovery(); }
}

// ── IPC Handlers ─────────────────────────────────────────────────────────────

// RC-28
ipcMain.handle('rc28:open',  () => (rc28 ? rc28.open() : Promise.resolve(false)));
ipcMain.handle('rc28:close', () => (rc28 ? rc28.close() : Promise.resolve(false)));
ipcMain.handle('rc28:isConnected', () => (rc28 ? rc28.isConnected() : false));

// Flex
ipcMain.handle('flex:connect', async (_, { ip, stationName }) => {
  settings.radioIP = ip;
  settings.stationName = stationName;
  saveSettings(settings);
  if (!flex) return { ok: false, error: 'Not initialized' };
  try {
    await flex.connect(ip, stationName);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('flex:disconnect', () => {
  if (flex) flex.disconnect();
});

ipcMain.handle('flex:isConnected', () => (flex ? flex.isConnected() : false));

ipcMain.handle('flex:getSlices', () => (flex ? flex.getSlices() : []));

ipcMain.handle('flex:setActiveSlice', (_, sliceId) => {
  if (flex) flex.setActiveSlice(sliceId);
});

// Settings
ipcMain.handle('settings:load', () => settings);

ipcMain.handle('settings:save', (_, newSettings) => {
  settings = { ...settings, ...newSettings };
  saveSettings(settings);

  if (newSettings.actions && controller) {
    controller.setActions(newSettings.actions);
  }

  if (newSettings.snapTuning !== undefined && controller) {
    controller.setSnap(!!newSettings.snapTuning);
  }

  if (newSettings.tuningSensitivityLevel !== undefined && controller) {
    if (typeof controller.setTuningSensitivityLevel === 'function') controller.setTuningSensitivityLevel(Number(newSettings.tuningSensitivityLevel) || 5);
  }

  if (newSettings.velocityTuning !== undefined && controller) {
    controller.setVelocity(!!newSettings.velocityTuning);
  }

  return settings;
});

// Controller info
ipcMain.handle('ctrl:getActions', () => (controller ? controller.getActions() : {}));
ipcMain.handle('ctrl:getAvailableActions', () => (controller ? controller.getAvailableActions() : []));

// Util
function send(channel, data) {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, data);
  }
}
