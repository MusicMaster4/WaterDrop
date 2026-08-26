"use strict";

const { execFile } = require("child_process");
const fs = require("fs");
const http = require("http");

const CANDIDATES = {
  win32: [
    "C:\\Program Files\\Tailscale\\tailscale.exe",
    "C:\\Program Files (x86)\\Tailscale\\tailscale.exe",
  ],
  darwin: [
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    "/opt/homebrew/bin/tailscale",
    "/usr/local/bin/tailscale",
  ],
  linux: ["/usr/bin/tailscale", "/usr/local/bin/tailscale"],
};

function exePath() {
  const candidates = CANDIDATES[process.platform] || [];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }
  return process.platform === "win32" ? "tailscale.exe" : "tailscale";
}

function run(args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(exePath(), args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        err,
        stdout: stdout || "",
        stderr: stderr || "",
        message: err ? String(stderr || err.message || err) : "",
      });
    });
  });
}

async function status() {
  const result = await run(["status", "--json"]);
  if (!result.ok && !result.stdout) {
    return {
      found: false,
      running: false,
      loggedIn: false,
      dnsName: null,
      tailnetIp: null,
      backendState: null,
      message: result.message,
    };
  }

  try {
    const data = JSON.parse(result.stdout);
    const backendState = data.BackendState || null;
    const self = data.Self || {};
    const ips = self.TailscaleIPs || data.TailscaleIPs || [];
    const tailnetIp = ips.find((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip)) || null;
    const dnsName = self.DNSName ? String(self.DNSName).replace(/\.$/, "") : null;
    return {
      found: true,
      running: backendState === "Running",
      loggedIn: backendState !== "NeedsLogin" && backendState !== "NoState",
      dnsName,
      tailnetIp,
      backendState,
      magicDns: Boolean(data.CurrentTailnet && data.CurrentTailnet.MagicDNSEnabled),
      message: "",
    };
  } catch (err) {
    return {
      found: true,
      running: false,
      loggedIn: false,
      dnsName: null,
      tailnetIp: null,
      backendState: null,
      message: `Could not parse Tailscale status: ${err.message}`,
    };
  }
}

async function serveStatus() {
  const result = await run(["serve", "status", "--json"]);
  if (!result.ok && !result.stdout) {
    return { ok: false, config: null, message: result.message };
  }
  try {
    return { ok: true, config: JSON.parse(result.stdout), message: "" };
  } catch (err) {
    return { ok: false, config: null, message: `Could not parse serve status: ${err.message}` };
  }
}

function findServeHandler(config, pathName = "/drop") {
  const web = config && config.Web ? config.Web : {};
  for (const [host, value] of Object.entries(web)) {
    const handlers = value && value.Handlers ? value.Handlers : {};
    if (handlers[pathName]) {
      return {
        host,
        path: pathName,
        proxy: handlers[pathName].Proxy || null,
        handler: handlers[pathName],
      };
    }
  }
  return null;
}

function proxyTargetsPort(proxy, port) {
  try {
    const target = new URL(String(proxy || ""));
    const host = target.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return (
      target.protocol === "http:" &&
      ["127.0.0.1", "localhost", "::1"].includes(host) &&
      Number(target.port) === Number(port) &&
      (target.pathname === "/" || target.pathname === "")
    );
  } catch {
    return false;
  }
}

function probeLocalOrigin(port, timeout = 2500) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (reachable, message = "") => {
      if (settled) return;
      settled = true;
      resolve({ reachable, message });
    };
    const req = http.get(
      { host: "127.0.0.1", port, path: "/drop/", timeout },
      (res) => {
        let bytes = 0;
        res.on("data", (chunk) => { bytes += chunk.length; });
        res.on("end", () => {
          const reachable = res.statusCode === 200 && bytes > 0;
          finish(reachable, reachable ? "" : `Local /drop/ returned HTTP ${res.statusCode} with ${bytes} bytes`);
        });
        res.on("error", (err) => finish(false, err.message));
      }
    );
    req.on("timeout", () => req.destroy(new Error("Local /drop/ probe timed out")));
    req.on("error", (err) => finish(false, err.message));
  });
}

async function inspect(port, { httpsPort } = {}) {
  const ts = await status();
  const serve = await serveStatus();
  const handler = serve.ok ? findServeHandler(serve.config, "/drop") : null;
  const serveProxyMatches = Boolean(handler && proxyTargetsPort(handler.proxy, port));
  const origin = serveProxyMatches
    ? await probeLocalOrigin(port)
    : { reachable: false, message: handler ? "Tailscale Serve points to a different WaterDrop port" : "" };
  const servePathConfigured = serveProxyMatches && origin.reachable;
  const serveUrl = ts.dnsName ? `https://${ts.dnsName}/drop/` : null;
  const directUrl = ts.tailnetIp ? `http://${ts.tailnetIp}:${port}/drop/` : null;
  const localUrl = `http://127.0.0.1:${port}/drop/`;
  // Direct HTTPS to this process (own Tailscale cert). Fastest and still a secure
  // context, so it's the preferred link whenever it's up.
  const httpsDirectUrl = ts.dnsName && httpsPort ? `https://${ts.dnsName}:${httpsPort}/drop/` : null;

  return {
    ...ts,
    serveOk: serve.ok,
    serveMessage: serve.message || origin.message,
    servePathPresent: Boolean(handler),
    serveProxyMatches,
    serveOriginReachable: origin.reachable,
    servePathConfigured,
    serveProxy: handler ? handler.proxy : null,
    serveUrl,
    directUrl,
    // Advertised for the client to probe and route bulk transfers through when
    // reachable, but NOT the QR link: a phone must be able to open the QR, and
    // the direct port may be blocked by the Windows firewall. Serve always works.
    httpsDirectUrl,
    localUrl,
    preferredUrl: servePathConfigured && serveUrl ? serveUrl : directUrl || localUrl,
    serveCommand: `tailscale serve --bg --yes --set-path /drop http://127.0.0.1:${port}`,
  };
}

// Ask Tailscale to issue (and thereafter renew) a TLS cert for this node's
// MagicDNS name, written to the given files. Needs HTTPS certs enabled on the
// tailnet; best-effort — the caller falls back to Serve/local if it fails.
async function provisionCert(dnsName, certPath, keyPath) {
  if (!dnsName) return { ok: false, message: "No MagicDNS name" };
  const result = await run(["cert", "--cert-file", certPath, "--key-file", keyPath, dnsName], 45000);
  if (!result.ok) {
    return { ok: false, message: result.message || "tailscale cert failed" };
  }
  return { ok: true, message: result.stdout.trim() || "cert ready" };
}

async function configureServe(port) {
  const target = `http://127.0.0.1:${port}`;
  const result = await run(["serve", "--bg", "--yes", "--set-path", "/drop", target], 15000);
  if (!result.ok) {
    return { ok: false, message: result.message || "tailscale serve failed" };
  }
  const info = await inspect(port);
  if (!info.servePathConfigured) {
    return {
      ok: false,
      message: info.serveMessage || "Tailscale Serve was configured, but /drop/ is not reachable",
      info,
    };
  }
  return { ok: true, message: result.stdout.trim(), info };
}

module.exports = {
  configureServe,
  exePath,
  findServeHandler,
  inspect,
  probeLocalOrigin,
  provisionCert,
  proxyTargetsPort,
  run,
  serveStatus,
  status,
};
