/**
 * BillSynix — desktop shell (Electron main process).
 *
 * Production: serves the static Next.js export in ../out over a private `kirana://pos` scheme,
 * so the app works fully offline and keeps one stable origin (localStorage survives updates).
 * Development: set ELECTRON_START_URL (e.g. http://localhost:3000) to load the Next dev server.
 *
 * Desktop-only extras exposed to the page via preload.js:
 *  - silent printing to a chosen (thermal) printer, no print dialog
 *  - Web Serial access for direct ESC/POS printing and the cash drawer
 */
const {
  app,
  BrowserWindow,
  Menu,
  ipcMain,
  net,
  protocol,
  safeStorage,
  session,
  shell,
} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SCHEME = 'kirana';
const HOST = 'pos';
const START_PATH = '/pos';
const DEV_URL = process.env.ELECTRON_START_URL?.replace(/\/+$/, '');
const OUT_DIR = path.join(__dirname, '..', 'out');
const APP_ORIGIN = `${SCHEME}://${HOST}`;

// Must run before the app is ready: lets the scheme behave like https (storage, fetch, secure context).
protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

/** Maps a URL path to a file in the export: /pos → pos.html, /_next/… → as is. Never leaves OUT_DIR. */
function resolveFile(urlPath) {
  const clean = decodeURIComponent(urlPath).replace(/\/+$/, '') || '/index';
  for (const candidate of [clean, `${clean}.html`, `${clean}/index.html`]) {
    const file = path.normalize(path.join(OUT_DIR, candidate));
    if (!file.startsWith(OUT_DIR + path.sep)) continue;
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {
      /* try the next candidate */
    }
  }
  return path.join(OUT_DIR, '404.html');
}

const isTrusted = (url) =>
  !!url &&
  (url.startsWith(`${APP_ORIGIN}/`) ||
    url === APP_ORIGIN ||
    (!!DEV_URL && url.startsWith(DEV_URL)));

/** Links the POS uses that belong to other apps: WhatsApp / web, UPI, phone, mail. */
const openOutside = (url) => {
  if (/^(https?:|upi:|tel:|mailto:)/i.test(url)) void shell.openExternal(url);
};

function createWindow() {
  const win = new BrowserWindow({
    width: 1366,
    height: 820,
    minWidth: 1024,
    minHeight: 640,
    title: 'BillSynix',
    backgroundColor: '#f6f7fb',
    autoHideMenuBar: true,
    show: false,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => {
    win.maximize();
    win.show();
  });

  // target=_blank links (e.g. "Send bill on WhatsApp") open in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: 'deny' };
  });
  // Never navigate the POS window away from the app itself.
  win.webContents.on('will-navigate', (event, url) => {
    if (isTrusted(url)) return;
    event.preventDefault();
    openOutside(url);
  });

  void win.loadURL(`${DEV_URL ?? APP_ORIGIN}${START_PATH}`);
  if (process.env.POS_SMOKE_SCREENSHOT)
    smokeTest(win, process.env.POS_SMOKE_SCREENSHOT);
  return win;
}

/**
 * Automated check for builds: POS_SMOKE_SCREENSHOT=<file.png> loads the POS, saves a screenshot,
 * prints any page errors, and quits (exit code 1 if the page logged errors).
 */
function smokeTest(win, file) {
  const errors = [];
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error') errors.push(event.message);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) =>
    errors.push(`did-fail-load ${code} ${desc} ${url}`)
  );
  win.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      let info = {};
      try {
        info = await win.webContents.executeJavaScript(
          `(async () => ({ title: document.title, desktop: !!window.posDesktop, url: location.href,
              printers: window.posDesktop ? (await window.posDesktop.getPrinters()).length : -1,
              hasSearch: !!document.querySelector('input[aria-label="Scan or search items"]') }))()`
        );
      } catch (e) {
        errors.push(`smoke script: ${e}`);
      }
      const image = await win.webContents.capturePage();
      fs.writeFileSync(file, image.toPNG());
      console.log(JSON.stringify({ ...info, errors }, null, 2));
      app.exit(errors.length ? 1 : 0);
    }, 2500);
  });
}

