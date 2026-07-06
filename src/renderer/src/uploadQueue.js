const DB_NAME = "waterdrop-upload-queue";
const DB_VERSION = 1;
const STORE_NAME = "uploads";
const CANCELLED_UPLOAD_TOMBSTONE_MS = 7 * 24 * 60 * 60 * 1000;

export const PAGE_UPLOAD_LOCK_MS = 45 * 1000;
export const STALE_UPLOAD_LOCK_MS = 2 * PAGE_UPLOAD_LOCK_MS;
export const STALLED_BACKGROUND_UPLOAD_MS = 60 * 1000;
export const UPLOAD_SYNC_TAG = "waterdrop-upload-queue";

let dbPromise = null;

export function isUploadQueueSupported() {
  return typeof indexedDB !== "undefined" && typeof Blob !== "undefined";
}

export async function queueUpload(file, uploadUrl, options = {}) {
  if (!isUploadQueueSupported()) throw new Error("Upload queue is not available");
  const now = Date.now();
  const record = {
    id: crypto.randomUUID(),
    name: file.name || "unnamed-file",
    size: Number(file.size || 0),
    mimeType: file.type || "application/octet-stream",
    blob: file,
    uploadUrl,
    status: "queued",
    progress: 1,
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    lockedUntil: 0,
    lastError: "",
  };
  if (options.folderId) record.folderId = options.folderId;
  if (options.folderName) record.folderName = options.folderName;
  const stored = await putUploadRecord(record);
  if (!stored) throw new Error("Upload was cancelled");
  return record;
}

export async function listQueuedUploads() {
  if (!isUploadQueueSupported()) return [];
  const db = await openDb();
  const items = await requestAsPromise(db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll());
  const now = Date.now();
  const expiredCancelledIds = [];
  const visible = [];
  for (const item of items) {
    if (isCancelledUploadRecord(item, now)) continue;
    if (isExpiredCancelledUploadRecord(item, now)) {
      expiredCancelledIds.push(item.id);
      continue;
    }
    visible.push(item);
  }
  if (expiredCancelledIds.length) deleteUploadRecords(expiredCancelledIds).catch(() => {});
  return visible.sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
}

export async function recoverInterruptedUploads(message = "Upload interrupted") {
  if (!isUploadQueueSupported()) return 0;
  const records = await listQueuedUploads();
  const now = Date.now();
  let recovered = 0;

  for (const record of records) {
    if (record.status !== "uploading") continue;
    const updatedAt = Number(record.updatedAt || record.createdAt || 0);
    const lockedUntil = Number(record.lockedUntil || 0);
    if (lockedUntil > now && now - updatedAt <= STALE_UPLOAD_LOCK_MS) continue;
    await markQueuedUploadFailed(record.id, message);
    recovered += 1;
  }

  return recovered;
}

export async function claimQueuedUpload(id, { force = false } = {}) {
  const record = await getUploadRecord(id);
  if (!record) return null;
  const now = Date.now();
  if (!force && record.lockedUntil > now && ["uploading", "syncing"].includes(record.status)) {
    return null;
  }
  const claimed = {
    ...record,
    status: "uploading",
    progress: Math.max(1, Number(record.progress || 0)),
    updatedAt: now,
    lockedUntil: now + PAGE_UPLOAD_LOCK_MS,
    syncStartedAt: 0,
    lastError: "",
  };
  return await putUploadRecord(claimed) ? claimed : null;
}

export async function releaseQueuedUpload(id, message = "") {
  const record = await getUploadRecord(id);
  if (!record) return null;
  const released = {
    ...record,
    status: "queued",
    progress: Math.max(1, Number(record.progress || 0)),
    updatedAt: Date.now(),
    lockedUntil: 0,
    syncStartedAt: 0,
    lastError: message || record.lastError || "",
  };
  return await putUploadRecord(released) ? released : null;
}

export async function touchQueuedUploadLock(id) {
  const record = await getUploadRecord(id);
  if (!record) return null;
  const updated = {
    ...record,
    updatedAt: Date.now(),
    lockedUntil: Date.now() + PAGE_UPLOAD_LOCK_MS,
  };
  return await putUploadRecord(updated) ? updated : null;
}

