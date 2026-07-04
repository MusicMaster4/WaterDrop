// Parallel, multi-connection transfers.
//
// A single TCP stream can't saturate a real network: throughput is capped by the
// bandwidth-delay product and by congestion control ramping up after every loss.
// Splitting a transfer across several connections at once sidesteps that limit —
// the same trick download accelerators and multipart cloud uploads use — and it
// is completely byte-identical: we move the exact same bytes, just in parallel.

export const DOWNLOAD_CHUNK_SIZE = 8 * 1024 * 1024;
export const UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024;
export const MAX_PARALLEL_DOWNLOADS = 6;
export const MAX_PARALLEL_UPLOADS = 6;
// Below this the round-trip overhead of splitting isn't worth it.
export const DOWNLOAD_PARALLEL_MIN_BYTES = 8 * 1024 * 1024;
export const UPLOAD_PARALLEL_MIN_BYTES = 12 * 1024 * 1024;
// Accelerated downloads assemble the file in memory before saving, so cap the
// size we'll hold on a phone; larger files fall back to a streamed native save.
export const DOWNLOAD_PARALLEL_MAX_BYTES = 512 * 1024 * 1024;

// iOS Safari's handling of programmatic Blob downloads is unreliable (it often
// opens the file inline instead of saving), so there we keep the native <a
// download> path untouched. Upload acceleration is unaffected and stays on.
function looksLikeIos() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const platform = navigator.platform || "";
  const iOsUa = /iPad|iPhone|iPod/.test(ua);
  const iPadOs = platform === "MacIntel" && Number(navigator.maxTouchPoints || 0) > 1;
  return iOsUa || iPadOs;
}

export function canParallelDownload(file) {
  const size = Number(file?.size || 0);
  return (
    typeof fetch === "function" &&
    typeof Blob === "function" &&
    typeof URL !== "undefined" &&
    typeof URL.createObjectURL === "function" &&
    "download" in document.createElement("a") &&
    !looksLikeIos() &&
    size >= DOWNLOAD_PARALLEL_MIN_BYTES &&
    size <= DOWNLOAD_PARALLEL_MAX_BYTES
  );
}

// Download one file over several parallel HTTP range requests, reassemble the
// chunks in order, and save the result. Rejects (without saving) if anything is
// off, so callers can fall back to a plain native download.
export async function parallelDownload(file, downloadUrl, { onProgress, signal } = {}) {
  const size = Number(file.size || 0);
  const chunkCount = Math.ceil(size / DOWNLOAD_CHUNK_SIZE);
  const parts = new Array(chunkCount);
  let received = 0;
  let nextIndex = 0;

  async function worker() {
    while (true) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const index = nextIndex++;
      if (index >= chunkCount) return;
      const start = index * DOWNLOAD_CHUNK_SIZE;
      const end = Math.min(size, start + DOWNLOAD_CHUNK_SIZE) - 1;
      const headers = { Range: `bytes=${start}-${end}` };
      // Only the first part counts, so the whole accelerated download registers
      // as a single download rather than one per chunk.
      if (index > 0) headers["X-WaterDrop-No-Count"] = "1";
      const response = await fetch(downloadUrl, { headers, signal, cache: "no-store" });
      if (response.status !== 206) throw new Error(`Expected 206, got ${response.status}`);
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength !== end - start + 1) throw new Error("Chunk size mismatch");
      parts[index] = buffer;
      received += buffer.byteLength;
      onProgress?.(Math.min(100, Math.round((received / size) * 100)));
    }
  }

  const workers = [];
  const parallel = Math.max(1, Math.min(MAX_PARALLEL_DOWNLOADS, chunkCount));
  for (let i = 0; i < parallel; i += 1) workers.push(worker());
  await Promise.all(workers);

  const blob = new Blob(parts, { type: file.mimeType || "application/octet-stream" });
  saveBlob(blob, file.name || "download");
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
}

export function canParallelUpload(record) {
  const blob = record?.blob;
  const size = Number(record?.size || blob?.size || 0);
  return (
    typeof fetch === "function" &&
    typeof AbortController === "function" &&
    blob &&
    typeof blob.slice === "function" &&
    size >= UPLOAD_PARALLEL_MIN_BYTES
  );
}

// Upload one file as many byte-range chunks over parallel connections. The server
// writes each chunk at its offset and hashes the reassembled file, so the stored
// bytes are identical to the source. Resolves once the file is committed; rejects
// (leaving the queued record intact) so the caller can retry or fall back.
export async function parallelUpload({
  blob,
  uploadUrl,
  id,
  name,
  mimeType,
  folderId,
  signal,
  onProgress,
  onActivity,
}) {
  const size = blob.size;
  const chunkCount = Math.ceil(size / UPLOAD_CHUNK_SIZE);
  let uploadedBytes = 0;
  let nextIndex = 0;
  let resultFile = null;

  async function worker() {
    while (true) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const index = nextIndex++;
      if (index >= chunkCount) return;
      const start = index * UPLOAD_CHUNK_SIZE;
      const end = Math.min(size, start + UPLOAD_CHUNK_SIZE);
      const headers = {
        "Content-Type": mimeType || "application/octet-stream",
        "X-WaterDrop-File-Name": encodeURIComponent(name || "unnamed-file"),
        "X-WaterDrop-Mime-Type": mimeType || "application/octet-stream",
        "X-WaterDrop-Upload-Id": id,
        "X-WaterDrop-Chunk-Offset": String(start),
        "X-WaterDrop-Total-Size": String(size),
      };
      if (folderId) headers["X-WaterDrop-Folder-Id"] = folderId;
      const response = await fetch(uploadUrl, {
        method: "POST",
        body: blob.slice(start, end),
        headers,
        signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json().catch(() => ({}));
      uploadedBytes += end - start;
      onActivity?.();
      onProgress?.(Math.min(100, Math.round((uploadedBytes / size) * 100)));
      if (data && Array.isArray(data.files) && data.files.length) resultFile = data.files[0];
    }
  }

  const workers = [];
  const parallel = Math.max(1, Math.min(MAX_PARALLEL_UPLOADS, chunkCount));
  for (let i = 0; i < parallel; i += 1) workers.push(worker());
  await Promise.all(workers);

  return resultFile;
}
