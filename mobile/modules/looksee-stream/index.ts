// JavaScript side of Looksee's native notification service (Android only).
// The service itself is Kotlin (android/src/main/java/...): it keeps the
// connection to the Looksee server open and shows alerts even when the app is
// closed. This file gives the app typed functions to start/stop it and read
// its status. On platforms without the native module (web, tests) every
// function is a harmless no-op, so screens can call them unconditionally.

import { Platform } from "react-native";
import { requireOptionalNativeModule, type EventSubscription } from "expo";

/** The service's state as the Settings screen shows it. */
export type StreamStatus = {
  enabled: boolean;
  // connecting / connected / waiting (will retry) / stopped
  state: "connecting" | "connected" | "waiting" | "stopped";
  lastError: string | null;
  // When it was last connected, in ms since 1970; null = never.
  lastConnectedAt: number | null;
  serverUrl: string | null;
};

type NativeModule = {
  start(serverUrl: string, token: string, deviceName: string): void;
  stop(): void;
  ensureRunning(): void;
  getStatus(): StreamStatus;
  isIgnoringBatteryOptimizations(): boolean;
  requestIgnoreBatteryOptimizations(): void;
  openNotificationSettings(): void;
  addListener(event: "onStatus", listener: (status: StreamStatus) => void): EventSubscription;
};

// requireOptionalNativeModule returns null instead of throwing when the
// native module isn't in this build.
const native = Platform.OS === "android" ? requireOptionalNativeModule<NativeModule>("LookseeStream") : null;

const STOPPED: StreamStatus = { enabled: false, state: "stopped", lastError: null, lastConnectedAt: null, serverUrl: null };

/** Whether this build has the notification service (false on web / Expo Go). */
export const isAvailable = () => native != null;

/** Saves the connection details and starts receiving notifications. */
export const start = (serverUrl: string, token: string, deviceName: string) => native?.start(serverUrl, token, deviceName);
/** Stops receiving notifications and forgets the phone token. */
export const stop = () => native?.stop();
/** Restarts the service if it's set up but not running. */
export const ensureRunning = () => native?.ensureRunning();
/** The current connection status. */
export const getStatus = (): StreamStatus => native?.getStatus() ?? STOPPED;
/** Whether battery saving leaves Looksee alone. */
export const isIgnoringBatteryOptimizations = () => native?.isIgnoringBatteryOptimizations() ?? true;
/** Asks Android (with its own dialog) to leave Looksee out of battery saving. */
export const requestIgnoreBatteryOptimizations = () => native?.requestIgnoreBatteryOptimizations();
/** Opens Android's notification settings for Looksee. */
export const openNotificationSettings = () => native?.openNotificationSettings();
/** Calls `listener` whenever the status changes. Out: call .remove() to stop listening. */
export const onStatus = (listener: (s: StreamStatus) => void): { remove: () => void } => native?.addListener("onStatus", listener) ?? { remove: () => undefined };
