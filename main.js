'use strict';

const {
  app, BrowserWindow, BrowserView,
  ipcMain, session, Menu, dialog, shell,
  nativeTheme
} = require('electron');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

// ─── Persistent Settings ──────────────────────────────────────────────────────
const userDataPath  = app.getPath('userData');
const settingsFile  = path.join(userDataPath, 'sv-settings.json');
const NEWTAB_URL    = `file://${path.join(__dirname, 'src', 'newtab.html')}`;
const SETTINGS_URL  = `file://${path.join(__dirname, 'src', 'settings.html')}`;

const DEFAULTS = {
  homePage:        NEWTAB_URL,
  searchEngine:    'https://www.google.com/search?q=',
  bookmarks:       [],
  showBookmarkBar: true,
  showFullUrl:     false,
  windowBounds:    { width: 1280, height: 800 },
};

function loadSettings() {
  try {
    if (fs.existsSync(settingsFile)) {
      return Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(settingsFile, 'utf8')));
    }
  } catch (e) { /* ignore corrupt file */ }
  return Object.assign({}, DEFAULTS);
}

function saveSettings(data) {
  try {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) { console.error('[SV] Failed to save settings:', e); }
}

let settings = loadSettings();

// ─── Tab State ────────────────────────────────────────────────────────────────
let mainWindow = null;
const tabs     = new Map();   // id → { view, url, title, loading }
let activeTabId = null;
let nextTabId   = 1;

// Chrome UI height: toolbar(52) + tab bar(40) + bookmark bar(32) = 124
const CHROME_HEIGHT = () => settings.showBookmarkBar ? 124 : 92;

function getContentBounds() {
  const [w, h] = mainWindow.getContentSize();
  return { x: 0, y: CHROME_HEIGHT(), width: w, height: Math.max(0, h - CHROME_HEIGHT()) };
}

function resizeAllViews() {
  for (const [id, { view }] of tabs) {
    if (id === activeTabId) view.setBounds(getContentBounds());
  }
}

// ─── URL Normalisation ────────────────────────────────────────────────────────
function normaliseUrl(raw) {
  const s = raw.trim();
  if (!s) return settings.homePage;
  // Already has a protocol
  if (/^[a-z][a-z\d+\-.]*:\/\//i.test(s)) return s;
  // file:// shorthand
  if (s.startsWith('/') || s.startsWith('~')) return `file://${s.replace(/^~/, os.homedir())}`;
  // Looks like a hostname  e.g. "github.com" or "localhost:3000"
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(s) || /^localhost(:\d+)?/.test(s)) {
    return 'https://' + s;
  }
  // Treat as search query
  return settings.searchEngine + encodeURIComponent(s);
}

