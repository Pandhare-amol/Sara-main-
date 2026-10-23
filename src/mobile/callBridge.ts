/**
 * JS side of the native call bridge.
 *
 * On Android the `SaraCalls` plugin listens to telephony call-state broadcasts
 * and polls Sara's server for approved actions. In a browser there is no native
 * bridge, so every function reports that honestly instead of pretending.
 *
 * The device token is *not* a server secret: the server holds the same value in
 * `SARA_CALL_DEVICE_TOKEN`, and it only authorises this one phone to report its
 * own call state. It is stored per device in localStorage.
 */
import { registerPlugin } from "@capacitor/core";
import { isNativeApp } from "../lib/serverConfig";

export interface CallDeviceSettings {
  token: string;
  /** Stable per-install id so the server can queue commands for this phone. */
  deviceId: string;
}

export interface CallBridgeStatus {
  available: boolean;
  listening: boolean;
  permission: boolean;
  canAnswer: boolean;
  state: string;
  deviceId: string | null;
  error?: string;
}

interface SaraCallsPlugin {
  start(options: { baseUrl: string; token: string; deviceId: string }): Promise<CallBridgeStatus>;
  stop(): Promise<CallBridgeStatus>;
  getStatus(): Promise<CallBridgeStatus>;
  placeCall(options: { number: string }): Promise<{ status: string; verified: boolean; message?: string; error?: string }>;
  answerCall(): Promise<{ status: string; verified: boolean; message?: string; error?: string }>;
  endCall(): Promise<{ status: string; verified: boolean; error?: string }>;
}

const KEY = "sara.calls.device.v1";
let plugin: SaraCallsPlugin | null = null;

function getPlugin(): SaraCallsPlugin | null {
  if (!isNativeApp()) return null;
  if (!plugin) {
    try {
      plugin = registerPlugin<SaraCallsPlugin>("SaraCalls");
    } catch {
      plugin = null;
    }
  }
  return plugin;
}

export function readCallDevice(): CallDeviceSettings {
  const fallback: CallDeviceSettings = { token: "", deviceId: "" };
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<CallDeviceSettings>;
    return { token: String(parsed.token || ""), deviceId: String(parsed.deviceId || "") };
  } catch {
    return fallback;
  }
}

export function saveCallDevice(patch: Partial<CallDeviceSettings>): CallDeviceSettings {
  const current = readCallDevice();
  const next: CallDeviceSettings = {
    token: (patch.token ?? current.token).trim(),
    deviceId: (patch.deviceId ?? current.deviceId).trim() || current.deviceId || `android-${Math.random().toString(36).slice(2, 10)}`,
  };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage disabled — the bridge simply cannot be configured */
  }
  return next;
}

export function bridgeAvailable(): boolean {
  return Boolean(getPlugin());
}

export async function startCallBridge(baseUrl: string): Promise<CallBridgeStatus> {
  const instance = getPlugin();
  const settings = readCallDevice();
  if (!instance) {
    return {
      available: false,
      listening: false,
      permission: false,
      canAnswer: false,
      state: "UNAVAILABLE",
      deviceId: null,
      error: "Call reporting needs the Android app; a browser cannot read your phone's call state.",
    };
  }
  if (!settings.token) {
    return {
      available: true,
      listening: false,
      permission: false,
      canAnswer: false,
      state: "UNCONFIGURED",
      deviceId: settings.deviceId || null,
      error: "No device token saved. Enter the same token the server has in SARA_CALL_DEVICE_TOKEN.",
    };
  }
  try {
    const status = await instance.start({ baseUrl, token: settings.token, deviceId: settings.deviceId });
    if (status.deviceId) saveCallDevice({ deviceId: status.deviceId });
    return { ...status, available: true };
  } catch (error) {
    return {
      available: true,
      listening: false,
      permission: false,
      canAnswer: false,
      state: "FAILED",
      deviceId: settings.deviceId || null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function stopCallBridge(): Promise<void> {
  await getPlugin()?.stop().catch(() => undefined);
}

export async function getCallBridgeStatus(): Promise<CallBridgeStatus | null> {
  const instance = getPlugin();
  if (!instance) return null;
  try {
    return { ...(await instance.getStatus()), available: true };
  } catch {
    return null;
  }
}

export async function nativePlaceCall(number: string): Promise<{ status: string; verified: boolean; message?: string; error?: string } | null> {
  const instance = getPlugin();
  if (!instance) return null;
  try {
    return await instance.placeCall({ number });
  } catch (error) {
    return { status: "FAILED", verified: false, error: error instanceof Error ? error.message : String(error) };
  }
}
