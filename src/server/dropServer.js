"use strict";

const Busboy = require("busboy");
const QRCode = require("qrcode");
const crypto = require("crypto");
const EventEmitter = require("events");
const fs = require("fs");
const http = require("http");
const mime = require("mime-types");
const path = require("path");
const { Transform, pipeline } = require("stream");
const { promisify } = require("util");
const tailscale = require("../main/tailscale");

const streamPipeline = promisify(pipeline);
const fsp = fs.promises;
const BASE_PATH = "/drop";
const DEFAULT_PORT = 41737;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const UPLOAD_HIGH_WATER_MARK = 1024 * 1024;
const DOWNLOAD_HIGH_WATER_MARK = 8 * 1024 * 1024;
const SSE_HEARTBEAT_MS = 25 * 1000;
const DOWNLOAD_RECORD_DELAY_MS = 25;
const DOWNLOAD_METADATA_DEBOUNCE_MS = 1000;

class FileStore extends EventEmitter {
  constructor({ dataDir, defaultDownloadDir }) {
    super();
    this.dataDir = dataDir;
    this.filesDir = path.join(dataDir, "files");
    this.tmpDir = path.join(dataDir, "tmp");
    this.dragDir = path.join(dataDir, "drag");
    this.metaPath = path.join(dataDir, "files.json");
    this.settingsPath = path.join(dataDir, "settings.json");
    this.defaultDownloadDir = defaultDownloadDir;
    this.filesSaveQueue = Promise.resolve();
    this.pendingDownloadRecords = new Set();
    this.pendingDownloadSaveTimer = null;
    this.files = [];
    this.settings = {
      downloadDir: defaultDownloadDir,
      retentionDays: 7,
      startOnLogin: false,
      startMinimized: true,
      minimizeToTray: true,
      onboardingComplete: false,
    };
  }

  async init() {
    await fsp.mkdir(this.filesDir, { recursive: true });
    await fsp.mkdir(this.tmpDir, { recursive: true });
    await fsp.mkdir(this.dragDir, { recursive: true });
    await this.load();
    await this.cleanupExpired();
  }

  async load() {
    this.files = await readJson(this.metaPath, []);
    this.settings = {
      ...this.settings,
      ...(await readJson(this.settingsPath, {})),
    };
  }

  async saveFiles() {
    this.filesSaveQueue = this.filesSaveQueue
      .catch(() => {})
      .then(() => writeJsonAtomic(this.metaPath, this.files));
    await this.filesSaveQueue;
  }

  async saveSettings() {
    await writeJsonAtomic(this.settingsPath, this.settings);
  }

  async setDownloadDir(downloadDir) {
    this.settings.downloadDir = downloadDir || this.defaultDownloadDir;
    await this.saveSettings();
    return this.settings.downloadDir;
  }

  list() {
    const now = Date.now();
    return this.files
      .filter((file) => file.expiresAt > now)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((file) => toPublicFile(file));
  }

  get(id) {
    const file = this.files.find((entry) => entry.id === id);
    if (!file || file.expiresAt <= Date.now()) return null;
    return file;
  }

  async addFromTemp({ id, tempPath, originalName, mimeType, size, sha256 }) {
    const ext = safeExtension(originalName);
    const storedName = `${id}${ext}`;
    const finalPath = path.join(this.filesDir, storedName);
    await fsp.rename(tempPath, finalPath);
    const now = Date.now();
    const entry = {
      id,
      name: safeDisplayName(originalName),
      storedName,
      mimeType: mimeType || mime.lookup(originalName) || "application/octet-stream",
      size,
      sha256,
      createdAt: now,
      expiresAt: now + RETENTION_MS,
      downloads: 0,
      lastDownloadedAt: null,
    };
    this.files.push(entry);
    await this.saveFiles();
    this.notifyFilesChanged("upload");
    return toPublicFile(entry);
  }

  async recordDownload(id) {
    if (!this.applyDownloadRecord(id)) return;
    await this.saveFiles();
  }

  applyDownloadRecord(id) {
    const file = this.files.find((entry) => entry.id === id);
    if (!file) return false;
    file.downloads = Number(file.downloads || 0) + 1;
    file.lastDownloadedAt = Date.now();
    this.notifyFilesChanged("download");
    return true;
  }

