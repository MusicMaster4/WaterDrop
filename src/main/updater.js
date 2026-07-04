"use strict";

// In-app auto-update, powered by electron-updater talking to GitHub Releases.
//
// The CI workflow (.github/workflows/release.yml) publishes an installer plus a
// `latest.yml` manifest on every push. This module reads that manifest, tells
// the renderer what it found, and — when the user asks — downloads and installs
// the new version while preserving their settings.

const { app, ipcMain } = require("electron");
const { autoUpdater } = require("electron-updater");

let targetWindow = null;
let lastStatus = { state: "idle" };
let checkInFlight = false;

function send(status) {
  lastStatus = { ...status, currentVersion: app.getVersion() };
  if (targetWindow && !targetWindow.isDestroyed()) {
    targetWindow.webContents.send("waterdrop:update-status", lastStatus);
  }
}

function wireAutoUpdaterEvents() {
  autoUpdater.on("checking-for-update", () => send({ state: "checking" }));

  autoUpdater.on("update-available", (info) => {
    send({ state: "available", version: info?.version, notes: normalizeNotes(info?.releaseNotes) });
  });

  autoUpdater.on("update-not-available", () => send({ state: "up-to-date" }));

  autoUpdater.on("download-progress", (progress) => {
    send({
      state: "downloading",
      percent: Math.round(progress?.percent || 0),
      transferred: progress?.transferred,
      total: progress?.total,
      bytesPerSecond: progress?.bytesPerSecond,
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    send({ state: "downloaded", version: info?.version, notes: normalizeNotes(info?.releaseNotes) });
  });

  autoUpdater.on("error", (err) => {
    send({ state: "error", message: (err && err.message) || String(err) });
  });
}

function normalizeNotes(notes) {
  if (!notes) return "";
  if (typeof notes === "string") return notes;
  // GitHub can return an array of { version, note } objects.
  if (Array.isArray(notes)) {
    return notes.map((entry) => (entry && entry.note) || "").filter(Boolean).join("\n\n");
  }
  return "";
}

async function checkForUpdates({ silent = false } = {}) {
  if (!app.isPackaged) {
    send({ state: "dev" });
    return lastStatus;
  }
  if (checkInFlight) return lastStatus;
  checkInFlight = true;
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    if (!silent) send({ state: "error", message: (err && err.message) || String(err) });
  } finally {
    checkInFlight = false;
  }
  return lastStatus;
}

// Set up the updater, wire IPC, and kick off a quiet check shortly after launch.
function initUpdater(window) {
  targetWindow = window;

  autoUpdater.autoDownload = false; // let the user decide when to download
  autoUpdater.autoInstallOnAppQuit = true;

  // Channel isolation: the build's own version decides which release channel it
  // follows. A prerelease build (e.g. `1.2.3-testing.4`) follows a custom
  // channel named after its prerelease tag ("testing") and reads only
  // `testing.yml` from prerelease GitHub Releases. A stable build (`1.2.3`)
  // follows "latest" and reads only `latest.yml`.
  //
  // The channel name must NOT be "alpha"/"beta": electron-updater's GitHub
  // provider hardcodes those two as cascading channels — a beta client is made
  // to also accept stable releases and fall back to `latest.yml`, which would
  // defeat the isolation. Any other name is treated as a fully isolated channel.
  const version = app.getVersion();
  const prereleaseTag = version.includes("-")
    ? version.split("-")[1].split(".")[0]
    : null;
  autoUpdater.channel = prereleaseTag || "latest";
  autoUpdater.allowPrerelease = prereleaseTag !== null;

  wireAutoUpdaterEvents();

  ipcMain.handle("waterdrop:update-check", async (_event, opts) => checkForUpdates(opts || {}));

  ipcMain.handle("waterdrop:update-download", async () => {
    if (!app.isPackaged) return { ok: false, message: "Updates only run in the installed app." };
    try {
      await autoUpdater.downloadUpdate();
      return { ok: true };
    } catch (err) {
      const message = (err && err.message) || String(err);
      send({ state: "error", message });
      return { ok: false, message };
    }
  });

  ipcMain.handle("waterdrop:update-install", async () => {
    if (!app.isPackaged) return { ok: false, message: "Updates only run in the installed app." };
    // isSilent=false shows the installer UI, forceRunAfter reopens the app.
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return { ok: true };
  });

  ipcMain.handle("waterdrop:update-status", async () => lastStatus);

  // Give the window a moment to finish loading, then check quietly.
  setTimeout(() => {
    checkForUpdates({ silent: true });
  }, 4000);
}

module.exports = { initUpdater, checkForUpdates };
