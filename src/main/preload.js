"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("waterdrop", {
  appInfo: () => ipcRenderer.invoke("waterdrop:app-info"),
  setSettings: (patch) => ipcRenderer.invoke("waterdrop:set-settings", patch),
  chooseDownloadDir: () => ipcRenderer.invoke("waterdrop:choose-download-dir"),
  saveFile: (id) => ipcRenderer.invoke("waterdrop:save-file", id),
  startFileDrag: (id) => ipcRenderer.send("waterdrop:start-file-drag", id),
  revealPath: (filePath) => ipcRenderer.invoke("waterdrop:reveal-path", filePath),
  openExternal: (url) => ipcRenderer.invoke("waterdrop:open-external", url),
  copyText: (text) => ipcRenderer.invoke("waterdrop:copy-text", text),
  configureServe: () => ipcRenderer.invoke("waterdrop:configure-serve"),

  // Auto-update bridge.
  update: {
    status: () => ipcRenderer.invoke("waterdrop:update-status"),
    check: (opts) => ipcRenderer.invoke("waterdrop:update-check", opts),
    download: () => ipcRenderer.invoke("waterdrop:update-download"),
    install: () => ipcRenderer.invoke("waterdrop:update-install"),
    onStatus: (callback) => {
      const listener = (_event, status) => callback(status);
      ipcRenderer.on("waterdrop:update-status", listener);
      return () => ipcRenderer.removeListener("waterdrop:update-status", listener);
    },
  },
});