// ─── Tab Lifecycle ────────────────────────────────────────────────────────────
function createTab(url, opts = {}) {
  const id  = nextTabId++;
  const target = url ? normaliseUrl(url) : settings.homePage;

  const view = new BrowserView({
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      sandbox:          true,
      webSecurity:      true,
    }
  });

  mainWindow.addBrowserView(view);
  view.setBounds(getContentBounds());
  view.setAutoResize({ width: true, height: true });

  const wc = view.webContents;

  // Navigation events
  const onNavigate = (navUrl) => {
    if (!tabs.has(id)) return;
    tabs.get(id).url = navUrl;
    mainWindow.webContents.send('tab-state-update', id, {
      url:        navUrl,
      canGoBack:  wc.canGoBack(),
      canGoForward: wc.canGoForward(),
      isActive:   activeTabId === id,
    });
  };

  wc.on('did-navigate',         (_, u) => onNavigate(u));
  wc.on('did-navigate-in-page', (_, u) => onNavigate(u));

  wc.on('page-title-updated', (_, title) => {
    if (!tabs.has(id)) return;
    tabs.get(id).title = title;
    mainWindow.webContents.send('tab-title-changed', id, title);
  });

  wc.on('page-favicon-updated', (_, favicons) => {
    const fav = favicons[0] || '';
    if (tabs.has(id)) tabs.get(id).favicon = fav;
    mainWindow.webContents.send('tab-favicon-changed', id, fav);
  });

  wc.on('did-start-loading', () => {
    if (tabs.has(id)) tabs.get(id).loading = true;
    mainWindow.webContents.send('tab-loading', id, true);
  });

  wc.on('did-stop-loading', () => {
    if (!tabs.has(id)) return;
    tabs.get(id).loading = false;
    mainWindow.webContents.send('tab-loading', id, false);
    onNavigate(wc.getURL());
  });

  wc.on('did-fail-load', (_, errCode, errDesc, validatedUrl, isMainFrame) => {
    if (!isMainFrame) return;
    if (errCode === -3) return; // Aborted (user navigated away)
    const errHtml = `data:text/html,<body style="font-family:sans-serif;background:#0f0f1a;color:#e8e8f0;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:16px">
      <h2 style="font-size:22px">Can't reach this page</h2>
      <p style="color:#8888aa">${errDesc} (${errCode})</p>
      <p style="color:#555575;font-size:13px">${validatedUrl}</p></body>`;
    wc.loadURL(errHtml);
  });

  // New windows → open as new tab
  wc.setWindowOpenHandler(({ url: newUrl }) => {
    createTab(newUrl);
    return { action: 'deny' };
  });

  // Context menu for web content
  wc.on('context-menu', (_, params) => showContextMenu(id, params));

  // Downloads
  wc.session.on('will-download', (_, item) => {
    const savePath = path.join(app.getPath('downloads'), item.getFilename());
    item.setSavePath(savePath);
    mainWindow.webContents.send('download-started', item.getFilename());
    item.on('updated', (__, state) => {
      if (state === 'progressing') {
        const pct = item.getTotalBytes()
          ? Math.round((item.getReceivedBytes() / item.getTotalBytes()) * 100)
          : -1;
        mainWindow.webContents.send('download-progress', item.getFilename(), pct);
      }
    });
    item.once('done', (__, state) => {
      mainWindow.webContents.send('download-done', item.getFilename(), state, savePath);
    });
  });

  tabs.set(id, { view, url: target, title: 'New Tab', favicon: '', loading: false });

  if (!opts.background) {
    switchTab(id);
  } else {
    mainWindow.webContents.send('tab-created', id, target, /* active= */ false);
  }

  wc.loadURL(target);

  if (!opts.background) {
    mainWindow.webContents.send('tab-created', id, target, /* active= */ true);
  }

  return id;
}

function switchTab(id) {
  if (!tabs.has(id)) return;

  // Remove all views, then add the target one (ensures z-order)
  for (const [, { view }] of tabs) mainWindow.removeBrowserView(view);

  const { view } = tabs.get(id);
  mainWindow.addBrowserView(view);
  view.setBounds(getContentBounds());
  activeTabId = id;

  const wc = view.webContents;
  mainWindow.webContents.send('tab-switched', id, {
    url:        wc.getURL(),
    title:      wc.getTitle(),
    canGoBack:  wc.canGoBack(),
    canGoForward: wc.canGoForward(),
    loading:    wc.isLoading(),
  });
}

function closeTab(id) {
  if (!tabs.has(id)) return;
  const { view } = tabs.get(id);
  mainWindow.removeBrowserView(view);
  // Use setImmediate to avoid destroying during event handler
  setImmediate(() => view.webContents.destroy());
  tabs.delete(id);
  mainWindow.webContents.send('tab-closed', id);

  if (tabs.size === 0) { app.quit(); return; }

  if (activeTabId === id) {
    const keys = [...tabs.keys()];
    switchTab(keys[keys.length - 1]);
  }
}

// ─── Context Menu ──────────────────────────────────────────────────────────────
function showContextMenu(tabId, params) {
  const items = [];
  const tab = tabs.get(tabId);

  if (params.selectionText) {
    items.push(
      { label: 'Copy', role: 'copy' },
      { label: `Search for "${params.selectionText.slice(0,30)}…"`, click: () =>
          createTab(settings.searchEngine + encodeURIComponent(params.selectionText)) },
      { type: 'separator' }
    );
  }

  if (params.linkURL) {
    items.push(
      { label: 'Open Link in New Tab', click: () => createTab(params.linkURL) },
      { label: 'Copy Link Address', click: () =>
          require('electron').clipboard.writeText(params.linkURL) },
      { type: 'separator' }
    );
  }

  if (params.mediaType === 'image') {
    items.push(
      { label: 'Open Image in New Tab', click: () => createTab(params.srcURL) },
      { label: 'Save Image As…', click: () => tab?.view.webContents.downloadURL(params.srcURL) },
      { type: 'separator' }
    );
  }

  items.push(
    { label: 'Go Back',    enabled: tab?.view.webContents.canGoBack(),    click: () => tab?.view.webContents.goBack() },
    { label: 'Go Forward', enabled: tab?.view.webContents.canGoForward(), click: () => tab?.view.webContents.goForward() },
    { label: 'Reload',     click: () => tab?.view.webContents.reload() },
    { type: 'separator' },
    { label: 'Save Page As…', click: () => tab?.view.webContents.savePage(
        path.join(app.getPath('downloads'), 'page.html'), 'HTMLComplete') },
    { label: 'Print…', click: () => tab?.view.webContents.print() },
    { type: 'separator' },
    { label: 'Inspect Element', click: () =>
        tab?.view.webContents.inspectElement(params.x, params.y) },
  );

  const menu = Menu.buildFromTemplate(items);
  menu.popup({ window: mainWindow });
}

