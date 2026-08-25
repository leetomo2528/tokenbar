'use strict';

const { app, Tray, BrowserWindow, ipcMain, nativeImage, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { collect, defaultRoot } = require('./usage');

const REFRESH_MS = 30 * 1000;
const PANEL_WIDTH = 340;
const PANEL_HEIGHT = 460;

let tray = null;
let panel = null;
let timer = null;
let settings = null;
let lastSnapshot = null;
let lastHiddenAt = 0;

/* ---------- 설정 ---------- */

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  const defaults = {
    root: defaultRoot(),
    windowHours: 5,
    // 메뉴바에 뭐를 보여줄지: 'tokens' | 'cost' | 'calls'
    trayMetric: 'tokens',
  };
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8');
    return Object.assign(defaults, JSON.parse(raw));
  } catch {
    return defaults;
  }
}

function saveSettings(next) {
  settings = Object.assign({}, settings, next);
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  } catch {
    // 설정 저장 실패는 치명적이지 않으니 삼킴
  }
  return settings;
}

/* ---------- 표시 유틸 ---------- */

function compactTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(n >= 10000000 ? 0 : 1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'K';
  return String(n);
}

function trayTitle(snap) {
  if (!snap || !snap.ok || !snap.hasData) return '—';
  const w = snap.window;
  if (settings.trayMetric === 'cost') return '$' + w.cost.toFixed(2);
  if (settings.trayMetric === 'calls') return String(w.calls);
  return compactTokens(w.input + w.output + w.cacheWrite + w.cacheRead);
}

/* ---------- 새로고침 ---------- */

async function refresh() {
  try {
    lastSnapshot = await collect({ root: settings.root, windowHours: settings.windowHours });
  } catch (err) {
    lastSnapshot = {
      ok: false,
      root: settings.root,
      hasData: false,
      error: String(err && err.message ? err.message : err),
    };
  }
  if (tray && !tray.isDestroyed()) {
    tray.setTitle(' ' + trayTitle(lastSnapshot));
  }
  if (panel && !panel.isDestroyed()) {
    panel.webContents.send('usage:update', lastSnapshot);
  }
  return lastSnapshot;
}

/* ---------- 패널 창 ---------- */

function createPanel() {
  panel = new BrowserWindow({
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: true,
    hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  panel.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  panel.on('blur', () => {
    if (panel && !panel.isDestroyed() && panel.isVisible()) {
      panel.hide();
      lastHiddenAt = Date.now();
    }
  });

  // 외부 링크는 기본 브라우저로
  panel.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function positionPanel() {
  if (!tray || !panel) return;
  const trayBounds = tray.getBounds();
  const panelBounds = panel.getBounds();
  const x = Math.round(trayBounds.x + trayBounds.width / 2 - panelBounds.width / 2);
  const y = Math.round(trayBounds.y + trayBounds.height + 4);
  panel.setPosition(x, y, false);
}

async function togglePanel() {
  if (!panel || panel.isDestroyed()) createPanel();

  if (panel.isVisible()) {
    panel.hide();
    lastHiddenAt = Date.now();
    return;
  }

  // 패널이 열린 상태에서 트레이를 누르면 blur가 먼저 도달해 숨기고,
  // 그 직후 이 핸들러가 다시 엽니다. 닫힌 것처럼 보이지 않게 막습니다.
  if (Date.now() - lastHiddenAt < 200) return;

  await refresh();
  positionPanel();
  panel.show();
  panel.focus();
}

/* ---------- 트레이 ---------- */

function buildContextMenu() {
  return Menu.buildFromTemplate([
    {
      label: '메뉴바 표시',
      submenu: [
        {
          label: '토큰',
          type: 'radio',
          checked: settings.trayMetric === 'tokens',
          click: () => { saveSettings({ trayMetric: 'tokens' }); refresh(); },
        },
        {
          label: '추정 비용',
          type: 'radio',
          checked: settings.trayMetric === 'cost',
          click: () => { saveSettings({ trayMetric: 'cost' }); refresh(); },
        },
        {
          label: '호출 횟수',
          type: 'radio',
          checked: settings.trayMetric === 'calls',
          click: () => { saveSettings({ trayMetric: 'calls' }); refresh(); },
        },
      ],
    },
    { type: 'separator' },
    { label: '지금 새로고침', click: () => refresh() },
    {
      label: '로그 폴더 열기',
      click: () => shell.openPath(settings.root),
    },
    { type: 'separator' },
    { label: '종료', role: 'quit' },
  ]);
}

function createTray() {
  // macOS 메뉴바는 텍스트만으로도 충분합니다.
  // 빈 이미지 + setTitle 조합이 아이콘 리소스 없이 가장 깔끔합니다.
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip('TokenBar');
  tray.setTitle(' —');

  tray.on('click', () => togglePanel());
  tray.on('right-click', () => tray.popUpContextMenu(buildContextMenu()));
}

/* ---------- IPC ---------- */

ipcMain.handle('usage:get', async () => {
  if (!lastSnapshot) await refresh();
  return lastSnapshot;
});

ipcMain.handle('settings:get', () => settings);

ipcMain.handle('settings:set', async (_e, patch) => {
  saveSettings(patch || {});
  await refresh();
  return settings;
});

ipcMain.handle('panel:close', () => {
  if (panel && !panel.isDestroyed()) {
    panel.hide();
    lastHiddenAt = Date.now();
  }
});

/* ---------- 생명주기 ---------- */

// 두 번 띄우지 않게
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(async () => {
    if (process.platform === 'darwin' && app.dock) app.dock.hide();

    settings = loadSettings();
    createTray();
    createPanel();
    await refresh();

    timer = setInterval(refresh, REFRESH_MS);
  });
}

// 메뉴바 앱이므로 창을 숨겨도 종료하지 않습니다.
// (macOS에서는 기본적으로 종료되지 않지만 명시적으로 둡니다.)
app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  if (timer) clearInterval(timer);
});
