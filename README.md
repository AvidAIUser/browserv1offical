# SV Browser

A clean, minimal Electron-based browser with tabs, bookmarks, and persistent settings.

## Features
- 🗂 **Multi-tab** — create, switch, close tabs; middle-click to close; Ctrl+1–9 to jump
- 🔍 **Smart address bar** — auto-detects URLs vs. search queries; syncs with navigation
- ⬅️ **Navigation** — back, forward, reload, home with full keyboard support
- ⭐ **Bookmarks** — add current page (Ctrl+D), bookmark bar, manage/delete in modal
- 💾 **Persistent** — bookmarks and home page saved to `userData` between sessions
- 🔒 **Secure** — `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
- ⌨️ **Keyboard shortcuts**:
  | Shortcut | Action |
  |---|---|
  | `Ctrl+T` | New tab |
  | `Ctrl+W` | Close current tab |
  | `Ctrl+R` | Reload |
  | `Ctrl+L` | Focus address bar |
  | `Ctrl+D` | Bookmark page |
  | `Alt+←` | Go back |
  | `Alt+→` | Go forward |
  | `Alt+Home` | Go to home page |
  | `Ctrl+1–9` | Switch to tab N |

## Getting Started

```bash
# 1. Install dependencies
npm install

# 2. Run in development
npm start

# 3. Build distributable (optional)
npm run build:mac    # macOS .dmg
npm run build:win    # Windows installer
npm run build:linux  # Linux AppImage
```

## Project Structure

```
sv-browser/
├── main.js          ← Electron main process (window, BrowserViews, IPC)
├── preload.js       ← contextBridge — secure renderer↔main bridge
├── src/
│   ├── index.html   ← Browser chrome UI
│   ├── renderer.js  ← Tab/nav/bookmark logic (runs in browser context)
│   └── styles.css   ← Dark UI theme
└── assets/          ← App icons (add icon.png / .icns / .ico here)
```

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  BrowserWindow (Chrome UI)                          │
│  ┌─────────────────────────────────────────────┐   │
│  │ Renderer (index.html + renderer.js)         │   │
│  │  ↕ contextBridge (preload.js)               │   │
│  └─────────────────────────────────────────────┘   │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐         │
│  │BrowserView│  │BrowserView│  │BrowserView│ tabs   │
│  │  Tab 1   │  │  Tab 2   │  │  Tab 3   │         │
│  └──────────┘  └──────────┘  └──────────┘         │
└─────────────────────────────────────────────────────┘
         ↕ ipcMain / ipcRenderer
  main.js (Node.js — file I/O, settings, BrowserView mgmt)
```

## Security Model
- Renderer runs with `nodeIntegration: false` and `contextIsolation: true`
- All Node.js access goes through the `contextBridge` in `preload.js`
- BrowserViews use `sandbox: true` — each tab is isolated
- URL normalization prevents `javascript:` protocol abuse