// ─── App Menu ─────────────────────────────────────────────────────────────────
function buildAppMenu() {
  const isMac = process.platform === 'darwin';

  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: openSettings },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ]
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Tab',    accelerator: 'CmdOrCtrl+T', click: () => createTab() },
        { label: 'Close Tab',  accelerator: 'CmdOrCtrl+W', click: () => closeTab(activeTabId) },
        { type: 'separator' },
        ...(!isMac ? [{ label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: openSettings },
                      { type: 'separator' }] : []),
        { label: 'Save Page As…', accelerator: 'CmdOrCtrl+S',
          click: () => {
            const tab = tabs.get(activeTabId);
            if (tab) tab.view.webContents.savePage(
              path.join(app.getPath('downloads'), 'page.html'), 'HTMLComplete');
          }
        },
        { label: 'Print…', accelerator: 'CmdOrCtrl+P',
          click: () => tabs.get(activeTabId)?.view.webContents.print() },
        { type: 'separator' },
        { role: isMac ? 'close' : 'quit' },
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: () =>
            mainWindow.webContents.send('find-start') },
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reload',        accelerator: 'CmdOrCtrl+R',
          click: () => tabs.get(activeTabId)?.view.webContents.reload() },
        { label: 'Force Reload',  accelerator: 'CmdOrCtrl+Shift+R',
          click: () => tabs.get(activeTabId)?.view.webContents.reloadIgnoringCache() },
        { type: 'separator' },
        { label: 'Zoom In',  accelerator: 'CmdOrCtrl+=',
          click: () => { const wc = tabs.get(activeTabId)?.view.webContents;
            if (wc) wc.setZoomLevel(wc.getZoomLevel() + 0.5); } },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-',
          click: () => { const wc = tabs.get(activeTabId)?.view.webContents;
            if (wc) wc.setZoomLevel(wc.getZoomLevel() - 0.5); } },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0',
          click: () => tabs.get(activeTabId)?.view.webContents.setZoomLevel(0) },
        { type: 'separator' },
        { label: 'Toggle Developer Tools', accelerator: isMac ? 'Cmd+Option+I' : 'F12',
          click: () => {
            const wc = tabs.get(activeTabId)?.view.webContents;
            if (wc) wc.isDevToolsOpened() ? wc.closeDevTools() : wc.openDevTools();
          }
        },
        { label: 'Toggle UI DevTools', accelerator: isMac ? 'Cmd+Option+U' : 'Ctrl+Shift+U',
          click: () => mainWindow.webContents.toggleDevTools() },
      ]
    },
    {
      label: 'History',
      submenu: [
        { label: 'Back',    accelerator: isMac ? 'Cmd+[' : 'Alt+Left',
          click: () => { const wc = tabs.get(activeTabId)?.view.webContents;
            if (wc?.canGoBack()) wc.goBack(); } },
        { label: 'Forward', accelerator: isMac ? 'Cmd+]' : 'Alt+Right',
          click: () => { const wc = tabs.get(activeTabId)?.view.webContents;
            if (wc?.canGoForward()) wc.goForward(); } },
        { label: 'Home',    accelerator: isMac ? 'Cmd+Shift+H' : 'Alt+Home',
          click: () => tabs.get(activeTabId)?.view.webContents.loadURL(settings.homePage) },
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' }, { role: 'zoom' },
        { type: 'separator' },
        { label: 'Next Tab',     accelerator: 'CmdOrCtrl+Tab',
          click: () => cycleTab(1) },
        { label: 'Previous Tab', accelerator: 'CmdOrCtrl+Shift+Tab',
          click: () => cycleTab(-1) },
        ...(isMac ? [{ type: 'separator' }, { role: 'front' }] : []),
      ]
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function cycleTab(direction) {
  const keys = [...tabs.keys()];
  const idx  = keys.indexOf(activeTabId);
  const next = keys[(idx + direction + keys.length) % keys.length];
  switchTab(next);
  mainWindow.webContents.send('tab-cycle', next);
}

function openSettings() {
  // Check if settings tab already open
  for (const [id, t] of tabs) {
    if (t.url === SETTINGS_URL) { switchTab(id); return; }
  }
  createTab(SETTINGS_URL);
}

// ─── Main Window ──────────────────────────────────────────────────────────────
function createWindow() {
  const bounds = settings.windowBounds || { width: 1280, height: 800 };

  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth:        640,
    minHeight:       480,
    titleBarStyle:   process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0f0f1a',
    show:            false,
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      sandbox:          false,   // preload bridges via ipcMain only
      preload:          path.join(__dirname, 'preload.js'),
    },
  });

  buildAppMenu();
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.on('resize', resizeAllViews);
  mainWindow.on('enter-full-screen', resizeAllViews);
  mainWindow.on('leave-full-screen',  resizeAllViews);

  mainWindow.on('close', () => {
    const [w, h] = mainWindow.getSize();
    settings.windowBounds = { width: w, height: h };
    saveSettings(settings);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('settings-loaded', settings);
    createTab(settings.homePage);
  });
}

