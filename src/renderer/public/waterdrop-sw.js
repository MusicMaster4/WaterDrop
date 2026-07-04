const DB_NAME = "waterdrop-upload-queue";
const DB_VERSION = 1;
const STORE_NAME = "uploads";
const SYNC_TAG = "waterdrop-upload-queue";
const WORKER_LOCK_MS = 2 * 60 * 1000;

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
      lastError: "",
    };
    await putUploadRecord(claimed);
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

async function broadcast(message) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
  clients.forEach((client) => client.postMessage(message));
}

async function listQueuedUploads() {
  const db = await openDb();
  const records = await requestAsPromise(db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll());
  return records.sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
}

async function putUploadRecord(record) {
  const db = await openDb();
  await requestAsPromise(db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(record));
}

async function deleteUploadRecord(id) {
  const db = await openDb();
  await requestAsPromise(db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).delete(id));
}

async function getUploadRecord(id) {
  const db = await openDb();
  return requestAsPromise(db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(id));
}

async function markUploadQueued(id, message, knownRecord = null) {
  const record = knownRecord || await getUploadRecord(id);
  if (!record) return;
  await putUploadRecord({
    ...record,
    status: "queued",
    progress: 0,
    attempts: Number(record.attempts || 0) + 1,
    updatedAt: Date.now(),
    lockedUntil: 0,
    lastError: message || "Upload paused",
  });
  await broadcast({ type: "WATERDROP_UPLOAD_QUEUED", id });
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