export async function updateQueuedUploadProgress(id, progress) {
  const record = await getUploadRecord(id);
  if (!record) return null;
  const updated = {
    ...record,
    progress: Math.max(1, Math.min(99, Number(progress || 0))),
    updatedAt: Date.now(),
  };
  return await putUploadRecord(updated) ? updated : null;
}

export async function markQueuedUploadFailed(id, message) {
  const record = await getUploadRecord(id);
  if (!record) return null;
  const updated = {
    ...record,
    status: "queued",
    progress: 0,
    attempts: Number(record.attempts || 0) + 1,
    updatedAt: Date.now(),
    lockedUntil: 0,
    syncStartedAt: 0,
    lastError: message || "Upload paused",
  };
  return await putUploadRecord(updated) ? updated : null;
}

export async function markQueuedUploadSyncing(id) {
  const record = await getUploadRecord(id);
  if (!record) return null;
  const now = Date.now();
  const updated = {
    ...record,
    status: "syncing",
    progress: Math.max(1, Number(record.progress || 0)),
    updatedAt: now,
    lockedUntil: now + 2 * PAGE_UPLOAD_LOCK_MS,
    syncStartedAt: record.status === "syncing" ? Number(record.syncStartedAt || now) : now,
    lastError: "",
  };
  return await putUploadRecord(updated) ? updated : null;
}

export async function clearQueuedUpload(id) {
  if (!id) return;
  const now = Date.now();
  await putUploadRecord({
    id,
    name: "",
    size: 0,
    mimeType: "application/octet-stream",
    blob: null,
    uploadUrl: "",
    status: "cancelled",
    progress: 0,
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    lockedUntil: 0,
    cancelledUntil: now + CANCELLED_UPLOAD_TOMBSTONE_MS,
    lastError: "",
  });
}

export async function requestBackgroundFetchUpload(registration, record) {
  if (!registration?.backgroundFetch?.fetch) return null;
  const existing = await registration.backgroundFetch.get(record.id).catch(() => null);
  if (existing) return existing;

  const request = new Request(record.uploadUrl, {
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

  return registration.backgroundFetch.fetch(record.id, [request], {
    title: `Uploading ${record.name || "file"}`,
    icons: [
      {
        src: new URL("icon.ico", window.location.href).toString(),
        sizes: "256x256",
        type: "image/x-icon",
        label: "WaterDrop",
      },
    ],
  });
}

export async function requestBackgroundUploadSync(registration) {
  if (!registration?.sync?.register) return false;
  await registration.sync.register(UPLOAD_SYNC_TAG);
  return true;
}

export function uploadRecordToView(record) {
  return {
    id: record.id,
    name: record.name || "unnamed-file",
    size: Number(record.size || 0),
    progress: Number(record.progress || 0),
    status: record.status || "queued",
    attempts: Number(record.attempts || 0),
    createdAt: Number(record.createdAt || 0),
    updatedAt: Number(record.updatedAt || 0),
    syncStartedAt: Number(record.syncStartedAt || 0),
    folderId: record.folderId || "",
    folderName: record.folderName || "",
    queued: true,
  };
}

async function getUploadRecord(id) {
  const db = await openDb();
  const record = await requestAsPromise(db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(id));
  if (!isAnyCancelledUploadRecord(record)) return record;
  if (isExpiredCancelledUploadRecord(record)) deleteUploadRecords([id]).catch(() => {});
  return null;
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

function isAnyCancelledUploadRecord(record) {
  return record?.status === "cancelled";
}

function isCancelledUploadRecord(record, now = Date.now()) {
  if (!isAnyCancelledUploadRecord(record)) return false;
  const cancelledUntil = Number(record.cancelledUntil || 0);
  return !cancelledUntil || cancelledUntil > now;
}

function isExpiredCancelledUploadRecord(record, now = Date.now()) {
  if (!isAnyCancelledUploadRecord(record)) return false;
  const cancelledUntil = Number(record.cancelledUntil || 0);
  return Boolean(cancelledUntil && cancelledUntil <= now);
}

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open upload queue"));
    request.onblocked = () => reject(new Error("Upload queue is blocked by another tab"));
  });
  return dbPromise;
}

function requestAsPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
  });
}
