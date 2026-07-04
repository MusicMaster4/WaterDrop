"use strict";

const { app, BrowserWindow, Menu, Tray, clipboard, dialog, ipcMain, nativeImage, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { createDropServer } = require("../server/dropServer");
const tailscale = require("./tailscale");
const { initUpdater } = require("./updater");

let mainWindow = null;
let dropServer = null;
let tray = null;
let isQuitting = false;
let dragIconImage = null;
let appIconImage = null;

// Write startup problems somewhere we can read them from an installed build,
// where there is no console. Failing to log must never itself crash the app.
function logDiagnostic(context, err) {
  const line = `[${new Date().toISOString()}] ${context}: ${err && err.stack ? err.stack : err}\n`;
  console.error(line);
  try {
    fs.appendFileSync(path.join(app.getPath("userData"), "waterdrop-main.log"), line);
  } catch {
    /* logging is best-effort */
  }
}

// A crash in the main process during startup leaves the app as an invisible,
// stuck process (no window, ghost tray). Surface it instead of dying silently.
process.on("uncaughtException", (err) => logDiagnostic("uncaughtException", err));
process.on("unhandledRejection", (err) => logDiagnostic("unhandledRejection", err));

const FALLBACK_DRAG_ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAsTAAALEwEAmpwYAAACaElEQVRYhcWXwUtUQRzH30XTkpDV3e2mHt33XC2yOkuyBFqQLhtdxTLpT0itQ9GlcFGUMm0LWZKlS6EEpXSpEIMOWpDVSVcDT2bNzO9h/GKGZllXV98b560D38t7b37fz/x+w+P3M4ycBQB1hEKcUHuBUPhNmY37EY/xP1Y/AFhGvoWIhwiDIULh735Nd4HZJAwGEbF4J/MZr4y3gTCY3gJBGAwXyjwLYiC75p6lfbdyAIBp8AunGuThyCiOPBpTB6Fw3yDU/qyyee7jJ/T5KrG83Iezs3OKWbDneQY23G5c/bmGtbUmlpQcFgqFLPFMoQy/DBXyi23RjLlUezSmlAVDpe655lKjYwlvAb4ufsdAIJgXgL9b/PbDGwBCAZubI3nNpSKRc+Jb7QDJ5LM9zaUmJlJ6Af4QhqZZ5xggHK53nAXDyUcvXk46NpeanHqlD6Cz86prgK6ubn0AlhV2DcDLoA2gosLvGoDv0Qbg9wdcA/B/gjaAk42nRdCG4ycwGr3kCKDx1Bl9ADd6+kTQx4knOL/wBVtaz+8J0Nt3Sx/A0nJalCEWuywApmfeYlVVTV7zYPAYpldW9QFQZou/W1nZUUwkngqId+8/4LXu6xiub9hiXlp6BFOp545iugKQENXVNTg0/EBASDU1nc2c3I25AOBNgZsNy+kV7Om9iR0dV/D2nbs4Pp7EltYLouZO0y5FKKwrt2Q6JFuy/oMCoBTu8bbc4i1y4U8Pm4yxkBxMBg8AIJ49mhUTBm8KZs7gNSIW5c6HHGLAy3KI4ZRCfJt5znhu8omF31CVmWEH0w0ei1+4TM2z1j96Zhr0dLxoBwAAAABJRU5ErkJggg==";

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
}

function appRoot() {
  return app.getAppPath();
}

function rendererDir() {
  return path.join(appRoot(), "dist", "renderer");
}

// Candidate icon locations, in priority order. `dist/renderer/icon.ico` is
// always bundled (Vite copies it from public/), so it works even if `assets/`
// is ever missing from the package — no more crashing on a missing icon.
function iconCandidates() {
  return [
    path.join(appRoot(), "assets", "icon.ico"),
    path.join(rendererDir(), "icon.ico"),
    path.join(__dirname, "..", "renderer", "public", "icon.ico"),
  ];
}