function setUpPermissions() {
  const ses = session.defaultSession;
  const allowed = new Set([
    'media',
    'serial',
    'clipboard-sanitized-write',
    'fullscreen',
    // Desktop pop-ups for new alerts (orders, low stock, drawers…), turned on from the bell.
    'notifications',
  ]);

  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(allowed.has(permission) && isTrusted(details.requestingUrl));
  });
  ses.setPermissionCheckHandler(
    (_wc, permission, origin) => allowed.has(permission) && isTrusted(origin)
  );
  ses.setDevicePermissionHandler(
    (details) => details.deviceType === 'serial' && isTrusted(details.origin)
  );

  // Chrome shows a port picker for Web Serial; Electron leaves the choice to us.
  // Prefer something that looks like a USB / receipt printer, else the first port.
  ses.on('select-serial-port', (event, portList, _wc, callback) => {
    event.preventDefault();
    const label = (p) => `${p.displayName ?? ''} ${p.portName ?? ''}`;
    const pick =
      portList.find((p) =>
        /usb|print|pos|thermal|epson|tvs|rugtek|xprinter/i.test(label(p))
      ) ?? portList[0];
    callback(pick ? pick.portId : '');
  });
}

/**
 * Secrets the POS keeps across restarts — the counter's device key and the cashier's refresh
 * token — encrypted with the OS (DPAPI on Windows, Keychain on macOS) in the app's data folder.
 * Only these keys are accepted, and only from the app's own pages.
 */
const SECURE_KEYS = new Set(['deviceKey', 'refreshToken']);
const secureFile = () =>
  path.join(app.getPath('userData'), 'secure-store.json');
function readSecure() {
  try {
    return JSON.parse(fs.readFileSync(secureFile(), 'utf8'));
  } catch {
    return {};
  }
}
function setUpSecureStore() {
  const allowed = (event, key) =>
    isTrusted(event.senderFrame?.url) &&
    SECURE_KEYS.has(key) &&
    safeStorage.isEncryptionAvailable();
  ipcMain.handle('pos:secure-get', (event, key) => {
    if (!allowed(event, key)) return null;
    const v = readSecure()[key];
    try {
      return typeof v === 'string'
        ? safeStorage.decryptString(Buffer.from(v, 'base64'))
        : null;
    } catch {
      return null;
    }
  });
  ipcMain.handle('pos:secure-set', (event, key, value) => {
    if (!allowed(event, key)) return false;
    const all = readSecure();
    if (typeof value === 'string' && value)
      all[key] = safeStorage.encryptString(value).toString('base64');
    else delete all[key];
    fs.writeFileSync(secureFile(), JSON.stringify(all), { mode: 0o600 });
    return true;
  });
}

function setUpIpc() {
  setUpSecureStore();
  ipcMain.handle('pos:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
  }));

  ipcMain.handle('pos:printers', async (event) => {
    const printers = await event.sender.getPrintersAsync();
    return printers.map((p) => ({
      name: p.name,
      displayName: p.displayName || p.name,
      isDefault: !!p.isDefault,
    }));
  });

  // Prints the page silently. The page's @media print CSS shows only the receipt, sized to the roll.
  ipcMain.handle(
    'pos:print',
    (event, opts) =>
      new Promise((resolve) => {
        const deviceName =
          typeof opts?.deviceName === 'string' && opts.deviceName
            ? opts.deviceName
            : undefined;
        event.sender.print(
          {
            silent: true,
            printBackground: true,
            margins: { marginType: 'none' },
            ...(deviceName ? { deviceName } : {}),
          },
          (ok, reason) =>
            resolve({ ok, reason: ok ? null : reason || 'Print failed' })
        );
      })
  );
}

function setUpMenu() {
  // Minimal menu (hidden until Alt is pressed). F5–F10 stay free for the POS shortcuts.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'View',
        submenu: [
          { role: 'reload', accelerator: 'CmdOrCtrl+R' },
          { role: 'togglefullscreen', accelerator: 'F11' },
          { type: 'separator' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { role: 'resetZoom' },
          { type: 'separator' },
          { role: 'toggleDevTools', accelerator: 'CmdOrCtrl+Shift+I' },
        ],
      },
      { role: 'windowMenu' },
    ])
  );
}

// One POS window per computer: opening the app again focuses the running one.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let mainWindow = null;

  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  // Windows shows pop-ups only for an app with an ID (the installer's appId).
  if (process.platform === 'win32') app.setAppUserModelId('com.billsynix.pos');

  app.whenReady().then(() => {
    if (!DEV_URL) {
      protocol.handle(SCHEME, (request) => {
        const { pathname } = new URL(request.url);
        return net.fetch(pathToFileURL(resolveFile(pathname)).toString());
      });
    }
    setUpPermissions();
    setUpIpc();
    setUpMenu();
    mainWindow = createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0)
        mainWindow = createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
