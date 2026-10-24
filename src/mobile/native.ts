/**
 * Android shell integration (Capacitor). Everything is imported dynamically so
 * the desktop/web bundle never pays for native-only code and stays identical
 * outside the app.
 */
import { isNativeApp } from "../lib/serverConfig";

type BackHandler = () => boolean;

let backHandler: BackHandler | null = null;
let installed = false;

/** Register what the hardware back button should close first. */
export function setNativeBackHandler(handler: BackHandler | null): void {
  backHandler = handler;
}

/**
 * Configure the status bar and the Android back button once.
 * Returns a cleanup function (used by React StrictMode's double mount).
 */
export function installNativeShell(): () => void {
  if (!isNativeApp() || installed) return () => undefined;
  installed = true;
  let disposed = false;
  const removers: Array<() => void> = [];

  void import("@capacitor/status-bar")
    .then(({ StatusBar, Style }) => {
      if (disposed) return;
      void StatusBar.setOverlaysWebView({ overlay: false }).catch(() => undefined);
      void StatusBar.setBackgroundColor({ color: "#03040a" }).catch(() => undefined);
      void StatusBar.setStyle({ style: Style.Dark }).catch(() => undefined);
    })
    .catch(() => undefined);

  void import("@capacitor/app")
    .then(({ App }) => {
      if (disposed) return;
      void App.addListener("backButton", () => {
        if (backHandler?.()) return;
        void App.minimizeApp().catch(() => App.exitApp());
      }).then((handle) => {
        removers.push(() => void handle.remove());
      });
    })
    .catch(() => undefined);

  return () => {
    disposed = true;
    removers.forEach((remove) => remove());
    installed = false;
  };
}
