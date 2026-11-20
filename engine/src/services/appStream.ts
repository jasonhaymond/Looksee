// The live connection between the engine and phones running the Looksee
// Android app: a WebSocket at /api/app/stream that carries app notifications.
//
// Where this sits: index.ts calls attachAppStream(server) once the HTTP server
// is listening. Alerts reach this file through services/notifications/app.ts,
// which queues them in app_notifications and calls pushPending() for each phone.
// The phone's native background service (mobile/modules/looksee-stream) keeps
// the connection open, shows each notification, and acknowledges it.
//
// A WebSocket is a long-lived two-way connection that starts as an ordinary HTTP
// request and is then "upgraded"; the `ws` library handles the protocol.
//
// Security:
// - The phone authenticates with its notification-only device token in the
//   `Authorization: Bearer` header. Browsers can't set that header on a
//   WebSocket, so a malicious web page can't open this stream with the user's
//   credentials (cross-site WebSocket hijacking). Only the token's SHA-256 hash
//   is stored; a wrong token is recorded as a "bad_app_token" security event,
//   which the security rules can turn into an IP block.
// - The same IP blocks and allowlist as every other request apply before the
//   upgrade (gateUpgrade).
// - A device can only acknowledge its own notifications (the device ID is part
//   of every update), messages from the phone are capped at 64 KB, and one
//   device may hold at most MAX_CONNECTIONS_PER_DEVICE connections, so a leaked
//   token can't open hundreds and exhaust the engine's memory.

import crypto from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { Express, Request } from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { and, asc, eq, gt, inArray, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { appDevices, appNotifications } from "../db/schema.js";
import { buildList, clientIp, listHas } from "../lib/ipMatch.js";
import { isUuid } from "../lib/ids.js";
import { logger } from "../lib/logger.js";
import { VERSION } from "../lib/version.js";
import { getSecuritySettings, isBlocked, recordSecurityEvent } from "./security.js";

export const STREAM_PATH = "/api/app/stream";

// How long a queued notification waits for a phone that's offline, and the
// most sent in one go when it reconnects. Older ones are dropped rather than
// delivered late: a phone switched off for a week shouldn't get 500 stale
// alerts at once. The app's Alerts screen still shows the real current state.
export const APP_QUEUE_HOURS = 24;
const MAX_BACKLOG = 200;

// The server pings every connection this often; one that doesn't answer by
// the next ping is closed, so a phone that vanished (no signal) doesn't keep a
// dead connection around. The phone pings too and reconnects on its own.
const PING_MS = 30_000;

// A phone needs one connection, briefly two while it reconnects; the oldest
// is closed when a device opens more than this.
const MAX_CONNECTIONS_PER_DEVICE = 5;

/** SHA-256 of a device token, as stored in app_devices.token_hash. */
export const hashDeviceToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

/** A new random device token (256 bits), shown to the phone once at registration. */
export const newDeviceToken = () => `lsa_${crypto.randomBytes(32).toString("base64url")}`;

// Open connections per device. Normally one, but a phone that reconnects
// before the old connection timed out briefly has two; both get updates.
const connections = new Map<string, Set<WebSocket>>();

/** Whether this device has a live connection right now (for the Security page). */
export const isConnected = (deviceId: string) => (connections.get(deviceId)?.size ?? 0) > 0;

/**
 * Sends every notification still waiting for one device (within
 * APP_QUEUE_HOURS, oldest first, at most MAX_BACKLOG) over its open
 * connections. Does nothing when the phone isn't connected: it gets them when
 * it reconnects. Rows are marked delivered only when the phone acknowledges
 * them (handleMessage), so a message lost in transit is sent again.
 */
export async function pushPending(deviceId: string) {
  const sockets = connections.get(deviceId);
  if (!sockets?.size) return;
  const since = new Date(Date.now() - APP_QUEUE_HOURS * 3_600_000);
  const rows = await db
    .select()
    .from(appNotifications)
    .where(and(eq(appNotifications.deviceId, deviceId), isNull(appNotifications.deliveredAt), gt(appNotifications.createdAt, since)))
    .orderBy(asc(appNotifications.createdAt))
    .limit(MAX_BACKLOG);
  if (!rows.length) return;
  const message = JSON.stringify({
    type: "notify",
    items: rows.map((r) => ({ id: r.id, title: r.title, body: r.body, status: r.status, event: r.event, checkId: r.checkId, createdAt: r.createdAt.toISOString() })),
  });
  for (const ws of sockets) if (ws.readyState === ws.OPEN) ws.send(message);
}

/**
 * Handles one message from a phone. The only kinds it sends: "ack" with the
 * IDs it has shown (marked delivered, for this device only), and "ping".
 */
async function handleMessage(deviceId: string, ws: WebSocket, raw: string) {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (!msg || typeof msg !== "object") return;
  const { type, ids } = msg as { type?: unknown; ids?: unknown };
  if (type === "ack" && Array.isArray(ids)) {
    // Only well-formed IDs, at most a batch's worth; the deviceId filter means
    // a phone can never mark another phone's notifications as delivered.
    const valid = ids.filter(isUuid).slice(0, MAX_BACKLOG);
    if (valid.length) await db.update(appNotifications).set({ deliveredAt: new Date() }).where(and(eq(appNotifications.deviceId, deviceId), inArray(appNotifications.id, valid)));
  } else if (type === "ping") {
    ws.send(JSON.stringify({ type: "pong" }));
  }
}

/**
 * Gives a raw upgrade request Express's request helpers (req.ip honouring the
 * "trust proxy" setting, req.get, req.path), so the IP rules and the security
 * log see the same client address as for every other request.
 */
function asExpressRequest(req: IncomingMessage, app: Express): Request {
  Object.setPrototypeOf(req, app.request);
  (req as unknown as { app: Express }).app = app;
  return req as unknown as Request;
}

/**
 * The same IP checks securityGate applies to normal requests: blocked
 * addresses, and the allowlist when it's on. The stream is used by the
 * admin's own phone, not by agents, so the allowlist always applies.
 * Out: null when allowed, otherwise the HTTP status to refuse with.
 */
async function gateUpgrade(req: Request): Promise<number | null> {
  const ip = clientIp(req);
  if (await isBlocked(ip)) return 403;
  const s = await getSecuritySettings();
  if (s.allowlistEnabled && s.allowlist.length && !listHas(buildList(s.allowlist), ip)) {
    await recordSecurityEvent("allowlist_denied", { req });
    return 403;
  }
  return null;
}

/** Ends an upgrade request with a plain HTTP error instead of a WebSocket. */
function refuse(socket: Duplex, status: number) {
  const text = status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Not Found";
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/**
 * Attaches the app stream to the engine's HTTP server. Side effects: listens
 * for upgrade requests on STREAM_PATH (others are refused with 404), and
 * starts the ping timer.
 *
 * In: the HTTP server returned by app.listen(), and the Express app (passed
 * in rather than imported, so this file doesn't import app.ts, which imports
 * the routes that import this file).
 */
export function attachAppStream(server: Server, app: Express) {
  // noServer: this file decides which upgrade requests to accept (below);
  // maxPayload caps what a phone may send in one message.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  server.on("upgrade", (raw: IncomingMessage, socket: Duplex, head: Buffer) => {
    // An error on the raw socket (the phone dropped mid-handshake) must not
    // crash the engine.
    socket.on("error", () => socket.destroy());
    void (async () => {
      const req = asExpressRequest(raw, app);
      if (req.path !== STREAM_PATH) return refuse(socket, 404);
      const blocked = await gateUpgrade(req);
      if (blocked) return refuse(socket, blocked);
      const header = req.headers.authorization;
      const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
      const device = token ? await db.query.appDevices.findFirst({ where: eq(appDevices.tokenHash, hashDeviceToken(token)) }) : undefined;
      if (!device) {
        await recordSecurityEvent("bad_app_token", { req, detail: token ? "unknown token" : "no token sent" });
        return refuse(socket, 401);
      }
      const ip = clientIp(req);
      await db.update(appDevices).set({ lastConnectedAt: new Date(), lastIp: ip }).where(eq(appDevices.id, device.id));
      wss.handleUpgrade(raw, socket, head, (ws) => onConnection(ws, device.id, device.name));
    })().catch((err) => {
      logger.error("app", `App stream upgrade failed: ${err instanceof Error ? err.message : String(err)}`, "A phone couldn't connect to the notification stream because of a server error.");
      refuse(socket, 403);
    });
  });

  // The server-side heartbeat: a connection that didn't answer the last ping
  // is closed (`alive` is set again by each pong).
  const timer = setInterval(() => {
    for (const set of connections.values()) {
      for (const ws of set) {
        const tracked = ws as WebSocket & { alive?: boolean };
        if (tracked.alive === false) {
          ws.terminate();
          continue;
        }
        tracked.alive = false;
        ws.ping();
      }
    }
  }, PING_MS);
  timer.unref();
  server.on("close", () => {
    clearInterval(timer);
    wss.close();
  });
}