// Always returns a usable, non-empty NativeImage (falls back to an embedded
// image), so Tray/BrowserWindow creation can never fail on a bad icon path.
function appIcon() {
  if (appIconImage && !appIconImage.isEmpty()) return appIconImage;
  for (const candidate of iconCandidates()) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const image = nativeImage.createFromPath(candidate);
      if (!image.isEmpty()) {
        appIconImage = image;
        return appIconImage;
      }
    } catch (err) {
      logDiagnostic(`icon load failed (${candidate})`, err);
    }
  }
  appIconImage = nativeImage.createFromDataURL(FALLBACK_DRAG_ICON);
  return appIconImage;
}

function dragIcon() {
  if (dragIconImage && !dragIconImage.isEmpty()) return dragIconImage;
  const base = appIcon();
  const resized = base.resize({ width: 32, height: 32 });
  dragIconImage = resized.isEmpty() ? base : resized;
  return dragIconImage;
}

function isValidFileId(id) {
  return typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id);
}

function shouldStartHidden() {
  return process.argv.includes("--hidden") || process.argv.includes("--background");
}

async function startServer() {
  const dataDir = path.join(app.getPath("userData"), "storage");
  dropServer = await createDropServer({
    dataDir,
    defaultDownloadDir: app.getPath("downloads"),
    rendererDir: rendererDir(),
  });
  return dropServer;
}

// Publish `/drop` over Tailscale Serve so the QR code carries the real
// phone-reachable HTTPS link (https://<name>.ts.net/drop/) instead of a raw
// loopback/IP:port URL that a phone can't open. Best-effort and non-blocking:
// if Tailscale is missing or serve isn't available, the app still works locally.
async function autoPublishServe() {
  try {
    if (!dropServer) return;
    const state = await tailscale.status();
    if (!state.running || !state.loggedIn) return;
    const current = await tailscale.inspect(dropServer.port);
    if (current.servePathConfigured) return; // already published to this port
    const result = await tailscale.configureServe(dropServer.port);
    if (!result.ok) logDiagnostic("auto serve publish failed", result.message);
  } catch (err) {
    logDiagnostic("auto serve publish error", err);
  }
}

async function createWindow() {
  const preload = path.join(__dirname, "preload.js");
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 920,
    minHeight: 620,
    backgroundColor: "#08080a",
    title: "Water Drop",
    show: !shouldStartHidden(),
    icon: appIcon(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload,
      sandbox: false,
    },
  });

  mainWindow.on("close", (event) => {
    if (isQuitting || !dropServer.store.settings.minimizeToTray) return;
    event.preventDefault();
    mainWindow.hide();
  });

  const devUrl = process.env.WATERDROP_RENDERER_URL;
  const targetUrl = devUrl ? `${devUrl}/?desktop=1` : `${dropServer.localUrl}?desktop=1`;
  await mainWindow.loadURL(targetUrl);

  if (process.env.WATERDROP_OPEN_DEVTOOLS === "1") {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }
}

function showMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  if (tray) return;
  try {
    tray = new Tray(appIcon());
  } catch (err) {
    // A tray failure must never prevent the app window from opening.
    logDiagnostic("tray creation failed", err);
    return;
  }
  tray.setToolTip("Water Drop");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Water Drop", click: showMainWindow },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ])
  );
  tray.on("click", showMainWindow);
  tray.on("double-click", showMainWindow);
}

function applyLoginSettings() {
  const settings = dropServer.store.settings;
  app.setLoginItemSettings({
    openAtLogin: Boolean(settings.startOnLogin),
    openAsHidden: true,
    args: ["--hidden"],
  });
}

