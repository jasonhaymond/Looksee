import net from "node:net";
import tls from "node:tls";
import dgram from "node:dgram";

// Connect, optionally write `send`, and collect bytes until `until` returns
// true or the timeout passes. The building block for every banner/protocol
// probe — each one only has to describe what it sends and what "good"
// looks like.
export function tcpExchange(opts: {
  host: string;
  port: number;
  tls?: boolean;
  insecure?: boolean;
  timeoutMs?: number;
  send?: Buffer | string | ((received: Buffer) => Buffer | string | null);
  until?: (received: Buffer) => boolean;
}): Promise<{ data: Buffer; latencyMs: number; socket?: tls.TLSSocket }> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const start = Date.now();
  return new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    let done = false;
    const socket = opts.tls
      ? tls.connect({ host: opts.host, port: opts.port, servername: net.isIP(opts.host) ? undefined : opts.host, rejectUnauthorized: !opts.insecure })
      : net.createConnection({ host: opts.host, port: opts.port });
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve({ data, latencyMs: Date.now() - start });
    };
    const timer = setTimeout(() => (data.length ? finish() : finish(new Error(`Timed out after ${timeoutMs}ms waiting for ${opts.host}:${opts.port}`))), timeoutMs);
    socket.once(opts.tls ? "secureConnect" : "connect", () => {
      if (typeof opts.send === "string" || Buffer.isBuffer(opts.send)) socket.write(opts.send);
      else if (typeof opts.send === "function") {
        const first = opts.send(data);
        if (first != null) socket.write(first);
      }
      if (!opts.until) finish();
    });
    socket.on("data", (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      if (opts.until?.(data)) finish();
    });
    socket.once("error", (err) => finish(err));
    socket.once("end", () => finish());
  });
}

export function udpExchange(opts: { host: string; port: number; payload: Buffer; timeoutMs?: number; bindPort?: number; broadcast?: boolean; reuseAddr?: boolean }): Promise<{ data: Buffer; from: string; latencyMs: number }> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  return new Promise((resolve, reject) => {
    const type = net.isIPv6(opts.host) ? "udp6" : "udp4";
    const socket = dgram.createSocket({ type, reuseAddr: opts.reuseAddr });
    const start = Date.now();
    let done = false;
    const finish = (err: Error | null, result?: { data: Buffer; from: string; latencyMs: number }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // already closed
      }
      if (err) reject(err);
      else resolve(result!);
    };
    const timer = setTimeout(() => finish(new Error(`No UDP reply from ${opts.host}:${opts.port} within ${timeoutMs}ms`)), timeoutMs);
    socket.on("message", (msg, rinfo) => finish(null, { data: msg, from: rinfo.address, latencyMs: Date.now() - start }));
    socket.on("error", (err) => finish(err));
    const send = () => {
      if (opts.broadcast) socket.setBroadcast(true);
      socket.send(opts.payload, opts.port, opts.host, (err) => err && finish(err));
    };
    if (opts.bindPort != null) socket.bind(opts.bindPort, send);
    else send();
  });
}

// "41 42 0a" / "4142" / "\x41" style input -> bytes; anything else is text.
export function parsePayload(raw: string, hex: boolean): Buffer {
  if (hex) return Buffer.from(raw.replace(/0x|\\x|[\s,:]/gi, ""), "hex");
  return Buffer.from(raw.replace(/\\r/g, "\r").replace(/\\n/g, "\n"), "utf-8");
}
