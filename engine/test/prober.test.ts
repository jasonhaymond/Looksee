import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runProbe } from "../src/services/prober.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

let httpServer: http.Server;
let httpPort: number;
let lastRequest: { method?: string; headers: http.IncomingHttpHeaders } | null = null;

let httpsServer: https.Server;
let httpsPort: number;

beforeAll(async () => {
  httpServer = http.createServer((req, res) => {
    lastRequest = { method: req.method, headers: req.headers };
    res.writeHead(200);
    res.end('{"status":"healthy"}');
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  httpPort = (httpServer.address() as { port: number }).port;

  httpsServer = https.createServer(
    {
      key: fs.readFileSync(path.join(fixturesDir, "self-signed.key")),
      cert: fs.readFileSync(path.join(fixturesDir, "self-signed.crt")),
    },
    (_req, res) => {
      res.writeHead(200);
      res.end('{"status":"healthy"}');
    }
  );
  await new Promise<void>((resolve) => httpsServer.listen(0, "127.0.0.1", resolve));
  httpsPort = (httpsServer.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise((resolve) => httpServer.close(resolve));
  await new Promise((resolve) => httpsServer.close(resolve));
});

describe("prober http extras", () => {
  it("sends a custom header and the configured method", async () => {
    const result = await runProbe("http", {
      url: `http://127.0.0.1:${httpPort}/`,
      method: "POST",
      headers: "Authorization: Bearer test-token\nX-Custom: yes",
    });
    expect(result.status).toBe("up");
    expect(lastRequest?.method).toBe("POST");
    expect(lastRequest?.headers["authorization"]).toBe("Bearer test-token");
    expect(lastRequest?.headers["x-custom"]).toBe("yes");
  });

  it("fails a self-signed HTTPS endpoint by default", async () => {
    const result = await runProbe("http", { url: `https://127.0.0.1:${httpsPort}/` });
    expect(result.status).toBe("down");
  });

  it("succeeds against the same self-signed endpoint with insecureSkipVerify", async () => {
    const result = await runProbe("http", { url: `https://127.0.0.1:${httpsPort}/`, insecureSkipVerify: true });
    expect(result.status).toBe("up");
  });

  it("passes bodyContains when the text is present (fetch path)", async () => {
    const result = await runProbe("http", { url: `http://127.0.0.1:${httpPort}/`, bodyContains: "healthy" });
    expect(result.status).toBe("up");
  });

  it("fails bodyContains when the text is missing, even with a 200 (fetch path)", async () => {
    const result = await runProbe("http", { url: `http://127.0.0.1:${httpPort}/`, bodyContains: "totally-not-present" });
    expect(result.status).toBe("down");
    expect(result.message).toMatch(/didn't contain/);
  });

  it("checks bodyContains on the insecure-TLS path too", async () => {
    const pass = await runProbe("http", { url: `https://127.0.0.1:${httpsPort}/`, insecureSkipVerify: true, bodyContains: "healthy" });
    expect(pass.status).toBe("up");
    const fail = await runProbe("http", { url: `https://127.0.0.1:${httpsPort}/`, insecureSkipVerify: true, bodyContains: "nope" });
    expect(fail.status).toBe("down");
  });
});

// SNMP needs a real daemon to talk to (unlike ping/tcp/http, there's no
// convenient in-process fake to stand up the way the http/https servers
// above are), so these are Docker-free code-path tests only — missing
// config, and a real network-level failure (nothing listening) resolving
// to "down" rather than hanging or throwing. The actual protocol —
// v1/v2c and v3 authPriv, both a real value returned and real
// authentication failures correctly reported — was verified for real
// against a real snmpd (v1/v2c via a plain container, v3 against a
// hand-configured SNMPv3 user) during development; see CHANGELOG.md.
describe("prober snmp", () => {
  it("warns on missing host/oid rather than attempting a request", async () => {
    const result = await runProbe("snmp", { host: "", oid: "" });
    expect(result.status).toBe("warn");
  });

  it("reports down (not a thrown error) when nothing is listening", async () => {
    const result = await runProbe("snmp", { host: "127.0.0.1", port: 1, version: "2c", community: "public", oid: "1.3.6.1.2.1.1.3.0" });
    expect(result.status).toBe("down");
  }, 15_000);
});
