"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createServeSupervisor } = require("../src/main/serveSupervisor");

test("keeps an already published Serve path unchanged", async () => {
  let configureCalls = 0;
  const supervisor = createServeSupervisor({
    tailscale: {
      inspect: async () => ({ running: true, loggedIn: true, servePathConfigured: true }),
      configureServe: async () => {
        configureCalls += 1;
        return { ok: true };
      },
    },
    getPort: () => 41737,
  });

  const result = await supervisor.ensureAvailable();

  assert.equal(result.ok, true);
  assert.equal(result.repaired, false);
  assert.equal(configureCalls, 0);
});

test("republishes /drop when Tailscale loses its Serve configuration", async () => {
  const configuredPorts = [];
  const supervisor = createServeSupervisor({
    tailscale: {
      inspect: async () => ({ running: true, loggedIn: true, servePathConfigured: false }),
      configureServe: async (port) => {
        configuredPorts.push(port);
        return { ok: true, info: { servePathConfigured: true } };
      },
    },
    getPort: () => 41742,
  });

  const result = await supervisor.ensureAvailable();

  assert.equal(result.ok, true);
  assert.equal(result.repaired, true);
  assert.deepEqual(configuredPorts, [41742]);
});

test("waits for Tailscale to reconnect without changing Serve", async () => {
  let configureCalls = 0;
  const supervisor = createServeSupervisor({
    tailscale: {
      inspect: async () => ({ running: false, loggedIn: true, servePathConfigured: false }),
      configureServe: async () => {
        configureCalls += 1;
        return { ok: true };
      },
    },
    getPort: () => 41737,
  });

  const result = await supervisor.ensureAvailable();

  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.equal(configureCalls, 0);
});

test("coalesces overlapping checks into one publication attempt", async () => {
  let inspectCalls = 0;
  let releaseInspect;
  const inspectGate = new Promise((resolve) => { releaseInspect = resolve; });
  const supervisor = createServeSupervisor({
    tailscale: {
      inspect: async () => {
        inspectCalls += 1;
        await inspectGate;
        return { running: true, loggedIn: true, servePathConfigured: false };
      },
      configureServe: async () => ({ ok: true }),
    },
    getPort: () => 41737,
  });

  const first = supervisor.ensureAvailable();
  const second = supervisor.ensureAvailable();
  releaseInspect();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(inspectCalls, 1);
  assert.equal(firstResult.ok, true);
  assert.equal(secondResult.ok, true);
});
