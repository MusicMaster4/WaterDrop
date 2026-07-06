const DB_NAME = "waterdrop-upload-queue";
const DB_VERSION = 1;
const STORE_NAME = "uploads";
const SYNC_TAG = "waterdrop-upload-queue";
const WORKER_LOCK_MS = 2 * 60 * 1000;
const SHARE_TARGET_PATH = "share-target";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("sync", (event) => {
  if (event.tag !== SYNC_TAG) return;
  event.waitUntil(
    drainUploadQueue().then((result) => {
      if (result.failed > 0) throw new Error("Some uploads are still pending");
    })
  );
});

self.addEventListener("fetch", (event) => {
  if (!isShareTargetRequest(event.request)) return;
  event.respondWith(handleShareTarget(event.request));
});

self.addEventListener("backgroundfetchsuccess", (event) => {
  const id = event.registration.id;
  event.waitUntil(
    deleteUploadRecord(id).then(() => broadcast({ type: "WATERDROP_UPLOAD_DONE", id }))
  );
});

self.addEventListener("backgroundfetchfail", (event) => {
  event.waitUntil(markUploadQueued(event.registration.id, event.registration.failureReason || "Background upload failed"));
});

self.addEventListener("backgroundfetchabort", (event) => {
  event.waitUntil(markUploadQueued(event.registration.id, "Background upload aborted"));
});

async function drainUploadQueue() {
  const records = await listQueuedUploads();
  let uploaded = 0;
  let failed = 0;

  for (const record of records) {
    const now = Date.now();
    if (record.lockedUntil > now && ["uploading", "syncing"].includes(record.status)) continue;

    const claimed = {
      ...record,
      status: "syncing",
      progress: Math.max(1, Number(record.progress || 0)),
      updatedAt: now,
      lockedUntil: now + WORKER_LOCK_MS,
      syncStartedAt: record.status === "syncing" ? Number(record.syncStartedAt || now) : now,
      lastError: "",
    };
    if (!await putUploadRecord(claimed)) continue;
    broadcast({ type: "WATERDROP_UPLOAD_SYNCING", id: claimed.id });

    try {
      await uploadRecord(claimed);
      await deleteUploadRecord(claimed.id);
      uploaded += 1;
      broadcast({ type: "WATERDROP_UPLOAD_DONE", id: claimed.id });
    } catch (err) {
      failed += 1;
      await markUploadQueued(claimed.id, err.message || "Upload paused", claimed);
    }
  }

  return { uploaded, failed };
}

