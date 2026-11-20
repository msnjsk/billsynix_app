/** API exposed by the Electron desktop app (electron/preload.js). Undefined in a normal browser. */
export type DesktopPrinter = { name: string; displayName: string; isDefault: boolean };

declare global {
  interface Window {
    posDesktop?: {
      isDesktop: true;
      info(): Promise<{ version: string; platform: string }>;
      getPrinters(): Promise<DesktopPrinter[]>;
      /** Prints the current page silently; the POS print CSS shows only the receipt. */
      print(opts?: { deviceName?: string }): Promise<{ ok: boolean; reason: string | null }>;
      /** OS-encrypted storage for the device key and refresh token (older app builds lack it). */
      secureGet?(key: 'deviceKey' | 'refreshToken'): Promise<string | null>;
      secureSet?(key: 'deviceKey' | 'refreshToken', value: string | null): Promise<boolean>;
    };
  }
}
