const { app, BrowserWindow, protocol, net, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { ipcMain } = require('electron');

// Must run before app is ready.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'papyr',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

// Test isolation: point profile + library at temp dirs (see scripts/e2e.sh)
if (process.env.PAPYR_USER_DATA) {
  app.setPath('userData', process.env.PAPYR_USER_DATA);
}

const config = require('./config');
const ptyManager = require('./ptyManager');
const watcher = require('./watcher');
const ipc = require('./ipc');

let win = null;
let closeFlushed = false;

const MIME = {
  '.pdf': 'application/pdf',
  '.html': 'text/html',
  '.mjs': 'text/javascript',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.bcmap': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.ftl': 'text/plain',
  '.properties': 'text/plain',
  '.icc': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
};

// Static roots served under papyr://app/<root>/… — the bundled pdf.js viewer.
// Single host keeps everything same-origin so module imports and the PDF
// fetch work without CORS.
const STATIC_ROOTS = {
  pdfjs: path.join(__dirname, '..', '..', 'node_modules', 'pdfjs-dist'),
  pdfviewer: path.join(__dirname, '..', 'renderer', 'pdfviewer'),
};

function serveFile(abs, mime) {
  return net.fetch(pathToFileURL(abs).toString()).then((res) => {
    if (process.env.PAPYR_DEBUG) console.log('papyr:// response:', res.status, 'for', abs);
    return new Response(res.body, { status: res.status, headers: { 'Content-Type': mime } });
  });
}

// papyr://app/papers/[<collection>/]<pdf> — PDFs from inside the library only.
// papyr://app/{pdfjs,pdfviewer}/… — the viewer's static assets.
function handlePapyrRequest(request) {
  if (process.env.PAPYR_DEBUG) console.log('papyr:// request:', request.url);
  const url = new URL(request.url);
  const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (url.host !== 'app' || segments.length < 2) {
    return new Response('Not found', { status: 404 });
  }
  const [root, ...rest] = segments;
  if (root === 'papers') {
    if (rest.length > 2) return new Response('Not found', { status: 404 });
    const papersRoot = path.join(config.get().libraryPath, 'papers');
    const abs = path.resolve(papersRoot, ...rest);
    if (!abs.startsWith(papersRoot + path.sep) || !abs.toLowerCase().endsWith('.pdf')) {
      return new Response('Forbidden', { status: 403 });
    }
    return serveFile(abs, 'application/pdf');
  }
  const staticRoot = STATIC_ROOTS[root];
  if (!staticRoot) return new Response('Not found', { status: 404 });
  const abs = path.resolve(staticRoot, ...rest);
  const mime = MIME[path.extname(abs).toLowerCase()];
  if (!abs.startsWith(staticRoot + path.sep) || !mime) {
    return new Response('Forbidden', { status: 403 });
  }
  return serveFile(abs, mime);
}

function createWindow() {
  if (process.platform === 'darwin') {
    app.dock.setIcon(path.join(__dirname, '..', '..', 'assets', 'icon.png'));
  }
  win = new BrowserWindow({
    width: 1600,
    height: 1000,
    title: 'Papyr',
    backgroundColor: '#211c18',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Keep terminal output and note autosaves flowing when the window is occluded
      backgroundThrottling: false,
    },
  });

  if (process.env.PAPYR_DEBUG) {
    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
    });
  }

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  // Give the renderer a moment to flush an unsaved note before closing.
  win.on('close', (e) => {
    if (closeFlushed) return;
    e.preventDefault();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      closeFlushed = true;
      ptyManager.kill();
      win.destroy();
    };
    win.webContents.send('app:flush-request');
    ipcMain.once('app:flushed', finish);
    setTimeout(finish, 1000);
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Automated smoke test: PAPYR_E2E=results.json npm start
  if (process.env.PAPYR_E2E) {
    win.webContents.once('did-finish-load', () => {
      require('./e2e').run(win);
    });
  }

  // Automated visual check: PAPYR_SCREENSHOT=out.png npm start
  if (process.env.PAPYR_SCREENSHOT) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        if (process.env.PAPYR_SCREENSHOT_JS) {
          const result = await win.webContents.executeJavaScript(process.env.PAPYR_SCREENSHOT_JS, true);
          if (result !== undefined) console.log('PAPYR_SCREENSHOT_JS:', JSON.stringify(result));
          await new Promise((r) => setTimeout(r, 400));
        }
        if (process.env.PAPYR_FRAME_JS) {
          const frame = win.webContents.mainFrame.frames.find((f) => f.url.includes('pdfviewer/viewer.html'));
          if (frame) {
            const result = await frame.executeJavaScript(process.env.PAPYR_FRAME_JS, true);
            console.log('PAPYR_FRAME_JS:', JSON.stringify(result));
          } else {
            console.log('PAPYR_FRAME_JS: no viewer frame');
          }
        }
        // An occluded window may never composite out-of-process frames (the PDF
        // viewer), leaving them blank in captures; bring the window to the front
        // so the capture reflects what a visible window shows.
        win.moveTop();
        app.focus({ steal: true });
        await new Promise((r) => setTimeout(r, 1000));
        const image = await win.webContents.capturePage();
        fs.writeFileSync(path.resolve(process.env.PAPYR_SCREENSHOT), image.toPNG());
        win.close(); // graceful close so localStorage reaches disk
      }, Number(process.env.PAPYR_SCREENSHOT_DELAY_MS) || 3000);
    });
  }
}

app.whenReady().then(() => {
  // Force the Chromium PDF viewer's page surround to light gray: subtle in
  // light mode, and it inverts to *dark* under the dark-pages filter. Our own
  // UI uses a fixed palette, so this doesn't affect the app's look.
  nativeTheme.themeSource = 'light';
  config.init(app.getPath('userData'));
  protocol.handle('papyr', handlePapyrRequest);
  createWindow();
  ipc.register(win);
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  ptyManager.kill();
  watcher.stop();
});