async function uploadRecord(record) {
  const response = await fetch(record.uploadUrl || "api/files/raw", {
    method: "POST",
    body: record.blob,
    headers: {
      "Content-Type": record.mimeType || "application/octet-stream",
      "X-WaterDrop-File-Name": encodeURIComponent(record.name || "unnamed-file"),
      "X-WaterDrop-Mime-Type": record.mimeType || "application/octet-stream",
      "X-WaterDrop-Upload-Id": record.id,
      ...(record.folderId ? { "X-WaterDrop-Folder-Id": record.folderId } : {}),
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

async function handleShareTarget(request) {
  const redirectUrl = new URL("./?shared=1", self.registration.scope);
  try {
    const queued = await queueShareTargetUploads(request);
    redirectUrl.searchParams.set("shared", String(queued));
    if (queued > 0) {
      if (self.registration.sync?.register) {
        await self.registration.sync.register(SYNC_TAG).catch(() => {});
      }
      await broadcast({ type: "WATERDROP_UPLOAD_QUEUED", count: queued, shared: true }).catch(() => {});
    }
  } catch (err) {
    console.error("Share target failed", err);
    redirectUrl.searchParams.set("shared", "error");
  }
  return Response.redirect(redirectUrl.href, 303);
}

async function queueShareTargetUploads(request) {
  const formData = await request.formData();
  const files = formData.getAll("files").filter(isFileLike);
  if (!files.length) {
    for (const value of formData.values()) {
      if (isFileLike(value)) files.push(value);
    }
  }

  if (!files.length) {
    const sharedText = buildSharedTextFile(formData);
    if (sharedText) files.push(sharedText);
  }

  let queued = 0;
  for (const file of files) {
    await queueSharedUpload(file);
    queued += 1;
  }
  return queued;
}

async function queueSharedUpload(file) {
  const now = Date.now();
  const name = file.name || `shared-file-${now}`;
  const record = {
    id: crypto.randomUUID(),
    name,
    size: Number(file.size || 0),
    mimeType: file.type || "application/octet-stream",
    blob: file,
    uploadUrl: new URL("api/files/raw", self.registration.scope).toString(),
    status: "queued",
    progress: 1,
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    lockedUntil: 0,
    lastError: "",
    shared: true,
  };
  if (!await putUploadRecord(record)) throw new Error(`Could not queue ${name}`);
  return record;
}

function buildSharedTextFile(formData) {
  const title = cleanSharedText(formData.get("title"));
  const text = cleanSharedText(formData.get("text"));
  const url = cleanSharedText(formData.get("url"));
  const lines = [];
  if (title) lines.push(title);
  if (url) lines.push(url);
  if (text && text !== url) lines.push(text);
  if (!lines.length) return null;

  const body = `${lines.join("\n\n")}\n`;
  const blob = new Blob([body], { type: "text/plain" });
  const safeTitle = (title || "shared-link")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  const name = `${safeTitle || "shared-link"}.txt`;
  try {
    return new File([blob], name, { type: "text/plain" });
  } catch {
    blob.name = name;
    return blob;
  }
}

function cleanSharedText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isShareTargetRequest(request) {
  if (request.method !== "POST") return false;
  const requestPath = new URL(request.url).pathname.replace(/\/+$/, "");
  const scopePath = new URL(self.registration.scope).pathname.replace(/\/+$/, "");
  return requestPath === `${scopePath}/${SHARE_TARGET_PATH}`;
}

function isFileLike(value) {
  return (
    value &&
    typeof value === "object" &&
    typeof value.arrayBuffer === "function" &&
    typeof value.size === "number"
  );
}

async function broadcast(message) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
  clients.forEach((client) => client.postMessage(message));
}

async function listQueuedUploads() {
  const db = await openDb();
  const records = await requestAsPromise(db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll());
  const now = Date.now();
  const expiredCancelledIds = [];
  const visible = [];
  for (const record of records) {
    if (isCancelledUploadRecord(record, now)) continue;
    if (isExpiredCancelledUploadRecord(record, now)) {
      expiredCancelledIds.push(record.id);
      continue;
    }
    visible.push(record);
  }
  if (expiredCancelledIds.length) deleteUploadRecords(expiredCancelledIds).catch(() => {});
  return visible.sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
}

async function putUploadRecord(record) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    let stored = false;
    transaction.oncomplete = () => resolve(stored);
    transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
    const request = store.get(record.id);
    request.onsuccess = () => {
      if (record.status !== "cancelled" && isCancelledUploadRecord(request.result)) return;
      store.put(record);
      stored = true;
    };
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
  });
}

async function deleteUploadRecord(id) {
  const record = await getUploadRecord(id);
  if (isCancelledUploadRecord(record)) return;
  const db = await openDb();
  await requestAsPromise(db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).delete(id));
}

async function deleteUploadRecords(ids) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
    ids.forEach((id) => store.delete(id));
  });
}

async function getUploadRecord(id) {
  const db = await openDb();
  return requestAsPromise(db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(id));
}

async function markUploadQueued(id, message, knownRecord = null) {
  const record = knownRecord || await getUploadRecord(id);
  if (!record) return;
  if (!knownRecord && record.status !== "syncing") return;
  const queued = await putUploadRecord({
    ...record,
    status: "queued",
    progress: 0,
    attempts: Number(record.attempts || 0) + 1,
    updatedAt: Date.now(),
    lockedUntil: 0,
    syncStartedAt: 0,
    lastError: message || "Upload paused",
  });
  if (!queued) return;
  await broadcast({ type: "WATERDROP_UPLOAD_QUEUED", id });
}

function isCancelledUploadRecord(record, now = Date.now()) {
  if (record?.status !== "cancelled") return false;
  const cancelledUntil = Number(record.cancelledUntil || 0);
  return !cancelledUntil || cancelledUntil > now;
}

function isExpiredCancelledUploadRecord(record, now = Date.now()) {
  if (record?.status !== "cancelled") return false;
  const cancelledUntil = Number(record.cancelledUntil || 0);
  return Boolean(cancelledUntil && cancelledUntil <= now);
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open upload queue"));
    request.onblocked = () => reject(new Error("Upload queue is blocked"));
  });
}

function requestAsPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
  });
}