function wireIpc() {
  ipcMain.handle("waterdrop:app-info", async () => ({
    version: app.getVersion(),
    platform: process.platform,
    isPackaged: app.isPackaged,
    server: {
      port: dropServer.port,
      basePath: dropServer.basePath,
      localUrl: dropServer.localUrl,
    },
    settings: dropServer.store.settings,
    loginItem: app.getLoginItemSettings({ args: ["--hidden"] }),
    paths: {
      dataDir: dropServer.store.dataDir,
      downloadDir: dropServer.store.settings.downloadDir,
    },
    network: await tailscale.inspect(dropServer.port),
  }));

  ipcMain.handle("waterdrop:set-settings", async (_event, patch) => {
    const allowed = ["startOnLogin", "startMinimized", "minimizeToTray"];
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(patch || {}, key)) {
        dropServer.store.settings[key] = Boolean(patch[key]);
      }
    }
    await dropServer.store.saveSettings();
    applyLoginSettings();
    return {
      ok: true,
      settings: dropServer.store.settings,
      loginItem: app.getLoginItemSettings({ args: ["--hidden"] }),
    };
  });

  ipcMain.handle("waterdrop:choose-download-dir", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Choose download folder",
      properties: ["openDirectory", "createDirectory"],
      defaultPath: dropServer.store.settings.downloadDir || app.getPath("downloads"),
    });
    if (result.canceled || !result.filePaths[0]) {
      return { ok: false, canceled: true };
    }
    const downloadDir = await dropServer.store.setDownloadDir(result.filePaths[0]);
    return { ok: true, downloadDir };
  });

  ipcMain.handle("waterdrop:save-file", async (_event, id) => {
    try {
      const destination = await dropServer.store.copyToDownloadDir(id);
      return { ok: true, destination };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  });

  ipcMain.on("waterdrop:start-file-drag", (event, id) => {
    try {
      if (!isValidFileId(id)) return;
      const filePath = dropServer.store.prepareDragFile(id);
      event.sender.startDrag({
        file: filePath,
        files: [filePath],
        icon: dragIcon(),
      });
    } catch (err) {
      console.error("Could not start file drag", err);
    }
  });

  ipcMain.handle("waterdrop:reveal-path", async (_event, filePath) => {
    if (!filePath) return { ok: false };
    shell.showItemInFolder(filePath);
    return { ok: true };
  });

  ipcMain.handle("waterdrop:open-external", async (_event, url) => {
    if (!/^https?:\/\//.test(String(url))) return { ok: false, message: "Invalid URL" };
    await shell.openExternal(url);
    return { ok: true };
  });

  ipcMain.handle("waterdrop:copy-text", async (_event, text) => {
    clipboard.writeText(String(text || ""));
    return { ok: true };
  });

  ipcMain.handle("waterdrop:configure-serve", async () => tailscale.configureServe(dropServer.port));
}

if (gotLock) {
  app.whenReady().then(async () => {
    try {
      if (process.platform === "win32") {
        app.setAppUserModelId("dev.jubarte.waterdrop");
      }
      Menu.setApplicationMenu(null);
      await startServer();
      autoPublishServe(); // best-effort, non-blocking: makes the QR a real phone link
      applyLoginSettings();
      createTray();
      wireIpc();
      await createWindow();
      initUpdater(mainWindow);

      app.on("activate", async () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          await createWindow();
        }
      });
    } catch (err) {
      logDiagnostic("startup failed", err);
      dialog.showErrorBox(
        "Water Drop could not start",
        `${(err && err.message) || err}\n\nDetails were written to:\n${path.join(
          app.getPath("userData"),
          "waterdrop-main.log"
        )}`
      );
      app.quit();
    }
  });

  app.on("second-instance", (_event, commandLine) => {
    if (!commandLine.includes("--hidden") && !commandLine.includes("--background")) {
      showMainWindow();
    }
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", async (event) => {
  isQuitting = true;
  if (!dropServer) return;
  event.preventDefault();
  const server = dropServer;
  dropServer = null;
  await server.close();
  app.quit();
});