/**
 * Sets up one accepted phone connection: remembers it, says hello, sends the
 * backlog, and handles its messages until it closes.
 */
function onConnection(ws: WebSocket, deviceId: string, name: string) {
  const tracked = ws as WebSocket & { alive?: boolean };
  tracked.alive = true;
  ws.on("pong", () => (tracked.alive = true));
  const set = connections.get(deviceId) ?? new Set<WebSocket>();
  // Over the cap: close the oldest (Sets keep insertion order).
  while (set.size >= MAX_CONNECTIONS_PER_DEVICE) {
    const oldest = set.values().next().value as WebSocket;
    set.delete(oldest);
    oldest.close(4002, "Too many connections");
  }
  set.add(ws);
  connections.set(deviceId, set);
  logger.info("app", `Phone "${name}" connected to the notification stream`, `The Looksee app on "${name}" connected.`, { deviceId });

  ws.on("message", (data) => {
    handleMessage(deviceId, ws, data.toString()).catch((err) => logger.error("app", `Handling a message from phone ${deviceId} failed: ${err instanceof Error ? err.message : String(err)}`, "A message from a phone couldn't be processed."));
  });
  ws.on("close", () => {
    set.delete(ws);
    if (!set.size) connections.delete(deviceId);
  });
  // An error (for example a message over maxPayload) needs a listener so it
  // can't crash the engine; the ws library then closes the connection itself
  // with the right close code (1009 "message too big").
  ws.on("error", () => undefined);

  ws.send(JSON.stringify({ type: "hello", device: { id: deviceId, name }, serverVersion: VERSION }));
  pushPending(deviceId).catch((err) => logger.error("app", `Sending queued notifications to phone ${deviceId} failed: ${err instanceof Error ? err.message : String(err)}`, "Queued notifications couldn't be sent to a phone; they'll be retried when it reconnects."));
}

/**
 * Closes every open connection for a device. Used when the device is removed
 * (Security page, or signing out in the app), so a revoked phone stops
 * receiving at once rather than at its next reconnect.
 */
export function disconnectDevice(deviceId: string) {
  for (const ws of connections.get(deviceId) ?? []) ws.close(4001, "Device removed");
  connections.delete(deviceId);
}
