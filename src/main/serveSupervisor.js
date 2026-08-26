"use strict";

const DEFAULT_CHECK_INTERVAL_MS = 30 * 1000;

// Tailscale normally persists Serve configuration, but the configuration can
// disappear when its service restarts, updates, or reconnects. Keep /drop in
// the desired state for as long as WaterDrop is running instead of relying on
// the single publication attempt made at startup.
function createServeSupervisor({
  tailscale,
  getPort,
  onError = () => {},
  intervalMs = DEFAULT_CHECK_INTERVAL_MS,
  schedule = setTimeout,
  cancel = clearTimeout,
}) {
  let stopped = true;
  let timer = null;
  let inFlight = null;
  let lastReportedFailure = "";

  function reportFailure(context, error) {
    const message = error?.message || String(error || "Unknown error");
    const signature = `${context}:${message}`;
    if (signature === lastReportedFailure) return;
    lastReportedFailure = signature;
    onError(context, error);
  }

  function clearFailure() {
    lastReportedFailure = "";
  }

  async function ensureAvailable() {
    if (inFlight) return inFlight;

    inFlight = (async () => {
      const port = Number(getPort());
      if (!Number.isInteger(port) || port <= 0) {
        return { ok: false, skipped: true, message: "WaterDrop server is not ready" };
      }

      try {
        const current = await tailscale.inspect(port);
        if (!current.running || !current.loggedIn) {
          return {
            ok: false,
            skipped: true,
            message: current.message || "Tailscale is not connected",
            info: current,
          };
        }
        if (current.servePathConfigured) {
          clearFailure();
          return { ok: true, repaired: false, info: current };
        }

        const result = await tailscale.configureServe(port);
        if (!result.ok) {
          reportFailure("serve auto-republish failed", result.message || "tailscale serve failed");
          return result;
        }

        clearFailure();
        return { ...result, repaired: true };
      } catch (error) {
        reportFailure("serve availability check failed", error);
        return { ok: false, message: error?.message || String(error) };
      }
    })();

    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  async function tick() {
    await ensureAvailable();
    if (stopped) return;
    timer = schedule(tick, intervalMs);
    timer?.unref?.();
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    tick();
  }

  function stop() {
    stopped = true;
    if (timer !== null) cancel(timer);
    timer = null;
  }

  return { ensureAvailable, start, stop };
}

module.exports = { DEFAULT_CHECK_INTERVAL_MS, createServeSupervisor };
