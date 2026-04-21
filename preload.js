'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Whitelist of channels renderer can listen on
const ALLOWED_EVENTS = new Set([
  'settings-loaded', 'preferences-updated',
  'tab-created', 'tab-closed', 'tab-switched', 'tab-cycle',
  'tab-state-update', 'tab-title-changed', 'tab-favicon-changed', 'tab-loading',
  'find-start',
  'download-started', 'download-progress', 'download-done',
  'show-toast',
]);

contextBridge.exposeInMainWorld('sv', {
  // ── Tab management ──────────────────────────────────────────────────────────
  createTab:    (url, bg) => ipcRenderer.invoke('tab-create', url, bg),
  switchTab:    (id)      => ipcRenderer.invoke('tab-switch', id),
  closeTab:     (id)      => ipcRenderer.invoke('tab-close', id),

  // ── Navigation ──────────────────────────────────────────────────────────────
  goto:         (id, url) => ipcRenderer.invoke('nav-goto', id, url),
  back:         (id)      => ipcRenderer.invoke('nav-back', id),
  forward:      (id)      => ipcRenderer.invoke('nav-forward', id),
  reload:       (id)      => ipcRenderer.invoke('nav-reload', id),
  stop:         (id)      => ipcRenderer.invoke('nav-stop', id),
  home:         (id)      => ipcRenderer.invoke('nav-home', id),

  // ── Find in page ────────────────────────────────────────────────────────────
  findInPage:   (id, text, opts)  => ipcRenderer.invoke('find-in-page', id, text, opts),
  findStop:     (id)              => ipcRenderer.invoke('find-stop', id),

  // ── Settings & bookmarks ────────────────────────────────────────────────────
  loadSettings:     ()       => ipcRenderer.invoke('load-settings'),
  saveBookmarks:    (bm)     => ipcRenderer.invoke('save-bookmarks', bm),
  saveHomepage:     (url)    => ipcRenderer.invoke('save-homepage', url),
  savePreferences:  (prefs)  => ipcRenderer.invoke('save-preferences', prefs),
  clearBrowsingData: ()      => ipcRenderer.invoke('clear-browsing-data'),

  // ── Shell ───────────────────────────────────────────────────────────────────
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openFile:     (p)   => ipcRenderer.invoke('open-file', p),

  // ── Events from main → renderer ──────────────────────────────────────────────
  on: (channel, cb) => {
    if (!ALLOWED_EVENTS.has(channel)) {
      console.warn('[SV preload] Blocked unknown channel:', channel);
      return;
    }
    const handler = (_, ...args) => cb(...args);
    ipcRenderer.on(channel, handler);
    return handler; // return for off()
  },
  off: (channel, handler) => {
    if (ALLOWED_EVENTS.has(channel)) ipcRenderer.removeListener(channel, handler);
  },
});
