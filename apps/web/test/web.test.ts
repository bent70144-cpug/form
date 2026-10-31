import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createWebServer } from "../src/server";
import { en } from "@form/i18n";

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ port, path, host: "127.0.0.1" }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on("error", reject);
  });
}

describe("web server", () => {
  let upstream: http.Server;
  let upstreamPort: number;
  let web: http.Server;
  let webPort: number;

  beforeAll(async () => {
    // Stand-in internal API used to verify the /v1/* proxy seam.
    upstream = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", db: true, servedBy: "internal-api" }));
      void req;
    });
    upstreamPort = await listen(upstream);
    web = createWebServer({ apiInternalUrl: `http://127.0.0.1:${upstreamPort}` });
    webPort = await listen(web);
  });

  afterAll(() => {
    upstream.close();
    web.close();
  });

  it("renders the home page with i18n catalog strings", async () => {
    const res = await get(webPort, "/");
    expect(res.status).toBe(200);
    expect(res.body).toContain(en.home.title);
    expect(res.body).toContain(en.home.subtitle);
  });

  it("proxies /v1/* to the internal API (the rewrite seam)", async () => {
    const res = await get(webPort, "/v1/health");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { servedBy: string };
    expect(body.servedBy).toBe("internal-api");
  });

  it("answers 404 for unknown non-v1 paths", async () => {
    const res = await get(webPort, "/nothing");
    expect(res.status).toBe(404);
  });
});
