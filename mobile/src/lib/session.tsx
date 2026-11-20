// The app's sign-in state: which Looksee server it talks to, its session
// token, and this phone's registration for notifications.
//
// Where this sits: SessionProvider wraps the whole app (app/_layout.tsx);
// screens call useSession() to read the state, sign in or sign out. It points
// the shared API client (dashboard/app/lib/api.ts) at the chosen server and
// signs every request with the session token.
//
// Sign-in is the same two steps as the dashboard: password, then an
// authenticator code, recovery code or emailed code (two-factor is mandatory).
// After that this phone is registered for notifications, and its
// notification-only token is handed to the native service
// (modules/looksee-stream), which keeps the connection to the server open.
//
// Security:
// - The session token and server address are kept in expo-secure-store
//   (encrypted with the Android Keystore), never in plain storage.
// - Only https:// servers are accepted, except in a debug build (testing
//   against a local engine); release builds also refuse plain HTTP at the
//   Android level (app.config.js).
// - When the session expires (any 401), the app shows the sign-in screen
//   again; notifications keep arriving because they use the separate phone
//   token. Signing out removes the phone from the server, stops the service
//   and deletes both tokens.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Platform } from "react-native";
import * as Storage from "./storage";
import * as Device from "expo-device";
import Constants from "expo-constants";
import * as Stream from "../../modules/looksee-stream";
import { api, configureApi, type LoginStep } from "./shared";

const KEYS = { server: "looksee.server", token: "looksee.session", email: "looksee.email", deviceId: "looksee.deviceId" } as const;

export type SessionState = {
  // loading: reading saved state at start; signedOut: show the sign-in screen.
  status: "loading" | "signedOut" | "signedIn";
  serverUrl: string | null;
  email: string | null;
  deviceId: string | null;
  // Set when the server signed this session out (expired, idle, revoked).
  notice: string | null;
};

type SessionValue = SessionState & {
  /** Checks the server is a Looksee engine, then sends email + password. */
  startSignIn: (serverUrl: string, email: string, password: string) => Promise<LoginStep>;
  /**
   * Sends the second factor; on success stores the session and registers this
   * phone. Out: recoveryCodes after a first-time authenticator setup, and
   * complete(), which opens the app. Without codes it has already been called;
   * with codes the sign-in screen calls it once they've been saved, since the
   * sign-in screen disappears as soon as the app opens.
   */
  finishSignIn: (input: { challengeId: string; code?: string; recoveryCode?: string; emailCode?: string }) => Promise<{ recoveryCodes?: string[]; complete: () => void }>;
  /** Signs out: removes this phone from notifications and ends the session. */
  signOut: () => Promise<void>;
  /** Registers this phone again and restarts notifications (after it was removed, or the service stopped). */
  enableNotifications: () => Promise<void>;
};

const SessionContext = createContext<SessionValue | null>(null);

/** Normalises what the user typed as the server address: adds https://, drops trailing slashes. */
export function normaliseServer(input: string): string {
  let url = input.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url.replace(/\/+$/, "");
}

