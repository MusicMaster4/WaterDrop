const DB_NAME = "waterdrop-upload-queue";
const DB_VERSION = 1;
const STORE_NAME = "uploads";

export const PAGE_UPLOAD_LOCK_MS = 45 * 1000;
export const UPLOAD_SYNC_TAG = "waterdrop-upload-queue";

let dbPromise = null;

export function isUploadQueueSupported() {
  return typeof indexedDB !== "undefined" && typeof Blob !== "undefined";
}

export async function queueUpload(file, uploadUrl) {
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
    progress: 0,
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    lockedUntil: 0,
    lastError: "",
  };
  await putUploadRecord(record);
  return record;
}

export async function listQueuedUploads() {
  if (!isUploadQueueSupported()) return [];
  const db = await openDb();
  return requestAsPromise(db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll())
    .then((items) => items.sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0)));
}

export async function claimQueuedUpload(id) {
  const record = await getUploadRecord(id);
  if (!record) return null;
  const now = Date.now();
  if (record.lockedUntil > now && ["uploading", "syncing"].includes(record.status)) {
    return null;
  }
  const claimed = {
    ...record,
    status: "uploading",
    progress: 0,
    updatedAt: now,
    lockedUntil: now + PAGE_UPLOAD_LOCK_MS,
    lastError: "",
  };
  await putUploadRecord(claimed);
  return claimed;
}

export async function touchQueuedUploadLock(id) {
  const record = await getUploadRecord(id);
  if (!record) return null;
  const updated = {
    ...record,
    updatedAt: Date.now(),
    lockedUntil: Date.now() + PAGE_UPLOAD_LOCK_MS,
  };
  await putUploadRecord(updated);
  return updated;
}

export async function updateQueuedUploadProgress(id, progress) {
  const record = await getUploadRecord(id);
  if (!record) return null;
  const updated = {
    ...record,
    progress: Math.max(0, Math.min(100, Number(progress || 0))),
    updatedAt: Date.now(),
  };
  await putUploadRecord(updated);
  return updated;
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
    lastError: message || "Upload paused",
  };
  await putUploadRecord(updated);
  return updated;
}

export async function markQueuedUploadSyncing(id) {
  const record = await getUploadRecord(id);
  if (!record) return null;
  const updated = {
    ...record,
    status: "syncing",
    progress: Math.max(1, Number(record.progress || 0)),
    updatedAt: Date.now(),
    lockedUntil: Date.now() + 2 * PAGE_UPLOAD_LOCK_MS,
    lastError: "",
  };
  await putUploadRecord(updated);
  return updated;
}

export async function clearQueuedUpload(id) {
  const db = await openDb();
  await requestAsPromise(db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).delete(id));
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
    queued: true,
  };
}

async function getUploadRecord(id) {
  const db = await openDb();
  return requestAsPromise(db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(id));
}

async function putUploadRecord(record) {
  const db = await openDb();
  await requestAsPromise(db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(record));
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
