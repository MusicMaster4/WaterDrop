"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const {
  findServeHandler,
  probeLocalOrigin,
  proxyTargetsPort,
} = require("../src/main/tailscale");

test("finds /drop without treating a stale proxy as the current server", () => {
  const handler = findServeHandler({
    Web: {
      "desktop.example.ts.net:443": {
        Handlers: {
          "/drop": { Proxy: "http://127.0.0.1:41738" },
        },
      },
    },
  });

  assert.equal(handler.proxy, "http://127.0.0.1:41738");
  assert.equal(proxyTargetsPort(handler.proxy, 41737), false);
  assert.equal(proxyTargetsPort(handler.proxy, 41738), true);
  assert.equal(proxyTargetsPort("http://localhost:41738", 41738), true);
  assert.equal(proxyTargetsPort("https://127.0.0.1:41738", 41738), false);
  assert.equal(proxyTargetsPort("http://127.0.0.1:41738/other", 41738), false);
});

test("local origin probe requires a complete, non-empty /drop/ response", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/drop/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<!doctype html><title>WaterDrop</title>");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const result = await probeLocalOrigin(server.address().port);
    assert.deepEqual(result, { reachable: true, message: "" });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("local origin probe rejects an aborted page response", async () => {
  const server = http.createServer((_req, res) => res.destroy());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const result = await probeLocalOrigin(server.address().port);
    assert.equal(result.reachable, false);
    assert.ok(result.message);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