  scheduleDownloadRecord(id) {
    const entry = { id, timer: null };
    entry.timer = setTimeout(() => {
      this.pendingDownloadRecords.delete(entry);
      if (this.applyDownloadRecord(id)) this.scheduleDownloadSave();
    }, DOWNLOAD_RECORD_DELAY_MS);
    entry.timer.unref();
    this.pendingDownloadRecords.add(entry);
  }

  scheduleDownloadSave() {
    if (this.pendingDownloadSaveTimer) {
      clearTimeout(this.pendingDownloadSaveTimer);
    }
    this.pendingDownloadSaveTimer = setTimeout(() => {
      this.pendingDownloadSaveTimer = null;
      this.saveFiles().catch((err) => console.error("Could not save download metadata", err));
    }, DOWNLOAD_METADATA_DEBOUNCE_MS);
    this.pendingDownloadSaveTimer.unref();
  }

  async flushPendingDownloadRecords() {
    const pending = Array.from(this.pendingDownloadRecords);
    const hadPendingSave = Boolean(this.pendingDownloadSaveTimer);
    this.pendingDownloadRecords.clear();
    if (this.pendingDownloadSaveTimer) {
      clearTimeout(this.pendingDownloadSaveTimer);
      this.pendingDownloadSaveTimer = null;
    }

    let changed = false;
    for (const entry of pending) {
      clearTimeout(entry.timer);
      changed = this.applyDownloadRecord(entry.id) || changed;
    }
    if (changed || hadPendingSave) await this.saveFiles();
  }

  async delete(id) {
    const index = this.files.findIndex((entry) => entry.id === id);
    if (index === -1) return false;
    const [file] = this.files.splice(index, 1);
    await removeIfExists(this.pathFor(file));
    await removeDirIfExists(path.join(this.dragDir, file.id));
    await this.saveFiles();
    this.notifyFilesChanged("delete");
    return true;
  }

  async clear() {
    const files = this.files;
    this.files = [];
    await Promise.all(files.map((file) => removeIfExists(this.pathFor(file))));
    await removeDirIfExists(this.dragDir);
    await fsp.mkdir(this.dragDir, { recursive: true });
    await this.saveFiles();
    if (files.length) this.notifyFilesChanged("clear");
    return files.length;
  }

  prepareDragFile(id) {
    const file = this.get(id);
    if (!file) throw new Error("File not found");

    const source = this.pathFor(file);
    const dragFileRoot = path.join(this.dragDir, file.id);
    if (!isPathInside(this.dragDir, dragFileRoot)) {
      throw new Error("Invalid drag path");
    }

    fs.mkdirSync(dragFileRoot, { recursive: true });
    const dragFileDir = fs.mkdtempSync(path.join(dragFileRoot, "drag-"));
    const destination = path.join(dragFileDir, safeDisplayName(file.name));
    if (!isPathInside(dragFileDir, destination)) {
      throw new Error("Invalid drag file name");
    }

    try {
      fs.linkSync(source, destination);
    } catch {
      fs.copyFileSync(source, destination);
    }

    return destination;
  }

  async copyToDownloadDir(id, targetDir) {
    const file = this.get(id);
    if (!file) throw new Error("File not found");
    const destinationDir = targetDir || this.settings.downloadDir || this.defaultDownloadDir;
    await fsp.mkdir(destinationDir, { recursive: true });
    const destination = await uniqueDestination(destinationDir, file.name);
    await fsp.copyFile(this.pathFor(file), destination);
    return destination;
  }

  async cleanupExpired() {
    const now = Date.now();
    const expired = this.files.filter((file) => file.expiresAt <= now);
    if (!expired.length) return 0;
    this.files = this.files.filter((file) => file.expiresAt > now);
    await Promise.all(
      expired.flatMap((file) => [
        removeIfExists(this.pathFor(file)),
        removeDirIfExists(path.join(this.dragDir, file.id)),
      ])
    );
    await this.saveFiles();
    this.notifyFilesChanged("expire");
    return expired.length;
  }

  pathFor(file) {
    return path.join(this.filesDir, file.storedName);
  }

  notifyFilesChanged(reason) {
    this.emit("files-changed", { reason, at: Date.now() });
  }
}

