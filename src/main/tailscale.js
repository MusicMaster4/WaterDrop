"use strict";

const { execFile } = require("child_process");
const fs = require("fs");

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

async function inspect(port) {
  const ts = await status();
  const serve = await serveStatus();
  const handler = serve.ok ? findServeHandler(serve.config, "/drop") : null;
  const serveUrl = ts.dnsName ? `https://${ts.dnsName}/drop/` : null;
  const directUrl = ts.tailnetIp ? `http://${ts.tailnetIp}:${port}/drop/` : null;
  const localUrl = `http://127.0.0.1:${port}/drop/`;

  return {
    ...ts,
    serveOk: serve.ok,
    serveMessage: serve.message,
    servePathConfigured: Boolean(handler),
    serveProxy: handler ? handler.proxy : null,
    serveUrl,
    directUrl,
    localUrl,
    preferredUrl: handler && serveUrl ? serveUrl : directUrl || localUrl,
    serveCommand: `tailscale serve --bg --yes --set-path /drop http://127.0.0.1:${port}`,
  };
}

async function configureServe(port) {
  const target = `http://127.0.0.1:${port}`;
  const result = await run(["serve", "--bg", "--yes", "--set-path", "/drop", target], 15000);
  if (!result.ok) {
    return { ok: false, message: result.message || "tailscale serve failed" };
  }
  return { ok: true, message: result.stdout.trim(), info: await inspect(port) };
}

module.exports = {
  configureServe,
  exePath,
  inspect,
  run,
  serveStatus,
  status,
};