// ─── IPC: Tabs ────────────────────────────────────────────────────────────────
ipcMain.handle('tab-create',     (_, url, bg) => createTab(url, { background: !!bg }));
ipcMain.handle('tab-switch',     (_, id)       => switchTab(id));
ipcMain.handle('tab-close',      (_, id)       => closeTab(id));

// ─── IPC: Navigation ─────────────────────────────────────────────────────────
ipcMain.handle('nav-goto',    (_, id, url)  => { const t = tabs.get(id); if (t) t.view.webContents.loadURL(normaliseUrl(url)); });
ipcMain.handle('nav-back',    (_, id)       => { const wc = tabs.get(id)?.view.webContents; if (wc?.canGoBack()) wc.goBack(); });
ipcMain.handle('nav-forward', (_, id)       => { const wc = tabs.get(id)?.view.webContents; if (wc?.canGoForward()) wc.goForward(); });
ipcMain.handle('nav-reload',  (_, id)       => tabs.get(id)?.view.webContents.reload());
ipcMain.handle('nav-stop',    (_, id)       => tabs.get(id)?.view.webContents.stop());
ipcMain.handle('nav-home',    (_, id)       => { const t = tabs.get(id); if (t) t.view.webContents.loadURL(settings.homePage); });

// ─── IPC: Find In Page ────────────────────────────────────────────────────────
ipcMain.handle('find-in-page', (_, id, text, opts) => {
  const wc = tabs.get(id)?.view.webContents;
  if (!wc || !text) return;
  wc.findInPage(text, opts || {});
});
ipcMain.handle('find-stop', (_, id) => {
  tabs.get(id)?.view.webContents.stopFindInPage('clearSelection');
});

// ─── IPC: Settings ────────────────────────────────────────────────────────────
ipcMain.handle('load-settings',    ()         => settings);
ipcMain.handle('save-bookmarks',   (_, bm)    => { settings.bookmarks = bm; saveSettings(settings); });
ipcMain.handle('save-homepage',    (_, url)   => { settings.homePage = url; saveSettings(settings); });
ipcMain.handle('save-preferences', (_, prefs) => {
  Object.assign(settings, prefs);
  saveSettings(settings);
  mainWindow.webContents.send('preferences-updated', settings);
  resizeAllViews();
});

ipcMain.handle('clear-browsing-data', async () => {
  await session.defaultSession.clearCache();
  await session.defaultSession.clearStorageData();
  mainWindow.webContents.send('show-toast', 'Browsing data cleared');
});

// ─── IPC: Misc ────────────────────────────────────────────────────────────────
ipcMain.handle('open-external', (_, url) => shell.openExternal(url));
ipcMain.handle('open-file',     (_, p)   => shell.openPath(p));

ipcMain.handle('show-download-dialog', async (_, filename) => {
  const { filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: path.join(app.getPath('downloads'), filename),
  });
  return filePath || null;
});

// ─── App Lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  // Block ads / trackers via a deny-list (basic demo)
  // For full blocking, integrate a proper filter list
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['*://*.doubleclick.net/*', '*://pagead2.googlesyndication.com/*'] },
    (_, callback) => callback({ cancel: true })
  );

  nativeTheme.themeSource = 'dark';
  createWindow();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate',           () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
