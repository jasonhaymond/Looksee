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
    res.end("ok");
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
      res.end("ok");
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
});