async function createDropServer({ dataDir, defaultDownloadDir, rendererDir, port = DEFAULT_PORT }) {
  const store = new FileStore({ dataDir, defaultDownloadDir });
  await store.init();
  const eventClients = new Set();

  const server = http.createServer((req, res) => {
    handleRequest({ req, res, store, rendererDir, getPort: () => actualPort, eventClients }).catch((err) => {
      if (err?.code === "UPLOAD_ABORTED") return;
      console.error(err);
      sendJson(res, 500, { error: "Internal server error" });
    });
  });

  let actualPort = await listenWithFallback(server, port);
  const cleanupTimer = setInterval(() => {
    store.cleanupExpired().catch((err) => console.error("Cleanup failed", err));
  }, 60 * 60 * 1000);
  cleanupTimer.unref();

  return {
    port: actualPort,
    basePath: BASE_PATH,
    localUrl: `http://127.0.0.1:${actualPort}${BASE_PATH}/`,
    store,
    async close() {
      clearInterval(cleanupTimer);
      for (const client of eventClients) client.end();
      await new Promise((resolve) => server.close(resolve));
      await store.flushPendingDownloadRecords();
    },
  };
}

async function handleRequest({ req, res, store, rendererDir, getPort, eventClients }) {
  if (!isAllowedRemote(req.socket.remoteAddress)) {
    sendJson(res, 403, { error: "WaterDrop only accepts loopback or Tailscale clients." });
    return;
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || "waterdrop.local"}`);
  const pathname = url.pathname;

  if (pathname === BASE_PATH) {
    redirect(res, `${BASE_PATH}/`);
    return;
  }

  if (pathname.startsWith("/api/")) {
    await handleApi({ req, res, url, relative: pathname, store, getPort, eventClients });
    return;
  }

  if (pathname.startsWith(`${BASE_PATH}/`)) {
    const relative = pathname.slice(BASE_PATH.length);
    if (relative.startsWith("/api/")) {
      await handleApi({ req, res, url, relative, store, getPort, eventClients });
      return;
    }
    await serveStatic({ req, res, pathname: relative, rendererDir });
    return;
  }

  if (pathname === "/" || pathname === "/index.html" || pathname === "/icon.ico" || pathname.startsWith("/assets/")) {
    await serveStatic({ req, res, pathname, rendererDir });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

async function handleApi({ req, res, relative, store, getPort, eventClients }) {
  if (relative.startsWith(BASE_PATH + "/api/")) {
    relative = relative.slice(BASE_PATH.length);
  }

  if (req.method === "GET" && relative === "/api/info") {
    const network = await tailscale.inspect(getPort());
    const qrSvg = await QRCode.toString(network.preferredUrl, {
      type: "svg",
      margin: 1,
      color: { dark: "#08080a", light: "#ffffff" },
    });
    sendJson(res, 200, {
      name: "WaterDrop",
      basePath: BASE_PATH,
      retentionDays: 7,
      network,
      qrSvg,
    });
    return;
  }

  if (req.method === "POST" && relative === "/api/tailscale/serve") {
    const result = await tailscale.configureServe(getPort());
    sendJson(res, result.ok ? 200 : 500, result);
    return;
  }

  if (req.method === "GET" && relative === "/api/files") {
    await store.cleanupExpired();
    sendJson(res, 200, { files: store.list(), settings: store.settings });
    return;
  }

  if (req.method === "GET" && relative === "/api/events") {
    handleEvents(req, res, store, eventClients);
    return;
  }

  if (req.method === "POST" && relative === "/api/files") {
    await handleUpload(req, res, store);
    return;
  }

  if (req.method === "POST" && relative === "/api/files/raw") {
    await handleRawUpload(req, res, store);
    return;
  }

  if (req.method === "DELETE" && relative === "/api/files") {
    const deleted = await store.clear();
    sendJson(res, 200, { ok: true, deleted });
    return;
  }

  const fileMatch = relative.match(/^\/api\/files\/([a-f0-9-]+)(?:\/(download|preview))?$/);
  if (fileMatch) {
    const id = fileMatch[1];
    const action = fileMatch[2];
    if ((req.method === "GET" || req.method === "HEAD") && action === "download") {
      await handleDownload(req, res, store, id);
      return;
    }
    if ((req.method === "GET" || req.method === "HEAD") && action === "preview") {
      await handlePreview(req, res, store, id);
      return;
    }
    if (req.method === "DELETE" && !action) {
      const deleted = await store.delete(id);
      sendJson(res, deleted ? 200 : 404, { ok: deleted });
      return;
    }
  }

  sendJson(res, 404, { error: "API route not found" });
}

async function handleRawUpload(req, res, store) {
  const originalName = decodeHeaderValue(req.headers["x-waterdrop-file-name"]) || "unnamed-file";
  const mimeType = cleanHeaderValue(req.headers["x-waterdrop-mime-type"]) || cleanMimeType(req.headers["content-type"]);
  const id = crypto.randomUUID();
  const tempPath = path.join(store.tmpDir, `${id}.upload`);
  const hash = crypto.createHash("sha256");
  let size = 0;

  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  try {
    await streamPipeline(
      req,
      meter,
      fs.createWriteStream(tempPath, { highWaterMark: UPLOAD_HIGH_WATER_MARK })
    );
    const file = await store.addFromTemp({
      id,
      tempPath,
      originalName,
      mimeType,
      size,
      sha256: hash.digest("hex"),
    });
    sendJson(res, 201, { files: [file] });
  } catch (err) {
    await removeIfExists(tempPath);
    if (req.aborted) {
      err.code = "UPLOAD_ABORTED";
      throw err;
    }
    sendJson(res, 500, { error: `Upload failed: ${err.message}` });
  }
}

async function handleUpload(req, res, store) {
  const contentType = req.headers["content-type"] || "";
  if (!contentType.includes("multipart/form-data")) {
    sendJson(res, 415, { error: "Expected multipart/form-data" });
    return;
  }

  const busboy = Busboy({
    headers: req.headers,
    highWaterMark: UPLOAD_HIGH_WATER_MARK,
    fileHwm: UPLOAD_HIGH_WATER_MARK,
    limits: { files: 128 },
  });
  const uploadPromises = [];
  const tempPaths = [];

  busboy.on("file", (_fieldName, fileStream, info) => {
    const originalName = info.filename || "unnamed-file";
    const id = crypto.randomUUID();
    const tempPath = path.join(store.tmpDir, `${id}.upload`);
    tempPaths.push(tempPath);
    const hash = crypto.createHash("sha256");
    let size = 0;

    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length;
        hash.update(chunk);
        callback(null, chunk);
      },
    });

    const promise = streamPipeline(
      fileStream,
      meter,
      fs.createWriteStream(tempPath, { highWaterMark: UPLOAD_HIGH_WATER_MARK })
    ).then(() =>
      store.addFromTemp({
        id,
        tempPath,
        originalName,
        mimeType: info.mimeType,
        size,
        sha256: hash.digest("hex"),
      })
    );

    uploadPromises.push(promise);
  });

  let aborted = false;
  busboy.on("error", (err) => {
    if (!aborted) console.error("Upload parser failed", err);
  });

  req.pipe(busboy);

  try {
    await new Promise((resolve, reject) => {
      req.on("aborted", () => {
        aborted = true;
        const err = new Error("Upload aborted");
        err.code = "UPLOAD_ABORTED";
        reject(err);
      });
      busboy.on("finish", resolve);
      busboy.on("error", reject);
    });
  } catch (err) {
    if (err.code === "UPLOAD_ABORTED") {
      await Promise.allSettled(uploadPromises);
      await Promise.allSettled(tempPaths.map((tempPath) => removeIfExists(tempPath)));
      throw err;
    }
    throw err;
  }

  try {
    const files = await Promise.all(uploadPromises);
    sendJson(res, 201, { files });
  } catch (err) {
    await Promise.allSettled(tempPaths.map((tempPath) => removeIfExists(tempPath)));
    sendJson(res, 500, { error: `Upload failed: ${err.message}` });
  }
}

async function handleDownload(req, res, store, id) {
  await sendStoredFile({
    req,
    res,
    store,
    id,
    disposition: "attachment",
    cacheControl: "private, max-age=0, no-transform",
    recordDownload: true,
  });
}

async function handlePreview(req, res, store, id) {
  await sendStoredFile({
    req,
    res,
    store,
    id,
    disposition: "inline",
    cacheControl: "private, max-age=60, no-transform",
    recordDownload: false,
  });
}

async function sendStoredFile({ req, res, store, id, disposition, cacheControl, recordDownload }) {
  const file = store.get(id);
  if (!file) {
    sendJson(res, 404, { error: "File not found" });
    return;
  }

  const filePath = store.pathFor(file);
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    sendJson(res, 404, { error: "File payload is missing" });
    return;
  }

  const range = parseRange(req.headers.range, stat.size);
  const encodedName = encodeRFC5987(file.name);
  const commonHeaders = {
    ...corsHeaders(),
    "Accept-Ranges": "bytes",
    "Cache-Control": cacheControl,
    "Content-Disposition": `${disposition}; filename="${asciiFileName(file.name)}"; filename*=UTF-8''${encodedName}`,
    "Content-Type": file.mimeType || "application/octet-stream",
    "ETag": `"sha256-${file.sha256}"`,
    "Last-Modified": new Date(file.createdAt).toUTCString(),
    "X-Content-Type-Options": "nosniff",
    "X-WaterDrop-SHA256": file.sha256,
  };

  if (range && range.invalid) {
    res.writeHead(416, { ...commonHeaders, "Content-Range": `bytes */${stat.size}` });
    res.end();
    return;
  }

  if (recordDownload && req.method !== "HEAD") recordDownloadAfterResponse(res, store, id);

  if (range) {
    res.writeHead(206, {
      ...commonHeaders,
      "Content-Length": range.end - range.start + 1,
      "Content-Range": `bytes ${range.start}-${range.end}/${stat.size}`,
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    pipeFileToResponse(res, filePath, {
      start: range.start,
      end: range.end,
      highWaterMark: Math.min(DOWNLOAD_HIGH_WATER_MARK, range.end - range.start + 1),
    });
    return;
  }

  res.writeHead(200, {
    ...commonHeaders,
    "Content-Length": stat.size,
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  pipeFileToResponse(res, filePath, { highWaterMark: DOWNLOAD_HIGH_WATER_MARK });
}

function pipeFileToResponse(res, filePath, options) {
  const fileStream = fs.createReadStream(filePath, options);
  fileStream.on("error", (err) => {
    if (!res.destroyed) res.destroy(err);
  });
  res.on("close", () => fileStream.destroy());
  fileStream.pipe(res);
}

function recordDownloadAfterResponse(res, store, id) {
  res.once("finish", () => {
    store.scheduleDownloadRecord(id);
  });
}

async function serveStatic({ req, res, pathname, rendererDir }) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  let relPath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  if (relPath.includes("..")) {
    sendJson(res, 400, { error: "Bad static path" });
    return;
  }

  let filePath = path.join(rendererDir, relPath);
  if (!isPathInside(rendererDir, filePath)) {
    sendJson(res, 400, { error: "Bad static path" });
    return;
  }

  try {
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) filePath = path.join(filePath, "index.html");
  } catch {
    filePath = path.join(rendererDir, "index.html");
  }

  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    sendJson(res, 503, { error: "Renderer has not been built yet. Run npm run build." });
    return;
  }

  res.writeHead(200, {
    ...corsHeaders(),
    "Cache-Control": filePath.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable",
    "Content-Length": stat.size,
    "Content-Type": mime.lookup(filePath) || "application/octet-stream",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  pipeFileToResponse(res, filePath, { highWaterMark: DOWNLOAD_HIGH_WATER_MARK });
}

function handleEvents(req, res, store, eventClients) {
  res.writeHead(200, {
    ...corsHeaders(),
    "Cache-Control": "no-store, no-transform",
    "Connection": "keep-alive",
    "Content-Type": "text/event-stream; charset=utf-8",
    "X-Accel-Buffering": "no",
  });
  eventClients.add(res);
  res.write(": connected\n\n");

  const sendChange = (event) => writeSse(res, "files", event);
  const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), SSE_HEARTBEAT_MS);
  heartbeat.unref();
  store.on("files-changed", sendChange);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    eventClients.delete(res);
    store.off("files-changed", sendChange);
  };
  req.on("close", close);
  res.on("close", close);
}

function writeSse(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function parseRange(header, size) {
  if (!header) return null;
  const match = String(header).match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return { invalid: true };
  let start = match[1] === "" ? null : Number(match[1]);
  let end = match[2] === "" ? null : Number(match[2]);

  if (start === null && end === null) return { invalid: true };
  if (start === null) {
    const suffix = end;
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else if (end === null || end >= size) {
    end = size - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start < 0 || start >= size) {
    return { invalid: true };
  }
  return { start, end };
}

async function listenWithFallback(server, preferredPort) {
  for (let offset = 0; offset < 30; offset += 1) {
    const port = preferredPort + offset;
    try {
      await new Promise((resolve, reject) => {
        const onError = (err) => {
          server.off("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, "0.0.0.0");
      });
      return port;
    } catch (err) {
      if (err.code !== "EADDRINUSE") throw err;
    }
  }
  throw new Error("Could not find an open port for WaterDrop.");
}

function isAllowedRemote(remoteAddress) {
  const ip = normalizeAddress(remoteAddress);
  if (!ip) return false;
  if (ip === "127.0.0.1" || ip === "::1" || ip === "localhost") return true;
  if (ip.startsWith("127.")) return true;
  if (isTailscaleIpv4(ip)) return true;
  if (ip.toLowerCase().startsWith("fd7a:115c:a1e0:")) return true;
  return false;
}

function normalizeAddress(remoteAddress) {
  if (!remoteAddress) return "";
  if (remoteAddress.startsWith("::ffff:")) return remoteAddress.slice(7);
  return remoteAddress;
}

function isTailscaleIpv4(ip) {
  const parts = ip.split(".").map(Number);
  return parts.length === 4 && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

function toPublicFile(file) {
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    size: file.size,
    sha256: file.sha256,
    createdAt: file.createdAt,
    expiresAt: file.expiresAt,
    expiresInMs: Math.max(0, file.expiresAt - Date.now()),
    downloads: file.downloads || 0,
    lastDownloadedAt: file.lastDownloadedAt || null,
  };
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    ...corsHeaders(),
    "Cache-Control": "no-store",
    "Content-Length": body.length,
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(body);
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Headers": "Content-Type, Range, X-WaterDrop-File-Name, X-WaterDrop-Mime-Type",
    "Access-Control-Allow-Methods": "GET, HEAD, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "Accept-Ranges, Content-Disposition, Content-Length, Content-Range, ETag, Last-Modified, X-WaterDrop-SHA256",
  };
}

function redirect(res, location) {
  res.writeHead(308, { Location: location });
  res.end();
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(filePath, value) {
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`);
  await fsp.rename(tmpPath, filePath);
}