/** Provides the sign-in state; wraps the app. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: "loading", serverUrl: null, email: null, deviceId: null, notice: null });
  // The token is read synchronously by every request, so it lives in a ref
  // (a value that survives re-renders without causing them).
  const token = useRef<string | null>(null);

  // Points the API client at the server, signs requests with the token, and
  // goes back to sign-in when the server answers 401.
  const applyTransport = useCallback((serverUrl: string) => {
    configureApi({
      baseUrl: serverUrl,
      token: () => token.current,
      onUnauthorized: () => {
        if (!token.current) return;
        token.current = null;
        void Storage.deleteItem(KEYS.token);
        setState((s) => ({ ...s, status: "signedOut", notice: "You were signed out (the session expired or was ended). Sign in again; alerts kept arriving meanwhile." }));
      },
    });
  }, []);

  // At start: restore the saved server and session.
  useEffect(() => {
    (async () => {
      const [serverUrl, saved, email, deviceId] = await Promise.all([Storage.getItem(KEYS.server), Storage.getItem(KEYS.token), Storage.getItem(KEYS.email), Storage.getItem(KEYS.deviceId)]);
      if (serverUrl) applyTransport(serverUrl);
      token.current = saved;
      // The notification service restarts itself after a reboot; this covers
      // the case where Android stopped it some other way.
      Stream.ensureRunning();
      setState({ status: serverUrl && saved ? "signedIn" : "signedOut", serverUrl, email, deviceId, notice: null });
    })();
  }, [applyTransport]);

  const startSignIn = useCallback(
    async (serverInput: string, email: string, password: string) => {
      const serverUrl = normaliseServer(serverInput);
      if (serverUrl.startsWith("http://") && !__DEV__) throw new Error("Use the server's https:// address. Plain http:// would send your password unencrypted.");
      applyTransport(serverUrl);
      // A clear message if the address isn't a Looksee server at all.
      try {
        const health = await api.health();
        if (!health.version) throw new Error("not looksee");
      } catch {
        throw new Error(`No Looksee server answered at ${serverUrl}. Check the address, and that this phone can reach it (VPN?).`);
      }
      setState((s) => ({ ...s, serverUrl }));
      await Storage.setItem(KEYS.server, serverUrl);
      return api.login(email, password);
    },
    [applyTransport]
  );

  const finishSignIn = useCallback(
    async (input: { challengeId: string; code?: string; recoveryCode?: string; emailCode?: string }) => {
      const res = await api.verifyLogin({ ...input, client: "app" });
      if (!res.sessionToken) throw new Error("The server didn't return an app session. Is it running Looksee 5.8 or later?");
      token.current = res.sessionToken;
      await Storage.setItem(KEYS.token, res.sessionToken);
      await Storage.setItem(KEYS.email, res.email);
      const serverUrl = (await Storage.getItem(KEYS.server)) ?? "";
      const deviceId = await registerPhone(serverUrl);
      const complete = () => setState({ status: "signedIn", serverUrl, email: res.email, deviceId, notice: null });
      if (!res.recoveryCodes?.length) complete();
      return { recoveryCodes: res.recoveryCodes, complete };
    },
    []
  );

  const signOut = useCallback(async () => {
    const deviceId = await Storage.getItem(KEYS.deviceId);
    // Best effort: the server may be unreachable; the local tokens are deleted regardless.
    if (deviceId) await api.removeAppDevice(deviceId).catch(() => undefined);
    await api.logout().catch(() => undefined);
    Stream.stop();
    token.current = null;
    await Promise.all([Storage.deleteItem(KEYS.token), Storage.deleteItem(KEYS.deviceId)]);
    setState((s) => ({ ...s, status: "signedOut", deviceId: null, notice: null }));
  }, []);

  const enableNotifications = useCallback(async () => {
    const serverUrl = (await Storage.getItem(KEYS.server)) ?? "";
    const deviceId = await registerPhone(serverUrl);
    setState((s) => ({ ...s, deviceId }));
  }, []);

  const value = useMemo<SessionValue>(() => ({ ...state, startSignIn, finishSignIn, signOut, enableNotifications }), [state, startSignIn, finishSignIn, signOut, enableNotifications]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/**
 * Registers this phone for notifications, unless it already is (signing in
 * again after the session expired keeps the same registration), then starts
 * the native service with the phone token.
 * Out: the phone's device ID on the server.
 * Side effects: creates an app_devices row (first time), stores its ID.
 */
async function registerPhone(serverUrl: string): Promise<string | null> {
  const known = await Storage.getItem(KEYS.deviceId);
  const status = Stream.getStatus();
  if (known && status.enabled && status.serverUrl === serverUrl) {
    const devices = await api.appDevices().catch(() => []);
    if (devices.some((d) => d.id === known)) {
      Stream.ensureRunning();
      return known;
    }
  }
  const name = Device.deviceName ?? Device.modelName ?? "Android phone";
  const { device, token } = await api.registerAppDevice({
    name,
    appVersion: Constants.expoConfig?.version ?? undefined,
    platform: `${Platform.OS === "android" ? "Android" : Platform.OS} ${Device.osVersion ?? ""}`.trim(),
  });
  await Storage.setItem(KEYS.deviceId, device.id);
  Stream.start(serverUrl, token, name);
  return device.id;
}

/** The sign-in state and actions. */
export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside SessionProvider");
  return value;
}
