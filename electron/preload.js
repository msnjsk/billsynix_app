/**
 * Exposes a small, safe API to the POS page as `window.posDesktop`.
 * The page checks for it to enable desktop-only features (silent printing, keeping the counter's
 * device key and the cashier's session encrypted by the OS across restarts).
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('posDesktop', {
  isDesktop: true,
  info: () => ipcRenderer.invoke('pos:info'),
  getPrinters: () => ipcRenderer.invoke('pos:printers'),
  print: (opts) => ipcRenderer.invoke('pos:print', opts ?? {}),
  secureGet: (key) => ipcRenderer.invoke('pos:secure-get', key),
  secureSet: (key, value) =>
    ipcRenderer.invoke('pos:secure-set', key, value ?? null),
});