async function removeIfExists(filePath) {
  try {
    await fsp.unlink(filePath);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

async function removeDirIfExists(dirPath) {
  await fsp.rm(dirPath, { recursive: true, force: true });
}

function safeDisplayName(name) {
  const base = path.basename(String(name || "unnamed-file")).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
  return base || "unnamed-file";
}

function safeExtension(name) {
  const ext = path.extname(safeDisplayName(name)).slice(0, 24);
  return ext.replace(/[^a-zA-Z0-9.]/g, "");
}

function asciiFileName(name) {
  return safeDisplayName(name).replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");
}

function encodeRFC5987(value) {
  return encodeURIComponent(value).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16)}`);
}

function decodeHeaderValue(value) {
  const raw = cleanHeaderValue(value);
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function cleanHeaderValue(value) {
  if (Array.isArray(value)) value = value[0];
  return String(value || "").replace(/[\r\n]/g, "").trim();
}

function cleanMimeType(value) {
  return cleanHeaderValue(value).split(";")[0].trim();
}

async function uniqueDestination(directory, fileName) {
  const safeName = safeDisplayName(fileName);
  const parsed = path.parse(safeName);
  for (let i = 0; i < 1000; i += 1) {
    const candidate =
      i === 0
        ? path.join(directory, safeName)
        : path.join(directory, `${parsed.name} (${i})${parsed.ext}`);
    try {
      await fsp.access(candidate);
    } catch {
      return candidate;
    }
  }
  throw new Error("Could not find a free destination file name");
}

function isPathInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

module.exports = {
  BASE_PATH,
  DEFAULT_PORT,
  FileStore,
  createDropServer,
};
