"use strict";

const Busboy = require("busboy");
const QRCode = require("qrcode");
const crypto = require("crypto");
const EventEmitter = require("events");
const fs = require("fs");
const http = require("http");
const https = require("https");
const mime = require("mime-types");
const path = require("path");
const { Transform, pipeline } = require("stream");
const { promisify } = require("util");
const tailscale = require("../main/tailscale");

const streamPipeline = promisify(pipeline);
const fsp = fs.promises;
const BASE_PATH = "/drop";
const DEFAULT_PORT = 41737;
// A second, direct HTTPS listener (HTTP/1.1) served with a Tailscale-issued cert.
// It lets phones open several parallel connections straight to this process for
// full-speed transfers, skipping the Tailscale Serve proxy, while staying a
// secure context. TLS uses AES-NI, so it's cheap — and Serve already did TLS.
const DEFAULT_HTTPS_PORT = 41843;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const UPLOAD_HIGH_WATER_MARK = 4 * 1024 * 1024;
const DOWNLOAD_HIGH_WATER_MARK = 8 * 1024 * 1024;
const SSE_HEARTBEAT_MS = 25 * 1000;
const DOWNLOAD_RECORD_DELAY_MS = 25;
const DOWNLOAD_METADATA_DEBOUNCE_MS = 1000;
// Backstop so a dropped connection mid-upload can't leave a shimmer placeholder
// stuck on every device forever.
const PENDING_UPLOAD_TIMEOUT_MS = 60 * 60 * 1000;
// A stalled chunked-upload assembly (some chunks never arrive) is torn down after
// this long so its temp file and placeholder don't linger.
const UPLOAD_SESSION_TIMEOUT_MS = 60 * 60 * 1000;

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
    // In-flight uploads, keyed by the id the finished file will receive, so every
    // connected device can show a live "loading" placeholder while bytes arrive.
    this.pendingUploads = new Map();
    // In-flight chunked uploads (parallel multi-connection transfers), keyed by
    // the same id. Each session assembles positioned chunk writes into one temp
    // file, then hashes + commits it exactly like a single-shot upload.
    this.uploadSessions = new Map();
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
      .filter((file) => !file.folderId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((file) => toPublicFile(file, this));
  }

  addPendingUpload({ id, name, size }) {
    this.clearPendingUpload(id);
    const entry = {
      id,
      name: safeDisplayName(name),
      size: Number(size) > 0 ? Number(size) : 0,
      createdAt: Date.now(),
      timer: null,
    };
    entry.timer = setTimeout(() => this.removePendingUpload(id, "upload-timeout"), PENDING_UPLOAD_TIMEOUT_MS);
    entry.timer.unref?.();
    this.pendingUploads.set(id, entry);
    this.notifyFilesChanged("upload-start");
    return entry;
  }

  clearPendingUpload(id) {
    const entry = this.pendingUploads.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pendingUploads.delete(id);
    return true;
  }

  removePendingUpload(id, reason = "upload-cancelled") {
    if (!this.clearPendingUpload(id)) return false;
    this.notifyFilesChanged(reason);
    return true;
  }

  listPendingUploads() {
    return Array.from(this.pendingUploads.values())
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        size: entry.size,
        createdAt: entry.createdAt,
        pending: true,
      }));
  }

  get(id) {
    const file = this.files.find((entry) => entry.id === id);
    if (!file || file.expiresAt <= Date.now()) return null;
    return file;
  }

  getFolder(id) {
    const folder = this.get(id);
    if (!folder || folder.kind !== "folder") return null;
    return folder;
  }

  getFolderChildren(folderId) {
    const now = Date.now();
    return this.files
      .filter((entry) => entry.folderId === folderId && entry.expiresAt > now)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async createFolder({ name } = {}) {
    const now = Date.now();
    const entry = {
      id: crypto.randomUUID(),
      kind: "folder",
      name: safeDisplayName(name || this.nextFolderName()),
      size: 0,
      createdAt: now,
      expiresAt: now + RETENTION_MS,
      downloads: 0,
      lastDownloadedAt: null,
    };
    this.files.push(entry);
    await this.saveFiles();
    this.notifyFilesChanged("folder-create");
    return toPublicFile(entry, this);
  }

  async renameFolder(id, name) {
    const folder = this.getFolder(id);
    if (!folder) return null;
    folder.name = safeDisplayName(name || folder.name);
    await this.saveFiles();
    this.notifyFilesChanged("folder-rename");
    return toPublicFile(folder, this);
  }

  nextFolderName() {
    const used = new Set(
      this.files
        .filter((entry) => entry.kind === "folder" && entry.expiresAt > Date.now())
        .map((entry) => String(entry.name || "").toLowerCase())
    );
    for (let i = 1; i < 1000; i += 1) {
      const name = `Folder${i}`;
      if (!used.has(name.toLowerCase())) return name;
    }
    return `Folder${Date.now()}`;
  }

  async addFromTemp({ id, tempPath, originalName, mimeType, size, sha256, folderId }) {
    const folder = folderId ? this.getFolder(folderId) : null;
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
      expiresAt: folder ? folder.expiresAt : now + RETENTION_MS,
      downloads: 0,
      lastDownloadedAt: null,
    };
    if (folder) entry.folderId = folder.id;
    this.files.push(entry);
    // The finished file carries the same id as its placeholder, so the single
    // "upload" broadcast swaps shimmer for the real card everywhere at once.
    this.clearPendingUpload(id);
    await this.saveFiles();
    this.notifyFilesChanged("upload");
    return toPublicFile(entry, this);
  }

  // --- Chunked (parallel) upload assembly ---------------------------------
  // A large file is uploaded as many chunks over separate connections at once.
  // Each chunk is written straight to its byte offset in a preallocated temp
  // file, so the reassembled bytes are identical to the original — the finished
  // file is hashed and committed through the very same addFromTemp path.

  getOrCreateUploadSession({ id, name, totalSize, mimeType, folderId }) {
    let session = this.uploadSessions.get(id);
    if (session) return session;
    const tempPath = path.join(this.tmpDir, `${id}.chunked.upload`);
    session = {
      id,
      name: safeDisplayName(name),
      mimeType,
      folderId: folderId || "",
      totalSize,
      tempPath,
      received: new Map(), // offset -> bytes, so retried chunks aren't double-counted
      receivedBytes: 0,
      finalizing: false,
      timer: null,
      // Preallocate the file up front so every parallel chunk can open its own
      // positioned write stream without racing to create it.
      ready: (async () => {
        const handle = await fsp.open(tempPath, "w");
        try {
          if (totalSize > 0) await handle.truncate(totalSize);
        } finally {
          await handle.close();
        }
      })(),
    };
    session.timer = setTimeout(() => {
      this.abortUploadSession(id, "upload-timeout").catch(() => {});
    }, UPLOAD_SESSION_TIMEOUT_MS);
    session.timer.unref?.();
    this.uploadSessions.set(id, session);
    // Same shimmer placeholder a single-shot upload shows.
    this.addPendingUpload({ id, name, size: totalSize });
    return session;
  }

  async writeUploadChunk({ id, name, mimeType, folderId, totalSize, offset, length, req }) {
    const session = this.getOrCreateUploadSession({ id, name, totalSize, mimeType, folderId });
    await session.ready;
    const written = await writeRequestAtOffset(session.tempPath, offset, req);
    if (written !== length) {
      throw new Error(`Chunk length mismatch (expected ${length}, wrote ${written})`);
    }
    if (!session.received.has(offset)) {
      session.received.set(offset, written);
      session.receivedBytes += written;
    }
    return session;
  }

  async finalizeUploadSession({ id, originalName, mimeType }) {
    const session = this.uploadSessions.get(id);
    if (!session) return null;
    clearTimeout(session.timer);
    this.uploadSessions.delete(id);
    const sha256 = await hashFile(session.tempPath);
    return this.addFromTemp({
      id,
      tempPath: session.tempPath,
      originalName: originalName || session.name,
      mimeType: mimeType || session.mimeType,
      size: session.totalSize,
      sha256,
      folderId: session.folderId,
    });
  }

  async abortUploadSession(id, reason = "upload-cancelled") {
    const session = this.uploadSessions.get(id);
    if (!session) return false;
    clearTimeout(session.timer);
    this.uploadSessions.delete(id);
    try {
      await session.ready;
    } catch {}
    await removeIfExists(session.tempPath);
    this.removePendingUpload(id, reason);
    return true;
  }

  async abortAllUploadSessions(reason = "shutdown") {
    const ids = Array.from(this.uploadSessions.keys());
    await Promise.allSettled(ids.map((id) => this.abortUploadSession(id, reason)));
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
    const payloads = file.kind === "folder" ? this.files.filter((entry) => entry.folderId === file.id) : [file];
    if (file.kind === "folder") {
      this.files = this.files.filter((entry) => entry.folderId !== file.id);
    }
    await Promise.all(
      payloads.flatMap((entry) => [
        removeIfExists(this.pathFor(entry)),
        removeDirIfExists(path.join(this.dragDir, entry.id)),
      ])
    );
    await removeDirIfExists(path.join(this.dragDir, file.id));
    await this.saveFiles();
    this.notifyFilesChanged("delete");
    return true;
  }

  async clear() {
    const files = this.files;
    this.files = [];
    await Promise.all(files.filter((file) => file.kind !== "folder").map((file) => removeIfExists(this.pathFor(file))));
    await removeDirIfExists(this.dragDir);
    await fsp.mkdir(this.dragDir, { recursive: true });
    await this.saveFiles();
    if (files.length) this.notifyFilesChanged("clear");
    return files.filter((file) => !file.folderId).length;
  }

  prepareDragFile(id) {
    const file = this.get(id);
    if (!file) throw new Error("File not found");
    if (file.kind === "folder") throw new Error("Drag folders from the saved ZIP.");

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
    const destinationName = file.kind === "folder" ? ensureZipName(file.name) : file.name;
    const destination = await uniqueDestination(destinationDir, destinationName);
    if (file.kind === "folder") {
      await writeFolderZipToPath(this, file, destination);
    } else {
      await fsp.copyFile(this.pathFor(file), destination);
    }
    return destination;
  }

  async cleanupExpired() {
    const now = Date.now();
    const expiredFolderIds = new Set(
      this.files.filter((file) => file.kind === "folder" && file.expiresAt <= now).map((file) => file.id)
    );
    const expired = this.files.filter((file) => file.expiresAt <= now || expiredFolderIds.has(file.folderId));
    if (!expired.length) return 0;
    const expiredIds = new Set(expired.map((file) => file.id));
    this.files = this.files.filter((file) => !expiredIds.has(file.id));
    await Promise.all(
      expired.flatMap((file) => {
        const tasks = [removeDirIfExists(path.join(this.dragDir, file.id))];
        if (file.kind !== "folder") tasks.push(removeIfExists(this.pathFor(file)));
        return tasks;
      })
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

  let actualPort;
  let actualHttpsPort = null;
  let httpsServer = null;

  const requestListener = (req, res) => {
    handleRequest({
      req,
      res,
      store,
      rendererDir,
      getPort: () => actualPort,
      getHttpsPort: () => actualHttpsPort,
      eventClients,
    }).catch((err) => {
      if (err?.code === "UPLOAD_ABORTED") return;
      console.error(err);
      sendJson(res, 500, { error: "Internal server error" });
    });
  };

  const server = http.createServer(requestListener);

  // Disable Nagle so the many small round-trips of parallel range/chunk transfers
  // aren't delayed by TCP coalescing.
  server.on("connection", (socket) => socket.setNoDelay(true));
  // Big transfers can legitimately hold a single request open for a long time on
  // a slow link; the client's own stall detection handles truly dead uploads.
  server.requestTimeout = 0;

  actualPort = await listenWithFallback(server, port);
  const cleanupTimer = setInterval(() => {
    store.cleanupExpired().catch((err) => console.error("Cleanup failed", err));
  }, 60 * 60 * 1000);
  cleanupTimer.unref();

  // Bring up (or hot-swap the cert of) the direct HTTPS listener. Plain HTTP/1.1
  // over TLS — deliberately not HTTP/2 — so browsers open several parallel
  // connections and the chunked transfers actually run in parallel.
  async function startHttps({ cert, key, preferredPort = DEFAULT_HTTPS_PORT }) {
    if (!cert || !key) throw new Error("HTTPS needs a cert and key");
    if (httpsServer) {
      httpsServer.setSecureContext({ cert, key });
      return actualHttpsPort;
    }
    const secure = https.createServer({ cert, key }, requestListener);
    secure.on("secureConnection", (socket) => socket.setNoDelay(true));
    secure.requestTimeout = 0;
    actualHttpsPort = await listenWithFallback(secure, preferredPort);
    httpsServer = secure;
    return actualHttpsPort;
  }

  return {
    port: actualPort,
    basePath: BASE_PATH,
    localUrl: `http://127.0.0.1:${actualPort}${BASE_PATH}/`,
    store,
    startHttps,
    getHttpsPort: () => actualHttpsPort,
    async close() {
      clearInterval(cleanupTimer);
      for (const client of eventClients) client.end();
      await store.abortAllUploadSessions("shutdown");
      const closers = [new Promise((resolve) => server.close(resolve))];
      server.closeIdleConnections?.();
      if (httpsServer) {
        closers.push(new Promise((resolve) => httpsServer.close(resolve)));
        httpsServer.closeIdleConnections?.();
      }
      // Don't wait out keep-alive timeouts on idle sockets; active transfers
      // still get to finish.
      await Promise.all(closers);
      await store.flushPendingDownloadRecords();
    },
  };
}

async function handleRequest({ req, res, store, rendererDir, getPort, getHttpsPort, eventClients }) {
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
    await handleApi({ req, res, url, relative: pathname, store, getPort, getHttpsPort, eventClients });
    return;
  }

  if (pathname.startsWith(`${BASE_PATH}/`)) {
    const relative = pathname.slice(BASE_PATH.length);
    if (relative.startsWith("/api/")) {
      await handleApi({ req, res, url, relative, store, getPort, getHttpsPort, eventClients });
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

async function handleApi({ req, res, relative, store, getPort, getHttpsPort, eventClients }) {
  if (relative.startsWith(BASE_PATH + "/api/")) {
    relative = relative.slice(BASE_PATH.length);
  }

  if (req.method === "GET" && relative === "/api/info") {
    const network = await tailscale.inspect(getPort(), { httpsPort: getHttpsPort?.() });
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
    sendJson(res, 200, { files: store.list(), pending: store.listPendingUploads(), settings: store.settings });
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

  if (req.method === "POST" && relative === "/api/folders") {
    const body = await readRequestJson(req);
    const folder = await store.createFolder({ name: body.name });
    sendJson(res, 201, { folder });
    return;
  }

  if (req.method === "DELETE" && relative === "/api/files") {
    const deleted = await store.clear();
    sendJson(res, 200, { ok: true, deleted });
    return;
  }

  const folderMatch = relative.match(/^\/api\/folders\/([a-f0-9-]+)$/);
  if (folderMatch) {
    const id = folderMatch[1];
    if (req.method === "PATCH") {
      const body = await readRequestJson(req);
      const folder = await store.renameFolder(id, body.name);
      sendJson(res, folder ? 200 : 404, folder ? { folder } : { error: "Folder not found" });
      return;
    }
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
  const requestedId = cleanHeaderValue(req.headers["x-waterdrop-upload-id"]);
  const requestedFolderId = cleanHeaderValue(req.headers["x-waterdrop-folder-id"]);
  const folderId = isValidFileId(requestedFolderId) ? requestedFolderId : "";
  if (folderId && !store.getFolder(folderId)) {
    req.resume();
    sendJson(res, 404, { error: "Folder not found" });
    return;
  }
  const id = isValidFileId(requestedId) ? requestedId : crypto.randomUUID();
  const existingFile = store.get(id);
  if (existingFile) {
    req.resume();
    sendJson(res, 200, { files: [toPublicFile(existingFile, store)], duplicate: true });
    return;
  }

  // Parallel multi-connection upload: each request carries one byte-range chunk.
  // The whole-file path below stays the fallback for small files and clients that
  // don't chunk.
  const chunkOffsetHeader = cleanHeaderValue(req.headers["x-waterdrop-chunk-offset"]);
  const totalSizeHeader = cleanHeaderValue(req.headers["x-waterdrop-total-size"]);
  if (chunkOffsetHeader !== "" && totalSizeHeader !== "") {
    await handleChunkUpload(req, res, store, {
      id,
      originalName,
      mimeType,
      folderId,
      chunkOffsetHeader,
      totalSizeHeader,
    });
    return;
  }

  const tempPath = path.join(store.tmpDir, `${id}.${crypto.randomUUID()}.upload`);
  const hash = crypto.createHash("sha256");
  let size = 0;

  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  // Announce the upload before streaming so every device shows a placeholder
  // while the bytes are still in flight.
  store.addPendingUpload({ id, name: originalName, size: req.headers["content-length"] });

  try {
    await streamPipeline(
      req,
      meter,
      fs.createWriteStream(tempPath, { highWaterMark: UPLOAD_HIGH_WATER_MARK })
    );
    const finishedElsewhere = store.get(id);
    if (finishedElsewhere) {
      await removeIfExists(tempPath);
      sendJson(res, 200, { files: [toPublicFile(finishedElsewhere, store)], duplicate: true });
      return;
    }
    const file = await store.addFromTemp({
      id,
      tempPath,
      originalName,
      mimeType,
      size,
      sha256: hash.digest("hex"),
      folderId,
    });
    sendJson(res, 201, { files: [file] });
  } catch (err) {
    store.removePendingUpload(id, "upload-failed");
    await removeIfExists(tempPath);
    if (req.aborted) {
      err.code = "UPLOAD_ABORTED";
      throw err;
    }
    sendJson(res, 500, { error: `Upload failed: ${err.message}` });
  }
}

async function handleChunkUpload(req, res, store, { id, originalName, mimeType, folderId, chunkOffsetHeader, totalSizeHeader }) {
  const offset = Number(chunkOffsetHeader);
  const totalSize = Number(totalSizeHeader);
  const length = Number(cleanHeaderValue(req.headers["content-length"]));
  if (
    !Number.isInteger(offset) || offset < 0 ||
    !Number.isInteger(totalSize) || totalSize <= 0 ||
    !Number.isInteger(length) || length <= 0 ||
    offset + length > totalSize
  ) {
    req.resume();
    sendJson(res, 400, { error: "Invalid upload chunk" });
    return;
  }

  try {
    const session = await store.writeUploadChunk({
      id,
      name: originalName,
      mimeType,
      folderId,
      totalSize,
      offset,
      length,
      req,
    });

    // The chunk whose write completes the file finalizes it. JS is single
    // threaded, so exactly one chunk sees the byte count reach the total with
    // finalizing still false.
    if (session.receivedBytes >= session.totalSize && !session.finalizing) {
      session.finalizing = true;
      try {
        const file = await store.finalizeUploadSession({ id, originalName, mimeType });
        sendJson(res, 201, { files: [file] });
      } catch (err) {
        session.finalizing = false;
        await store.abortUploadSession(id, "upload-failed");
        sendJson(res, 500, { error: `Upload failed: ${err.message}` });
      }
      return;
    }

    sendJson(res, 200, { ok: true, received: session.receivedBytes, total: session.totalSize });
  } catch (err) {
    if (req.aborted) {
      err.code = "UPLOAD_ABORTED";
      throw err;
    }
    // One failed chunk doesn't kill the file — the client just retries it.
    sendJson(res, 500, { error: `Chunk failed: ${err.message}` });
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
  const pendingIds = [];

  busboy.on("file", (_fieldName, fileStream, info) => {
    const originalName = info.filename || "unnamed-file";
    const id = crypto.randomUUID();
    const tempPath = path.join(store.tmpDir, `${id}.upload`);
    tempPaths.push(tempPath);
    pendingIds.push(id);
    // Per-file size isn't known upfront in multipart, so the placeholder shows
    // the name and a shimmer until the real file lands.
    store.addPendingUpload({ id, name: originalName, size: 0 });
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
      pendingIds.forEach((id) => store.removePendingUpload(id, "upload-failed"));
      throw err;
    }
    throw err;
  }

  try {
    const files = await Promise.all(uploadPromises);
    sendJson(res, 201, { files });
  } catch (err) {
    await Promise.allSettled(tempPaths.map((tempPath) => removeIfExists(tempPath)));
    pendingIds.forEach((id) => store.removePendingUpload(id, "upload-failed"));
    sendJson(res, 500, { error: `Upload failed: ${err.message}` });
  }
}

async function handleDownload(req, res, store, id) {
  const file = store.get(id);
  if (file?.kind === "folder") {
    await sendFolderZip({ req, res, store, folder: file });
    return;
  }
  // An accelerated download issues many parallel range requests for one file;
  // it tags every request but the first with X-WaterDrop-No-Count so the file
  // still registers as a single logical download.
  const noCount = cleanHeaderValue(req.headers["x-waterdrop-no-count"]);
  await sendStoredFile({
    req,
    res,
    store,
    id,
    disposition: "attachment",
    cacheControl: "private, max-age=0, no-transform",
    recordDownload: !noCount,
  });
}

async function handlePreview(req, res, store, id) {
  const file = store.get(id);
  if (file?.kind === "folder") {
    sendJson(res, 415, { error: "Folders can be downloaded as ZIP files." });
    return;
  }
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

async function sendFolderZip({ req, res, store, folder }) {
  const entries = await buildZipEntries(store, folder);
  const encodedName = encodeRFC5987(ensureZipName(folder.name));
  res.writeHead(200, {
    ...corsHeaders(),
    "Cache-Control": "private, max-age=0, no-transform",
    "Content-Disposition": `attachment; filename="${asciiFileName(ensureZipName(folder.name))}"; filename*=UTF-8''${encodedName}`,
    "Content-Type": "application/zip",
    "X-Content-Type-Options": "nosniff",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  recordDownloadAfterResponse(res, store, folder.id);
  try {
    await writeZipToStream(entries, res);
  } catch (err) {
    if (!res.destroyed) res.destroy(err);
  }
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

// Stream one upload chunk straight to its byte offset in the (preallocated) temp
// file. Each chunk uses an independent positioned write stream, so many can run
// at once without disturbing each other's file position.
function writeRequestAtOffset(tempPath, offset, req) {
  let bytes = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      callback(null, chunk);
    },
  });
  return streamPipeline(
    req,
    counter,
    fs.createWriteStream(tempPath, { flags: "r+", start: offset, highWaterMark: UPLOAD_HIGH_WATER_MARK })
  ).then(() => bytes);
}

// SHA-256 the reassembled file. Chunks arrive out of order, so the hash is taken
// once at the end over the finished bytes — identical to hashing the original.
function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath, { highWaterMark: DOWNLOAD_HIGH_WATER_MARK });
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function recordDownloadAfterResponse(res, store, id) {
  res.once("finish", () => {
    store.scheduleDownloadRecord(id);
  });
}

async function writeFolderZipToPath(store, folder, destination) {
  const entries = await buildZipEntries(store, folder);
  const output = fs.createWriteStream(destination, { highWaterMark: DOWNLOAD_HIGH_WATER_MARK });
  try {
    await writeZipToStream(entries, output);
  } catch (err) {
    output.destroy();
    await removeIfExists(destination);
    throw err;
  }
}

async function buildZipEntries(store, folder) {
  const children = store.getFolderChildren(folder.id);
  const usedNames = new Set();
  const entries = [];
  for (const child of children) {
    const filePath = store.pathFor(child);
    const stat = await fsp.stat(filePath);
    if (stat.size > 0xffffffff) throw new Error("ZIP download does not support files over 4 GB");
    const name = uniqueArchiveName(usedNames, safeDisplayName(child.name));
    entries.push({
      name,
      path: filePath,
      size: stat.size,
      crc32: await crc32File(filePath),
      modifiedAt: child.createdAt || Date.now(),
    });
  }
  return entries;
}

async function writeZipToStream(entries, stream) {
  if (entries.length > 0xffff) throw new Error("ZIP download does not support more than 65535 files");
  let offset = 0;
  const centralRecords = [];

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, "utf8");
    const { time, date } = dosDateTime(entry.modifiedAt);
    const localOffset = offset;
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(entry.crc32 >>> 0, 14);
    localHeader.writeUInt32LE(entry.size, 18);
    localHeader.writeUInt32LE(entry.size, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);
    await writeBuffer(stream, localHeader);
    await writeBuffer(stream, nameBuffer);
    offset += localHeader.length + nameBuffer.length;

    for await (const chunk of fs.createReadStream(entry.path, { highWaterMark: DOWNLOAD_HIGH_WATER_MARK })) {
      await writeBuffer(stream, chunk);
      offset += chunk.length;
    }

    centralRecords.push({ entry, nameBuffer, time, date, localOffset });
  }

  const centralStart = offset;
  for (const record of centralRecords) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(record.time, 12);
    header.writeUInt16LE(record.date, 14);
    header.writeUInt32LE(record.entry.crc32 >>> 0, 16);
    header.writeUInt32LE(record.entry.size, 20);
    header.writeUInt32LE(record.entry.size, 24);
    header.writeUInt16LE(record.nameBuffer.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(record.localOffset, 42);
    await writeBuffer(stream, header);
    await writeBuffer(stream, record.nameBuffer);
    offset += header.length + record.nameBuffer.length;
  }

  const centralSize = offset - centralStart;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(centralRecords.length, 8);
  end.writeUInt16LE(centralRecords.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);
  await writeBuffer(stream, end);
  await endStream(stream);
}

function writeBuffer(stream, buffer) {
  return new Promise((resolve, reject) => {
    if (stream.destroyed) {
      reject(new Error("Stream closed"));
      return;
    }
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      stream.off("error", onError);
      stream.off("drain", onDrain);
    };
    stream.once("error", onError);
    if (stream.write(buffer)) {
      cleanup();
      resolve();
      return;
    }
    stream.once("drain", onDrain);
  });
}

function endStream(stream) {
  return new Promise((resolve, reject) => {
    if (stream.writableEnded || stream.destroyed) {
      resolve();
      return;
    }
    stream.once("error", reject);
    stream.end(resolve);
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

  const noStoreAsset = /(?:^|[\\/])(?:index\.html|waterdrop-sw\.js|manifest\.webmanifest)$/.test(filePath);
  res.writeHead(200, {
    ...corsHeaders(),
    "Cache-Control": noStoreAsset ? "no-store" : "public, max-age=31536000, immutable",
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

function isValidFileId(id) {
  return typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

function toPublicFile(file, store = null) {
  if (file.kind === "folder") {
    const children = store ? store.getFolderChildren(file.id) : [];
    const size = children.reduce((sum, child) => sum + Number(child.size || 0), 0);
    return {
      id: file.id,
      kind: "folder",
      name: file.name,
      mimeType: "application/zip",
      size,
      itemCount: children.length,
      files: children.map((child) => toPublicFolderChild(child)),
      createdAt: file.createdAt,
      expiresAt: file.expiresAt,
      expiresInMs: Math.max(0, file.expiresAt - Date.now()),
      downloads: file.downloads || 0,
      lastDownloadedAt: file.lastDownloadedAt || null,
    };
  }
  return {
    id: file.id,
    kind: "file",
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

function toPublicFolderChild(file) {
  return {
    id: file.id,
    kind: "file",
    name: file.name,
    mimeType: file.mimeType,
    size: file.size,
    sha256: file.sha256,
    createdAt: file.createdAt,
    expiresAt: file.expiresAt,
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
    "Access-Control-Allow-Headers": "Content-Type, Range, X-WaterDrop-File-Name, X-WaterDrop-Mime-Type, X-WaterDrop-Upload-Id, X-WaterDrop-Folder-Id, X-WaterDrop-Chunk-Offset, X-WaterDrop-Total-Size, X-WaterDrop-No-Count",
    "Access-Control-Allow-Methods": "GET, HEAD, POST, PATCH, DELETE, OPTIONS",
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

async function readRequestJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
    if (Buffer.concat(chunks).length > 64 * 1024) throw new Error("Request body too large");
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  return JSON.parse(text);
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

function ensureZipName(name) {
  const safeName = safeDisplayName(name || "folder");
  return /\.zip$/i.test(safeName) ? safeName : `${safeName}.zip`;
}

function uniqueArchiveName(usedNames, name) {
  const safeName = safeDisplayName(name);
  const parsed = path.parse(safeName);
  for (let i = 0; i < 1000; i += 1) {
    const candidate = i === 0 ? safeName : `${parsed.name} (${i})${parsed.ext}`;
    const key = candidate.toLowerCase();
    if (!usedNames.has(key)) {
      usedNames.add(key);
      return candidate;
    }
  }
  throw new Error("Could not find a unique ZIP entry name");
}

async function crc32File(filePath) {
  let crc = 0xffffffff;
  for await (const chunk of fs.createReadStream(filePath, { highWaterMark: DOWNLOAD_HIGH_WATER_MARK })) {
    crc = crc32Update(crc, chunk);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32Update(crc, buffer) {
  let next = crc >>> 0;
  for (const byte of buffer) {
    next = CRC32_TABLE[(next ^ byte) & 0xff] ^ (next >>> 8);
  }
  return next >>> 0;
}

function dosDateTime(timestamp) {
  const date = new Date(timestamp || Date.now());
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
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
