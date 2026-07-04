import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Clock3,
  Copy,
  Download,
  ExternalLink,
  FileArchive,
  FileAudio,
  FileCode2,
  FileImage,
  FileText,
  FileVideo,
  Folder,
  HardDriveDownload,
  Info,
  MonitorUp,
  MoreHorizontal,
  QrCode,
  RefreshCw,
  Server,
  Settings2,
  Shield,
  ShieldCheck,
  Smartphone,
  Trash2,
  UploadCloud,
  Wifi,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import logoUrl from "./logo.png";
import {
  PAGE_UPLOAD_LOCK_MS,
  STALE_UPLOAD_LOCK_MS,
  claimQueuedUpload,
  clearQueuedUpload,
  isUploadQueueSupported,
  listQueuedUploads,
  markQueuedUploadFailed,
  markQueuedUploadSyncing,
  queueUpload,
  recoverInterruptedUploads,
  requestBackgroundFetchUpload,
  requestBackgroundUploadSync,
  touchQueuedUploadLock,
  updateQueuedUploadProgress,
  uploadRecordToView,
} from "./uploadQueue";

const TAILSCALE_URL = "https://tailscale.com/download";
const TAILSCALE_IOS_URL = "https://apps.apple.com/app/tailscale/id1470499037";
const TAILSCALE_ANDROID_URL = "https://play.google.com/store/apps/details?id=com.tailscale.ipn";

// First-run setup guide: Welcome → This PC → Phone → Publish → Finish.
const ONBOARDING_STEPS = ["Welcome", "This PC", "Phone", "Publish", "Finish"];
const LAST_ONBOARD_STEP = ONBOARDING_STEPS.length - 1;
const UPLOAD_STALL_MS = Math.max(90 * 1000, STALE_UPLOAD_LOCK_MS);

const apiDefault = {
  getInfo: () => request("api/info"),
  getFiles: () => request("api/files"),
  eventsUrl: "api/events",
  uploadUrl: "api/files",
  rawUploadUrl: "api/files/raw",
  downloadUrl: (id) => `api/files/${id}/download`,
  previewUrl: (id) => `api/files/${id}/preview`,
  clearFiles: () => request("api/files", { method: "DELETE" }),
  deleteFile: (id) => request(`api/files/${id}`, { method: "DELETE" }),
  configureServe: () => request("api/tailscale/serve", { method: "POST" }),
};

function buildApi(baseUrl = "") {
  const prefix = baseUrl || "";
  const join = (path) => new URL(path, prefix || window.location.href).toString();
  return {
    getInfo: () => request(join("api/info")),
    getFiles: () => request(join("api/files")),
    eventsUrl: join("api/events"),
    uploadUrl: join("api/files"),
    rawUploadUrl: join("api/files/raw"),
    downloadUrl: (id) => join(`api/files/${id}/download`),
    previewUrl: (id) => join(`api/files/${id}/preview`),
    clearFiles: () => request(join("api/files"), { method: "DELETE" }),
    deleteFile: (id) => request(join(`api/files/${id}`), { method: "DELETE" }),
    configureServe: () => request(join("api/tailscale/serve"), { method: "POST" }),
  };
}

export default function App() {
  const isDesktop = Boolean(window.waterdrop);
  const fileInputRef = useRef(null);
  const dragDepth = useRef(0);
  const noticeTimeoutRef = useRef(null);
  const serviceWorkerRegistrationRef = useRef(null);
  const drainingUploadsRef = useRef(false);
  const lastUploadPauseNoticeRef = useRef(0);
  const [api, setApi] = useState(apiDefault);
  const [appInfo, setAppInfo] = useState(null);
  const [info, setInfo] = useState(null);
  const [files, setFiles] = useState([]);
  const [pending, setPending] = useState([]);
  const [settings, setSettings] = useState({});
  const [uploads, setUploads] = useState([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(true);
  const [qrOpen, setQrOpen] = useState(false);
  const [notice, setNotice] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [previewFile, setPreviewFile] = useState(null);
  const [update, setUpdate] = useState(null);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [uploadSupport, setUploadSupport] = useState({
    queue: isUploadQueueSupported(),
    serviceWorker: false,
    backgroundFetch: false,
    backgroundSync: false,
  });

  const notify = useCallback((message, kind = "info", action) => {
    if (!message) return;
    if (noticeTimeoutRef.current) window.clearTimeout(noticeTimeoutRef.current);
    setNotice({ id: crypto.randomUUID(), message, kind, action });
    noticeTimeoutRef.current = window.setTimeout(() => {
      setNotice(null);
      noticeTimeoutRef.current = null;
    }, 4800);
  }, []);

  useEffect(() => () => {
    if (noticeTimeoutRef.current) window.clearTimeout(noticeTimeoutRef.current);
  }, []);

  const refreshFiles = useCallback(async ({ silent = false } = {}) => {
    try {
      const result = await api.getFiles();
      setFiles(result.files || []);
      setPending(result.pending || []);
      setSettings(result.settings || {});
    } catch (err) {
      if (!silent) notify(err.message || "Could not refresh files", "warn");
    }
  }, [api, notify]);

  const refreshInfo = useCallback(async ({ silent = false } = {}) => {
    try {
      const result = await api.getInfo();
      setInfo(result);
    } catch (err) {
      if (!silent) notify(err.message || "Could not refresh network", "warn");
    }
  }, [api, notify]);

  const refreshQueuedUploads = useCallback(async () => {
    if (!isUploadQueueSupported()) return;
    try {
      const records = await listQueuedUploads();
      setUploads((items) => {
        const transient = items.filter((item) => !item.queued);
        return [...records.map(uploadRecordToView), ...transient].sort(sortUploads);
      });
    } catch (err) {
      notify(err.message || "Could not read upload queue", "warn");
    }
  }, [notify]);

  const registerBackgroundUpload = useCallback(async () => {
    const registration = serviceWorkerRegistrationRef.current;
    if (!registration) return false;
    try {
      return await requestBackgroundUploadSync(registration);
    } catch {
      return false;
    }
  }, []);

  const notifyUploadPaused = useCallback((message = "Upload paused. It will retry when possible.") => {
    const now = Date.now();
    if (now - lastUploadPauseNoticeRef.current < 30 * 1000) return;
    lastUploadPauseNoticeRef.current = now;
    notify(message, "warn");
  }, [notify]);

  const startBackgroundFetchUpload = useCallback(async (record) => {
    const registration = serviceWorkerRegistrationRef.current;
    if (!registration?.backgroundFetch?.fetch) return false;
    try {
      const syncing = await markQueuedUploadSyncing(record.id);
      const bgFetch = await requestBackgroundFetchUpload(registration, syncing || record);
      if (!bgFetch) return false;
      setUploads((items) =>
        upsertUpload(items, { ...uploadRecordToView(syncing || record), status: "syncing", progress: 1 })
      );
      bgFetch.addEventListener?.("progress", () => {
        const total = Number(bgFetch.uploadTotal || 0);
        if (!total) return;
        const progress = Math.max(1, Math.min(99, Math.round((bgFetch.uploaded / total) * 100)));
        setUploads((items) =>
          upsertUpload(items, { ...uploadRecordToView(syncing || record), status: "syncing", progress })
        );
      });
      return true;
    } catch {
      await markQueuedUploadFailed(record.id, "Background fetch unavailable").catch(() => {});
      return false;
    }
  }, []);

  const drainQueuedUploads = useCallback(async () => {
    if (drainingUploadsRef.current || !api.rawUploadUrl || !isUploadQueueSupported()) return;
    drainingUploadsRef.current = true;
    try {
      await recoverInterruptedUploads("Upload interrupted by app suspend");
      const records = await listQueuedUploads();
      for (const record of records) {
        const activeBackgroundFetch = await serviceWorkerRegistrationRef.current?.backgroundFetch
          ?.get(record.id)
          .catch(() => null);
        if (activeBackgroundFetch) continue;
        const claimed = await claimQueuedUpload(record.id);
        if (!claimed) continue;
        await uploadQueuedRecord({
          api,
          record: claimed,
          notifyUploadPaused,
          refreshFiles,
          registerBackgroundUpload,
          setUploads,
        });
      }
    } finally {
      drainingUploadsRef.current = false;
      await refreshQueuedUploads();
    }
  }, [api, notifyUploadPaused, refreshFiles, refreshQueuedUploads, registerBackgroundUpload]);

  useEffect(() => {
    if (!("serviceWorker" in navigator) || !window.isSecureContext) {
      setUploadSupport({
        queue: isUploadQueueSupported(),
        serviceWorker: false,
        backgroundFetch: false,
        backgroundSync: false,
      });
      return undefined;
    }

    let active = true;
    const swUrl = new URL("waterdrop-sw.js", window.location.href);
    const scope = new URL("./", window.location.href).pathname;
    navigator.serviceWorker.register(swUrl, { scope }).then(async (registration) => {
      const readyRegistration = await navigator.serviceWorker.ready;
      if (!active) return;
      serviceWorkerRegistrationRef.current = readyRegistration || registration;
      setUploadSupport({
        queue: isUploadQueueSupported(),
        serviceWorker: true,
        backgroundFetch: Boolean((readyRegistration || registration).backgroundFetch?.fetch),
        backgroundSync: Boolean((readyRegistration || registration).sync?.register),
      });
      registerBackgroundUpload();
    }).catch(() => {
      if (!active) return;
      setUploadSupport({
        queue: isUploadQueueSupported(),
        serviceWorker: false,
        backgroundFetch: false,
        backgroundSync: false,
      });
    });

    const onMessage = (event) => {
      const type = event.data?.type || "";
      if (!type.startsWith("WATERDROP_UPLOAD_")) return;
      refreshQueuedUploads();
      refreshFiles({ silent: true });
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => {
      active = false;
      navigator.serviceWorker.removeEventListener("message", onMessage);
    };
  }, [refreshFiles, refreshQueuedUploads, registerBackgroundUpload]);

  useEffect(() => {
    let mounted = true;
    async function boot() {
      try {
        if (isDesktop) {
          const desktopInfo = await window.waterdrop.appInfo();
          if (!mounted) return;
          setAppInfo(desktopInfo);
          setSettings(desktopInfo.settings || {});
          setApi(buildApi(desktopInfo.server.localUrl));
          if (!desktopInfo.settings?.onboardingComplete) setShowOnboarding(true);
        }
      } catch (err) {
        notify(err.message || "Desktop bridge failed", "warn");
      } finally {
        if (mounted) setBusy(false);
      }
    }
    boot();
    return () => {
      mounted = false;
    };
  }, [isDesktop, notify]);

  useEffect(() => {
    if (busy) return;
    refreshInfo();
    refreshFiles();
    refreshQueuedUploads().then(drainQueuedUploads);
  }, [busy, drainQueuedUploads, refreshFiles, refreshInfo, refreshQueuedUploads]);

  useEffect(() => {
    if (busy) return undefined;
    const refreshQuietly = () => refreshFiles({ silent: true });
    const retryUploadsQuietly = () => {
      registerBackgroundUpload();
      refreshQueuedUploads().then(drainQueuedUploads);
    };
    const refreshInterval = window.setInterval(refreshQuietly, window.EventSource ? 15000 : 3000);
    const uploadRetryInterval = window.setInterval(retryUploadsQuietly, 15000);
    let events = null;
    if (window.EventSource && api.eventsUrl) {
      events = new EventSource(api.eventsUrl);
      events.addEventListener("files", refreshQuietly);
    }
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        refreshQuietly();
        refreshInfo({ silent: true });
        retryUploadsQuietly();
      }
    };
    const onOnline = () => {
      retryUploadsQuietly();
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("focus", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(refreshInterval);
      window.clearInterval(uploadRetryInterval);
      events?.close();
      window.removeEventListener("online", onOnline);
      window.removeEventListener("focus", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [api, busy, drainQueuedUploads, refreshFiles, refreshInfo, refreshQueuedUploads, registerBackgroundUpload]);

  // Tailscale Serve publishes a few seconds after launch. Poll the network only
  // until the QR carries the real phone link (serve path published), then stop —
  // no perpetual background spawning of the Tailscale CLI.
  const servePublished = Boolean(info?.network?.servePathConfigured);
  useEffect(() => {
    if (busy || servePublished) return undefined;
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      refreshInfo({ silent: true });
      if (attempts >= 12) window.clearInterval(timer); // give up after ~1 min
    }, 5000);
    return () => window.clearInterval(timer);
  }, [busy, servePublished, refreshInfo]);

  useEffect(() => {
    if (!isDesktop || !window.waterdrop?.update) return undefined;
    let active = true;
    window.waterdrop.update.status().then((status) => {
      if (active) setUpdate(status);
    });
    const unsubscribe = window.waterdrop.update.onStatus((status) => {
      if (!active) return;
      setUpdate(status);
    });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [isDesktop]);

  const checkForUpdate = useCallback(async () => {
    if (!window.waterdrop?.update) return;
    const status = await window.waterdrop.update.check({ silent: false });
    setUpdate(status);
  }, []);

  const downloadUpdate = useCallback(async () => {
    if (!window.waterdrop?.update) return;
    const result = await window.waterdrop.update.download();
    if (!result.ok) setUpdate({ state: "error", message: result.message || "Download failed" });
  }, []);

  const installUpdate = useCallback(async () => {
    if (!window.waterdrop?.update) return;
    await window.waterdrop.update.install();
  }, []);

  const network = info?.network || appInfo?.network || {};
  const preferredUrl = network.preferredUrl || network.localUrl || appInfo?.server?.localUrl || "";
  const stats = useMemo(() => {
    const totalBytes = files.reduce((sum, file) => sum + Number(file.size || 0), 0);
    return {
      count: files.length,
      totalBytes,
      nextExpiry: files.reduce((min, file) => Math.min(min, file.expiresAt || Infinity), Infinity),
    };
  }, [files]);
  const uploadModeTitle = uploadSupport.backgroundFetch
    ? "Background uploads can continue through the browser task UI."
    : uploadSupport.backgroundSync
    ? "Queued uploads can retry in the background on this browser."
    : uploadSupport.queue
      ? "Queued uploads resume when this page is open."
      : "Standard upload: keep this page open.";

  // Placeholders for uploads still in flight anywhere on the tailnet. Drop any
  // whose real file has already landed so the swap has no flicker or duplicate.
  const placeholders = useMemo(
    () => pending.filter((item) => !files.some((file) => file.id === item.id)),
    [pending, files]
  );

  async function copyText(text, label = "Copied") {
    if (!text) return;
    try {
      if (window.waterdrop) {
        await window.waterdrop.copyText(text);
      } else {
        await navigator.clipboard.writeText(text);
      }
      notify(label, "ok");
    } catch {
      notify("Copy failed", "warn");
    }
  }

  async function publishServe() {
    try {
      const result = window.waterdrop
        ? await window.waterdrop.configureServe()
        : await api.configureServe();
      if (!result.ok) throw new Error(result.message || "Serve failed");
      notify("/drop published", "ok");
      await refreshInfo();
    } catch (err) {
      notify(err.message || "Could not publish /drop", "warn");
    }
  }

  async function chooseFolder() {
    if (!window.waterdrop) return;
    const result = await window.waterdrop.chooseDownloadDir();
    if (result.ok) {
      if (result.settings) {
        setSettings(result.settings);
      } else {
        setSettings((current) => ({ ...current, downloadDir: result.downloadDir }));
      }
      notify("Folder saved", "ok");
    }
  }

  async function updateSetting(patch) {
    if (!window.waterdrop) return;
    const result = await window.waterdrop.setSettings(patch);
    if (result.ok) {
      setSettings(result.settings || {});
      notify("Setting saved", "ok");
    } else {
      notify(result.message || "Setting failed", "warn");
    }
  }

  async function finishOnboarding({ startOnLogin }) {
    if (window.waterdrop) {
      const result = await window.waterdrop.setSettings({
        onboardingComplete: true,
        startOnLogin: Boolean(startOnLogin),
      });
      if (result.ok) setSettings(result.settings || {});
    }
    setShowOnboarding(false);
    notify("Setup complete", "ok");
    await refreshInfo({ silent: true });
  }

  function rerunSetup() {
    setShowOnboarding(true);
  }

  function pickFiles() {
    fileInputRef.current?.click();
  }

  function onFilesPicked(event) {
    const picked = Array.from(event.target.files || []);
    event.target.value = "";
    uploadFiles(picked);
  }

  function onDrop(event) {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (isWaterDropDrag(event)) return;
    uploadFiles(Array.from(event.dataTransfer.files || []));
  }

  function onDragEnter(event) {
    event.preventDefault();
    if (isWaterDropDrag(event)) return;
    dragDepth.current += 1;
    setDragging(true);
  }

  function onDragLeave(event) {
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }

  async function uploadFiles(picked) {
    const valid = picked.filter(Boolean);
    if (!valid.length) return;
    if (!api.rawUploadUrl || !isUploadQueueSupported()) {
      valid.forEach((file) => uploadOneLegacy(file));
      return;
    }

    let queued = 0;
    let browserBackground = 0;
    for (const file of valid) {
      try {
        const record = await queueUpload(file, api.rawUploadUrl);
        queued += 1;
        setUploads((items) => upsertUpload(items, uploadRecordToView(record)));
        if (await startBackgroundFetchUpload(record)) {
          browserBackground += 1;
        }
      } catch (err) {
        notify(err.message || `Could not queue ${file.name}`, "warn");
        uploadOneLegacy(file);
      }
    }

    if (queued > 0) {
      const hasBackgroundSync = await registerBackgroundUpload();
      notify(
        browserBackground > 0
          ? "Upload handed to the browser background task."
          : hasBackgroundSync
          ? "Upload queued for background retry."
          : "Upload queued. It resumes when this page is open.",
        browserBackground > 0 || hasBackgroundSync ? "ok" : "info"
      );
      if (browserBackground < queued) drainQueuedUploads();
    }
  }

  async function dismissUpload(upload) {
    if (!upload) return;
    if (upload.queued) {
      try {
        await clearQueuedUpload(upload.id);
      } catch (err) {
        notify(err.message || "Could not remove upload", "warn");
        return;
      }
    }
    setUploads((items) => items.filter((item) => item.id !== upload.id));
  }

  function uploadOneLegacy(file) {
    const id = crypto.randomUUID();
    setUploads((items) => [
      ...items,
      { id, name: file.name, size: file.size, progress: 0, status: "uploading", createdAt: Date.now() },
    ]);

    const xhr = new XMLHttpRequest();
    const useRawUpload = Boolean(api.rawUploadUrl);
    xhr.open("POST", useRawUpload ? api.rawUploadUrl : api.uploadUrl, true);
    if (useRawUpload) {
      xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
      xhr.setRequestHeader("X-WaterDrop-File-Name", encodeURIComponent(file.name || "unnamed-file"));
      xhr.setRequestHeader("X-WaterDrop-Mime-Type", file.type || "application/octet-stream");
      xhr.setRequestHeader("X-WaterDrop-Upload-Id", id);
    }
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      const progress = Math.round((event.loaded / event.total) * 100);
      setUploads((items) =>
        items.map((item) => (item.id === id ? { ...item, progress } : item))
      );
    };
    xhr.onload = async () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        setUploads((items) =>
          items.map((item) => (item.id === id ? { ...item, progress: 100, status: "done" } : item))
        );
        window.setTimeout(() => {
          setUploads((items) => items.filter((item) => item.id !== id));
        }, 1400);
        await refreshFiles();
      } else {
        setUploads((items) =>
          items.map((item) => (item.id === id ? { ...item, status: "error" } : item))
        );
        notify(`Upload failed: ${file.name}`, "warn");
      }
    };
    xhr.onerror = () => {
      setUploads((items) =>
        items.map((item) => (item.id === id ? { ...item, status: "error" } : item))
      );
      notify(`Upload failed: ${file.name}`, "warn");
    };
    if (useRawUpload) {
      xhr.send(file);
    } else {
      const data = new FormData();
      data.append("files", file, file.name);
      xhr.send(data);
    }
  }

  async function downloadFile(file) {
    if (window.waterdrop) {
      const result = await window.waterdrop.saveFile(file.id);
      if (result.ok) {
        notify("Saved to folder", "ok", {
          label: "Reveal",
          run: () => window.waterdrop.revealPath(result.destination),
        });
        await refreshFiles();
        return;
      }
      notify(result.message || "Save failed", "warn");
      return;
    }
    window.location.href = api.downloadUrl(file.id);
    window.setTimeout(refreshFiles, 1000);
  }

  function startExternalDrag(file, event) {
    if (!window.waterdrop?.startFileDrag) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "copy";
      event.dataTransfer.setData("application/x-waterdrop-file", file.id);
      event.dataTransfer.setData("text/plain", file.name);
    }
    window.waterdrop.startFileDrag(file.id);
  }

  async function clearFiles() {
    try {
      const result = await api.clearFiles();
      setConfirmClear(false);
      setConfirmDelete(null);
      setPreviewFile(null);
      notify(`Cleared ${result.deleted || 0} files`, "ok");
      await refreshFiles();
    } catch (err) {
      notify(err.message || "Clear failed", "warn");
    }
  }

  async function deleteFile(file) {
    try {
      await api.deleteFile(file.id);
      setConfirmDelete(null);
      notify("Deleted", "ok");
      await refreshFiles();
    } catch (err) {
      notify(err.message || "Delete failed", "warn");
    }
  }

  async function copyImage(file) {
    if (!file) return { ok: false, message: "No image selected" };
    if (window.waterdrop?.copyImage) {
      const result = await window.waterdrop.copyImage(file.id);
      if (!result.ok) notify(result.message || "Copy failed", "warn");
      return result;
    }
    try {
      const response = await fetch(api.previewUrl(file.id));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      return { ok: true };
    } catch (err) {
      notify(err.message || "Copy failed", "warn");
      return { ok: false, message: err.message || "Copy failed" };
    }
  }

  return (
    <>
      <div className="grain" aria-hidden="true" />
      {showOnboarding && (
        <Onboarding
          network={network}
          servePublished={Boolean(network.servePathConfigured)}
          initialStartOnLogin={Boolean(settings.startOnLogin)}
          onPublish={publishServe}
          onRefreshInfo={refreshInfo}
          onFinish={finishOnboarding}
        />
      )}
      <div className="shell" hidden={showOnboarding}>
        <aside className="conn">
          <div className="url-row">
            <div className="url-box mono" title={preferredUrl}>
              {preferredUrl || "Preparing..."}
            </div>
            <button className="icon-btn" title="Copy URL" onClick={() => copyText(preferredUrl)}>
              <Copy size={16} />
            </button>
            <button className="icon-btn only-mobile" title="QR" onClick={() => setQrOpen((open) => !open)}>
              {qrOpen ? <ChevronDown size={17} /> : <QrCode size={17} />}
            </button>
          </div>

          <div className={`qr-collapsible ${qrOpen ? "is-open" : ""}`}>
            <div className="qr-frame">
              {info?.qrSvg ? (
                <div className="qr-svg" dangerouslySetInnerHTML={{ __html: info.qrSvg }} />
              ) : (
                <span className="qr-empty mono small">QR</span>
              )}
            </div>
            <div className="conn-meta mono small">
              <span className="muted">Path /drop</span>
              <span className={network.servePathConfigured ? "muted" : "danger"}>
                {network.servePathConfigured ? "published" : "not published"}
              </span>
            </div>
          </div>

          <div className="conn-actions">
            <button className="btn btn-ghost btn-sm" onClick={refreshInfo}>
              <RefreshCw size={14} /> Refresh
            </button>
            <button className="btn btn-ghost btn-sm" onClick={publishServe}>
              <MonitorUp size={14} /> Publish
            </button>
            <a className="btn btn-ghost btn-sm" href={preferredUrl || "#"} target="_blank" rel="noreferrer">
              <ExternalLink size={14} /> Open
            </a>
          </div>

          {isDesktop && (
            <div className="settings-panel only-desktop">
              <div className="card-title mono small muted">Settings</div>
              <label className="toggle-row">
                <span>
                  <span className="toggle-title">Start on login</span>
                  <span className="toggle-sub mono small muted">Silent tray launch.</span>
                </span>
                <input
                  className="switch"
                  type="checkbox"
                  checked={Boolean(settings.startOnLogin)}
                  onChange={(event) => updateSetting({ startOnLogin: event.target.checked })}
                />
              </label>
              <label className="toggle-row">
                <span>
                  <span className="toggle-title">Close to tray</span>
                  <span className="toggle-sub mono small muted">Server stays ready.</span>
                </span>
                <input
                  className="switch"
                  type="checkbox"
                  checked={settings.minimizeToTray !== false}
                  onChange={(event) => updateSetting({ minimizeToTray: event.target.checked })}
                />
              </label>
              <div className="update-row">
                <span className="mono small muted">
                  v{formatAppVersion(update?.currentVersion || appInfo?.version || "?")}
                </span>
                <button className="btn btn-ghost btn-xs" onClick={checkForUpdate}>
                  <RefreshCw size={13} /> Check updates
                </button>
              </div>
              <UpdateInline
                update={update}
                onDownload={downloadUpdate}
                onInstall={installUpdate}
              />
              <div className="setup-row">
                <span className="mono small muted">Setup guide</span>
                <button className="btn btn-ghost btn-xs" onClick={rerunSetup}>
                  <RefreshCw size={13} /> Re-run setup
                </button>
              </div>
            </div>
          )}

          <div className="conn-foot mono small faint">
            <Shield size={14} />
            <span>Loopback + Tailnet clients only.</span>
          </div>
        </aside>

        <main className="work">
          <div className="work-head">
            <div className="shelf-count mono small">
              <span>{stats.count} files</span>
              <span className="sep" />
              <span>{formatBytes(stats.totalBytes)}</span>
              <span className="sep" />
              <span>{Number.isFinite(stats.nextExpiry) ? `next ${timeLeft(stats.nextExpiry)}` : "7 day shelf"}</span>
            </div>
            <div className="work-head-actions">
              <button className="icon-btn" title="Refresh files" onClick={refreshFiles}>
                <RefreshCw size={16} />
              </button>
              {files.length > 0 && (
                confirmClear ? (
                  <span className="confirm clear-confirm">
                    <button className="icon-btn danger" title="Clear all files" onClick={clearFiles}>
                      <Check size={16} />
                    </button>
                    <button className="icon-btn" title="Cancel" onClick={() => setConfirmClear(false)}>
                      <X size={16} />
                    </button>
                  </span>
                ) : (
                  <button className="icon-btn danger" title="Clear all files" onClick={() => setConfirmClear(true)}>
                    <Trash2 size={16} />
                  </button>
                )
              )}
              <button className="btn btn-solid btn-sm" title={uploadModeTitle} onClick={pickFiles}>
                <UploadCloud size={15} /> Upload
              </button>
            </div>
          </div>

          {notice && (
            <div className={`status-line ${notice.kind === "warn" ? "is-warn" : notice.kind === "ok" ? "is-ok" : ""}`}>
              <span className={`dot ${notice.kind === "ok" ? "dot-ok" : notice.kind === "warn" ? "dot-warn" : "dot-idle"}`} />
              <span>{notice.message}</span>
              {notice.action && (
                <button className="status-action" onClick={notice.action.run}>
                  {notice.action.label}
                </button>
              )}
            </div>
          )}

          {isDesktop && (
            <div className="folder-row only-desktop">
              <Folder size={16} />
              <span className="folder-path mono small" title={settings.downloadDir}>
                {settings.downloadDir || appInfo?.paths?.downloadDir || "Downloads"}
              </span>
              <button className="btn btn-ghost btn-xs" onClick={chooseFolder}>
                Choose
              </button>
            </div>
          )}

          <button
            className={`dropzone ${dragging ? "is-drag" : ""}`}
            onClick={pickFiles}
            onDrop={onDrop}
            onDragOver={(event) => event.preventDefault()}
            onDragEnter={onDragEnter}
            onDragLeave={onDragLeave}
            title={uploadModeTitle}
          >
            <UploadCloud className="dz-icon" size={34} strokeWidth={1.5} />
            <span className="dz-title">Drop files</span>
          </button>

          <input ref={fileInputRef} type="file" multiple hidden onChange={onFilesPicked} />

          {uploads.length > 0 && (
            <div className="uploads">
              {uploads.map((upload) => (
                <div className="upload-row" key={upload.id}>
                  <div className="upload-top">
                    <span className="upload-name">{upload.name}</span>
                    <span className={`upload-status mono small ${upload.status === "done" ? "ok" : upload.status === "error" ? "err" : upload.status === "queued" ? "queued" : ""}`}>
                      {uploadStatusText(upload)}
                    </span>
                    {canDismissUpload(upload) && (
                      <button className="icon-btn upload-dismiss" title="Remove upload" onClick={() => dismissUpload(upload)}>
                        <X size={14} />
                      </button>
                    )}
                  </div>
                  <div className="upload-tail">
                    <div className="upload-bar">
                      <div
                        className="upload-bar-fill"
                        data-status={upload.status}
                        style={{ width: `${upload.progress}%` }}
                      />
                    </div>
                    <span className="mono small muted">{formatBytes(upload.size)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          <section className="shelf">
            {files.length === 0 && placeholders.length === 0 ? (
              <div className="empty">NO FILES ON THE SHELF</div>
            ) : (
              <>
                {placeholders.map((item) => (
                  <PlaceholderCard item={item} key={item.id} />
                ))}
                {files.map((file) => (
                <FileCard
                  api={api}
                  confirmDelete={confirmDelete === file.id}
                  file={file}
                  isDesktop={isDesktop}
                  key={file.id}
                  onCopyHash={() => copyText(file.sha256, "Hash copied")}
                  onDelete={() => deleteFile(file)}
                  onDownload={() => downloadFile(file)}
                  onPreview={() => setPreviewFile(file)}
                  onRequestDelete={() => setConfirmDelete(file.id)}
                  onCancelDelete={() => setConfirmDelete(null)}
                  onStartDrag={(event) => startExternalDrag(file, event)}
                />
                ))}
              </>
            )}
          </section>
        </main>
      </div>

      {previewFile && (
        <PreviewModal
          api={api}
          file={previewFile}
          isDesktop={isDesktop}
          onClose={() => setPreviewFile(null)}
          onCopyImage={() => copyImage(previewFile)}
          onDownload={() => downloadFile(previewFile)}
        />
      )}

    </>
  );
}

function openExternal(url) {
  if (window.waterdrop?.openExternal) {
    window.waterdrop.openExternal(url);
  } else {
    window.open(url, "_blank", "noreferrer");
  }
}

function Onboarding({ network, servePublished, initialStartOnLogin, onPublish, onRefreshInfo, onFinish }) {
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState("fwd");
  const [tsStatus, setTsStatus] = useState(null);
  const [tsChecking, setTsChecking] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [startOnLogin, setStartOnLogin] = useState(initialStartOnLogin);
  const [finishing, setFinishing] = useState(false);

  const checkTailscale = useCallback(async () => {
    setTsChecking(true);
    try {
      if (window.waterdrop?.tailscaleStatus) {
        const result = await window.waterdrop.tailscaleStatus();
        setTsStatus(result.ok ? result.status : { found: false });
      } else {
        setTsStatus(network || { found: false });
      }
    } finally {
      setTsChecking(false);
    }
  }, [network]);

  useEffect(() => {
    if (step === 1) checkTailscale();
  }, [step, checkTailscale]);

  function go(next) {
    setDirection(next > step ? "fwd" : "back");
    setStep(Math.max(0, Math.min(LAST_ONBOARD_STEP, next)));
  }

  async function publishNow() {
    setPublishing(true);
    try {
      await onPublish();
      await onRefreshInfo({ silent: true });
    } finally {
      setPublishing(false);
    }
  }

  async function finish() {
    setFinishing(true);
    await onFinish({ startOnLogin });
    setFinishing(false);
  }

  const ts = tsStatus || {};
  const tsState = !ts.found
    ? { dot: "dot-warn", msg: "Tailscale isn't installed on this PC yet. Install it, then re-check." }
    : !ts.loggedIn
      ? { dot: "dot-warn", msg: "Tailscale is installed but not signed in. Open Tailscale and log in." }
      : !ts.running
        ? { dot: "dot-warn", msg: "Tailscale is signed in but not connected. Connect it, then re-check." }
        : { dot: "dot-ok", msg: ts.dnsName ? `Connected as ${ts.dnsName}` : "Connected and ready." };

  return (
    <section className="onboarding">
      <aside className="onb-rail">
        <div className="onb-brand">
          <img className="onb-brand-mark" src={logoUrl} alt="WaterDrop logo" />
          <span className="onb-brand-name">WaterDrop</span>
        </div>
        <ol className="onb-steps">
          {ONBOARDING_STEPS.map((label, i) => (
            <li className="onb-step" key={label}>
              <span className={`onb-dot ${i < step ? "is-done" : i === step ? "is-active" : ""}`}>
                {i < step ? <Check size={11} strokeWidth={3} /> : i + 1}
              </span>
              <span className={`onb-label ${i === step ? "is-active" : ""}`}>{label}</span>
            </li>
          ))}
        </ol>
        <p className="onb-foot mono small faint">Private file shelf, your network only.</p>
      </aside>

      <div className="onb-pane">
        <div className="onb-body">
          <div className={`onb-view onb-anim-${direction}`} key={step}>
            {step === 0 && (
              <div className="onb-welcome">
                <span className="onb-iris" aria-hidden="true" />
                <img className="onb-hero-mark" src={logoUrl} alt="WaterDrop logo" />
                <h1 className="onb-title">Welcome to WaterDrop</h1>
                <p className="onb-lead">
                  A private, AirDrop-style shelf for your files — served straight from this PC
                  over your own Tailscale network. No cloud, no accounts, no public links.
                </p>
                <ul className="onb-chips">
                  <li>Private Tailscale link</li>
                  <li>Original bytes, no re-encoding</li>
                  <li>QR pairing with your phone</li>
                </ul>
              </div>
            )}

            {step === 1 && (
              <div className="onb-step-body">
                <h1 className="onb-title">Install Tailscale on this PC</h1>
                <p className="onb-lead">
                  WaterDrop reaches your phone through Tailscale — a private tunnel between
                  your own devices. Install it here and sign in to your account.
                </p>
                <div className="onb-card">
                  <div className="status-line">
                    <span className={`dot ${tsChecking ? "dot-idle" : tsState.dot}`} />
                    <span>{tsChecking ? "Checking Tailscale…" : tsState.msg}</span>
                  </div>
                </div>
                <div className="onb-actions">
                  <button className="btn btn-ghost btn-sm" onClick={() => openExternal(TAILSCALE_URL)}>
                    <ExternalLink size={14} /> Get Tailscale
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={checkTailscale} disabled={tsChecking}>
                    <RefreshCw size={14} /> Re-check
                  </button>
                </div>
              </div>
            )}

            {step === 2 && (
              <div className="onb-step-body">
                <h1 className="onb-title">Set up your phone</h1>
                <p className="onb-lead">
                  Add your phone to the <b>same</b> Tailscale account so it can reach this
                  computer's shelf.
                </p>
                <div className="onb-phone-steps">
                  <div className="onb-phone-step">
                    <span className="onb-phone-num">1</span>
                    <h3 className="onb-phone-title">Install</h3>
                    <p className="onb-phone-desc">Get the Tailscale app.</p>
                    <div className="onb-phone-links">
                      <button className="onb-link" onClick={() => openExternal(TAILSCALE_IOS_URL)}>App Store ↗</button>
                      <button className="onb-link" onClick={() => openExternal(TAILSCALE_ANDROID_URL)}>Google Play ↗</button>
                    </div>
                  </div>
                  <div className="onb-phone-step">
                    <span className="onb-phone-num">2</span>
                    <h3 className="onb-phone-title">Sign in</h3>
                    <p className="onb-phone-desc">Use the same account as this PC.</p>
                  </div>
                  <div className="onb-phone-step">
                    <span className="onb-phone-num">3</span>
                    <h3 className="onb-phone-title">Connect</h3>
                    <p className="onb-phone-desc">Turn Tailscale on and keep it connected.</p>
                  </div>
                </div>
              </div>
            )}

            {step === 3 && (
              <div className="onb-step-body">
                <h1 className="onb-title">Publish your shelf</h1>
                <p className="onb-lead">
                  WaterDrop shares files at a private <span className="mono">/drop</span> path over
                  Tailscale Serve. Publish it once so the QR code carries a real phone-ready link.
                </p>
                <div className="onb-card">
                  <div className="status-line">
                    <span className={`dot ${servePublished ? "dot-ok" : "dot-warn"}`} />
                    <span>
                      {servePublished
                        ? "/drop is published over Tailscale Serve."
                        : "/drop isn't published yet."}
                    </span>
                  </div>
                  {network?.preferredUrl && (
                    <div className="onb-url mono small" title={network.preferredUrl}>{network.preferredUrl}</div>
                  )}
                </div>
                <div className="onb-actions">
                  <button className="btn btn-solid btn-sm" onClick={publishNow} disabled={publishing || servePublished}>
                    <MonitorUp size={14} /> {servePublished ? "Published" : publishing ? "Publishing…" : "Publish /drop"}
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => onRefreshInfo()}>
                    <RefreshCw size={14} /> Refresh
                  </button>
                </div>
                <p className="onb-note mono small faint">
                  No Tailscale yet? You can still publish later from the main window.
                </p>
              </div>
            )}

            {step === 4 && (
              <div className="onb-step-body">
                <span className="onb-hero-mark onb-hero-mark-sm"><ShieldCheck size={44} strokeWidth={1.35} /></span>
                <h1 className="onb-title">You're all set</h1>
                <p className="onb-lead">
                  Drop files into WaterDrop, scan the QR code with your phone, and grab them from the
                  shelf. Should WaterDrop start automatically when this computer boots?
                </p>
                <div className="onb-segmented" role="radiogroup" aria-label="Start on login">
                  <button
                    type="button"
                    className={`onb-seg ${startOnLogin ? "is-selected" : ""}`}
                    role="radio"
                    aria-checked={startOnLogin}
                    onClick={() => setStartOnLogin(true)}
                  >
                    Yes, start on boot
                  </button>
                  <button
                    type="button"
                    className={`onb-seg ${!startOnLogin ? "is-selected" : ""}`}
                    role="radio"
                    aria-checked={!startOnLogin}
                    onClick={() => setStartOnLogin(false)}
                  >
                    No, I'll open it
                  </button>
                </div>
                <p className="onb-note mono small faint">You can change this anytime in Settings.</p>
              </div>
            )}
          </div>
        </div>

        <div className="onb-nav">
          <button className="btn btn-ghost" onClick={() => go(step - 1)} hidden={step === 0}>
            <ArrowLeft size={15} /> Back
          </button>
          {step === LAST_ONBOARD_STEP ? (
            <button className="btn btn-solid" onClick={finish} disabled={finishing}>
              {finishing ? "Finishing…" : "Finish"} <Check size={15} />
            </button>
          ) : (
            <button className="btn btn-solid" onClick={() => go(step + 1)}>
              Next <ArrowRight size={15} />
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function UpdateInline({ update, onDownload, onInstall }) {
  if (!update) return null;
  const { state } = update;
  if (state === "idle") return null;

  return (
    <div className={`update-inline ${state === "error" ? "is-error" : ""}`} role="status">
      {state === "checking" && <span className="mono small muted">Checking for updates...</span>}
      {state === "up-to-date" && <span className="mono small muted">You're on the latest version.</span>}
      {state === "dev" && <span className="mono small muted">Updates run only in the installed app.</span>}
      {state === "error" && <span className="mono small danger">{update.message || "Update check failed."}</span>}
      {state === "available" && (
        <>
          <span className="mono small muted">Version {formatAppVersion(update.version)} is available.</span>
          <button className="btn btn-solid btn-xs" onClick={onDownload}>
            <Download size={13} /> Download &amp; Update
          </button>
        </>
      )}
      {state === "downloading" && (
        <>
          <div className="update-progress" aria-label={`Downloading ${update.percent || 0}%`}>
            <span style={{ width: `${update.percent || 0}%` }} />
          </div>
          <span className="mono small muted">{update.percent || 0}%</span>
        </>
      )}
      {state === "downloaded" && (
        <>
          <span className="mono small muted">Version {formatAppVersion(update.version || "")} is ready.</span>
          <button className="btn btn-solid btn-xs" onClick={onInstall}>
            <RefreshCw size={13} /> Install &amp; Restart
          </button>
        </>
      )}
    </div>
  );
}

function PlaceholderCard({ item }) {
  const name = item.name || "Incoming file";
  return (
    <article className="file file-placeholder" aria-label={`Receiving ${name}`} aria-busy="true">
      <div className="file-tile file-tile-loading shimmer">
        <UploadCloud className="placeholder-icon" size={22} strokeWidth={1.5} aria-hidden="true" />
      </div>
      <div className="file-body">
        <div className="file-name" title={name}>
          {name}
        </div>
        <div className="file-meta mono small">
          <span>{item.size ? formatBytes(item.size) : "Receiving…"}</span>
          <span className="placeholder-status">
            <UploadCloud size={12} /> uploading
          </span>
        </div>
        <span className="placeholder-line shimmer" aria-hidden="true" />
      </div>
      <div className="file-actions">
        <span className="placeholder-pill shimmer" aria-hidden="true" />
      </div>
    </article>
  );
}

function FileCard({
  api,
  confirmDelete,
  file,
  isDesktop,
  onCancelDelete,
  onCopyHash,
  onDelete,
  onDownload,
  onPreview,
  onRequestDelete,
  onStartDrag,
}) {
  const Icon = iconFor(file);
  const isImage = isImageFile(file);
  const isVideo = isVideoFile(file);
  const isPdf = isPdfFile(file);
  const title = isDesktop ? "Click to preview. Drag to copy." : "Click to preview.";
  function onCardKeyDown(event) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onPreview();
  }

  return (
    <article
      aria-label={`Preview ${file.name}`}
      className="file"
      draggable={isDesktop}
      onClick={onPreview}
      onDragStart={isDesktop ? onStartDrag : undefined}
      onKeyDown={onCardKeyDown}
      tabIndex={0}
      title={title}
    >
      <div className={`file-tile ${isImage || isVideo || isPdf ? "has-preview" : ""}`}>
        {isImage ? (
          <img className="file-preview-img" src={api.previewUrl(file.id)} alt="" loading="lazy" draggable={false} />
        ) : isVideo ? (
          <>
            <video
              className="file-preview-video"
              src={`${api.previewUrl(file.id)}#t=0.1`}
              preload="metadata"
              muted
              playsInline
              draggable={false}
              aria-label={`Preview of ${file.name}`}
              onLoadedMetadata={(event) => {
                const video = event.currentTarget;
                if (Number.isFinite(video.duration) && video.duration > 0.12) {
                  video.currentTime = 0.1;
                }
              }}
            />
            <span className="file-badge mono">VIDEO</span>
          </>
        ) : isPdf ? (
          <>
            <object
              className="file-preview-pdf"
              data={`${api.previewUrl(file.id)}#toolbar=0&navpanes=0&scrollbar=0`}
              type="application/pdf"
              draggable={false}
              aria-label={`Preview of ${file.name}`}
            >
              <Icon size={26} strokeWidth={1.45} />
            </object>
            <span className="pdf-icon-preview" aria-hidden="true">
              <Icon size={30} strokeWidth={1.35} />
            </span>
            <span className="file-badge mono">PDF</span>
          </>
        ) : (
          <Icon size={26} strokeWidth={1.45} />
        )}
      </div>
      <div className="file-body">
        <div className="file-name" title={file.name}>
          {file.name}
        </div>
        <div className="file-meta mono small">
          <span>{formatBytes(file.size)}</span>
          <span>
            <Clock3 size={12} /> {timeLeft(file.expiresAt)}
          </span>
          <span>
            <Download size={12} /> {file.downloads || 0}
          </span>
        </div>
        <button
          className="file-sha mono small"
          onClick={(event) => {
            event.stopPropagation();
            onCopyHash();
          }}
          onKeyDown={(event) => event.stopPropagation()}
          title={file.sha256}
        >
          <Info size={12} /> {shortHash(file.sha256)}
        </button>
      </div>
      <div
        className="file-actions"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        {isDesktop ? (
          <button className="btn btn-solid btn-xs" onClick={onDownload}>
            <HardDriveDownload size={14} /> Save
          </button>
        ) : (
          <a className="btn btn-solid btn-xs" href={api.downloadUrl(file.id)} download>
            <Download size={14} /> Get
          </a>
        )}
        {confirmDelete ? (
          <span className="confirm">
            <button className="icon-btn danger" title="Delete now" onClick={onDelete}>
              <Check size={16} />
            </button>
            <button className="icon-btn" title="Cancel" onClick={onCancelDelete}>
              <X size={16} />
            </button>
          </span>
        ) : (
          <button className="icon-btn danger" title="Delete" onClick={onRequestDelete}>
            <Trash2 size={16} />
          </button>
        )}
      </div>
    </article>
  );
}

function PreviewModal({ api, file, isDesktop, onClose, onCopyImage, onDownload }) {
  const kind = previewKindFor(file);
  const previewUrl = api.previewUrl(file.id);
  const [contextMenu, setContextMenu] = useState(null);
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef(null);

  const requestClose = useCallback(() => {
    setClosing((already) => {
      if (already) return already;
      closeTimer.current = window.setTimeout(() => onClose(), 200);
      return true;
    });
  }, [onClose]);

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  const copyImageFromPreview = useCallback(async () => {
    if (kind !== "image") return;
    setContextMenu((menu) => (menu ? { ...menu, busy: true } : menu));
    const result = await onCopyImage?.();
    if (result?.ok) {
      setContextMenu((menu) => (menu ? { ...menu, busy: false, copied: true } : menu));
      window.setTimeout(() => setContextMenu(null), 650);
      return;
    }
    setContextMenu((menu) => (menu ? { ...menu, busy: false } : menu));
  }, [kind, onCopyImage]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        if (contextMenu) {
          setContextMenu(null);
          return;
        }
        requestClose();
      }
      if (kind === "image" && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
        event.preventDefault();
        copyImageFromPreview();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [contextMenu, copyImageFromPreview, kind, requestClose]);

  useEffect(() => {
    if (!contextMenu) return undefined;
    const closeContextMenu = () => setContextMenu(null);
    document.addEventListener("click", closeContextMenu);
    window.addEventListener("blur", closeContextMenu);
    return () => {
      document.removeEventListener("click", closeContextMenu);
      window.removeEventListener("blur", closeContextMenu);
    };
  }, [contextMenu]);

  return (
    <div
      className={`preview-overlay ${closing ? "closing" : ""}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <section className="preview-dialog" aria-label={`Preview ${file.name}`} aria-modal="true" role="dialog">
        <header className="preview-head">
          <div className="preview-title-block">
            <div className="preview-title" title={file.name}>
              {file.name}
            </div>
            <div className="preview-meta mono small">
              <span>{formatBytes(file.size)}</span>
              <span>{file.mimeType || "application/octet-stream"}</span>
              <span>{timeLeft(file.expiresAt)}</span>
            </div>
          </div>
          <button className="icon-btn" title="Close preview" onClick={requestClose}>
            <X size={16} />
          </button>
        </header>

        <div className={`preview-body preview-${kind}`}>
          {kind === "image" && (
            <img
              className="preview-media"
              src={previewUrl}
              alt={file.name}
              onContextMenu={(event) => {
                event.preventDefault();
                setContextMenu({
                  x: Math.min(event.clientX, window.innerWidth - 190),
                  y: Math.min(event.clientY, window.innerHeight - 56),
                  busy: false,
                  copied: false,
                });
              }}
            />
          )}
          {kind === "video" && <video className="preview-media" src={previewUrl} controls autoPlay={false} />}
          {kind === "audio" && (
            <div className="preview-audio-wrap">
              <FileAudio size={44} strokeWidth={1.3} />
              <audio className="preview-audio" src={previewUrl} controls />
            </div>
          )}
          {kind === "pdf" && <iframe className="preview-frame" title={file.name} src={previewUrl} />}
          {kind === "text" && <TextPreview file={file} url={previewUrl} />}
          {kind === "other" && (
            <div className="preview-empty">
              <MoreHorizontal size={42} strokeWidth={1.35} />
              <span>No inline preview for this file type.</span>
            </div>
          )}
        </div>

        <footer className="preview-foot">
          <button className="btn btn-solid btn-sm" onClick={onDownload}>
            {isDesktop ? <HardDriveDownload size={14} /> : <Download size={14} />}
            {isDesktop ? "Save" : "Get"}
          </button>
          <a className="btn btn-ghost btn-sm" href={previewUrl} target="_blank" rel="noreferrer">
            <ExternalLink size={14} /> Open
          </a>
        </footer>
      </section>
      {contextMenu && (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={(event) => event.stopPropagation()}
          role="menu"
        >
          <button className="context-menu-item" onClick={copyImageFromPreview} role="menuitem">
            <Copy size={14} />
            {contextMenu.copied ? "Copied" : contextMenu.busy ? "Copying..." : "Copy image"}
          </button>
        </div>
      )}
    </div>
  );
}

function TextPreview({ file, url }) {
  const [state, setState] = useState({ status: "loading", text: "" });

  useEffect(() => {
    const limit = 2 * 1024 * 1024;
    if (Number(file.size || 0) > limit) {
      setState({ status: "too-large", text: "" });
      return undefined;
    }

    const controller = new AbortController();
    setState({ status: "loading", text: "" });
    fetch(url, { cache: "no-store", signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      })
      .then((text) => setState({ status: "ready", text }))
      .catch((err) => {
        if (err.name !== "AbortError") setState({ status: "error", text: err.message });
      });
    return () => controller.abort();
  }, [file.size, url]);

  if (state.status === "loading") {
    return <div className="preview-empty mono">Loading preview...</div>;
  }
  if (state.status === "too-large") {
    return <div className="preview-empty">Text preview is limited to 2 MB.</div>;
  }
  if (state.status === "error") {
    return <div className="preview-empty">Could not load preview.</div>;
  }
  return <pre className="preview-text">{state.text || " "}</pre>;
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    cache: "no-store",
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(body.error || body.message || `HTTP ${response.status}`);
  }
  return body;
}

async function uploadQueuedRecord({
  api,
  record,
  notifyUploadPaused,
  refreshFiles,
  registerBackgroundUpload,
  setUploads,
}) {
  const uploadUrl = record.uploadUrl || api.rawUploadUrl;
  const view = uploadRecordToView(record);
  setUploads((items) => upsertUpload(items, { ...view, status: "uploading", progress: 0 }));

  let lastPersistedProgress = 0;
  const lockTimer = window.setInterval(() => {
    touchQueuedUploadLock(record.id).catch(() => {});
  }, Math.max(5000, Math.floor(PAGE_UPLOAD_LOCK_MS / 3)));

  try {
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      let settled = false;
      let lastActivityAt = Date.now();

      const cleanup = () => {
        window.clearInterval(stallTimer);
        window.removeEventListener("offline", onOffline);
        window.removeEventListener("pagehide", onPageHide);
        document.removeEventListener("visibilitychange", onVisibilityChange);
      };
      const settle = (handler, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        handler(value);
      };
      const fail = (message) => {
        if (settled) return;
        try {
          xhr.abort();
        } catch {}
        settle(reject, new Error(message));
      };
      const markActivity = () => {
        lastActivityAt = Date.now();
      };
      const onOffline = () => fail("Upload paused while offline");
      const onPageHide = () => fail("Upload paused while app was backgrounded");
      const onVisibilityChange = () => {
        if (document.visibilityState === "hidden") fail("Upload paused while app was backgrounded");
      };
      const stallTimer = window.setInterval(() => {
        if (Date.now() - lastActivityAt > UPLOAD_STALL_MS) {
          fail("Upload paused after the connection stopped responding");
        }
      }, 5000);

      window.addEventListener("offline", onOffline);
      window.addEventListener("pagehide", onPageHide);
      document.addEventListener("visibilitychange", onVisibilityChange);

      xhr.open("POST", uploadUrl, true);
      xhr.setRequestHeader("Content-Type", record.mimeType || "application/octet-stream");
      xhr.setRequestHeader("X-WaterDrop-File-Name", encodeURIComponent(record.name || "unnamed-file"));
      xhr.setRequestHeader("X-WaterDrop-Mime-Type", record.mimeType || "application/octet-stream");
      xhr.setRequestHeader("X-WaterDrop-Upload-Id", record.id);
      xhr.upload.onprogress = (event) => {
        markActivity();
        if (!event.lengthComputable) return;
        const progress = Math.round((event.loaded / event.total) * 100);
        setUploads((items) => upsertUpload(items, { ...view, status: "uploading", progress }));
        if (progress - lastPersistedProgress >= 10 || progress === 100) {
          lastPersistedProgress = progress;
          updateQueuedUploadProgress(record.id, progress).catch(() => {});
        }
      };
      xhr.upload.onload = markActivity;
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          settle(resolve);
          return;
        }
        settle(reject, new Error(`HTTP ${xhr.status}`));
      };
      xhr.onerror = () => settle(reject, new Error("Network error"));
      xhr.onabort = () => settle(reject, new Error("Upload aborted"));
      xhr.send(record.blob);
    });

    await clearQueuedUpload(record.id);
    setUploads((items) => upsertUpload(items, { ...view, queued: false, status: "done", progress: 100 }));
    window.setTimeout(() => {
      setUploads((items) => items.filter((item) => item.id !== record.id));
    }, 1400);
    await refreshFiles();
  } catch (err) {
    const queued = await markQueuedUploadFailed(record.id, err.message || "Upload paused");
    if (queued) setUploads((items) => upsertUpload(items, uploadRecordToView(queued)));
    await registerBackgroundUpload();
    notifyUploadPaused?.();
  } finally {
    window.clearInterval(lockTimer);
  }
}

function upsertUpload(items, upload) {
  const next = items.filter((item) => item.id !== upload.id);
  next.push(upload);
  return next.sort(sortUploads);
}

function sortUploads(a, b) {
  return Number(a.createdAt || 0) - Number(b.createdAt || 0);
}

function uploadStatusText(upload) {
  if (upload.status === "done") return "done";
  if (upload.status === "error") return "error";
  if (upload.status === "queued") return "queued";
  if (upload.status === "syncing") return "syncing";
  return `${upload.progress || 0}%`;
}

function canDismissUpload(upload) {
  return upload.status === "queued" || upload.status === "error";
}

function isWaterDropDrag(event) {
  return Array.from(event.dataTransfer?.types || []).includes("application/x-waterdrop-file");
}

function iconFor(file) {
  const type = String(file.mimeType || "");
  const name = String(file.name || "").toLowerCase();
  if (type.startsWith("image/")) return FileImage;
  if (isPdfFile(file)) return FileText;
  if (type.startsWith("video/")) return FileVideo;
  if (type.startsWith("audio/")) return FileAudio;
  if (type.includes("zip") || type.includes("compressed") || /\.(zip|rar|7z|tar|gz)$/.test(name)) return FileArchive;
  if (type.includes("text") || /\.(txt|md|csv|log|json|xml|html|css|js|ts|py)$/.test(name)) {
    return /\.(js|ts|py|css|html|json|xml)$/.test(name) ? FileCode2 : FileText;
  }
  return MoreHorizontal;
}

function isImageFile(file) {
  return String(file.mimeType || "").startsWith("image/");
}

function isVideoFile(file) {
  return String(file.mimeType || "").startsWith("video/");
}

function isAudioFile(file) {
  return String(file.mimeType || "").startsWith("audio/");
}

function isPdfFile(file) {
  const type = String(file.mimeType || "").toLowerCase();
  const name = String(file.name || "").toLowerCase();
  return type === "application/pdf" || name.endsWith(".pdf");
}

function isTextFile(file) {
  const type = String(file.mimeType || "").toLowerCase();
  const name = String(file.name || "").toLowerCase();
  return (
    type.startsWith("text/") ||
    ["application/json", "application/xml", "application/javascript", "application/x-javascript"].includes(type) ||
    /\.(txt|md|csv|log|json|xml|html|css|js|ts|jsx|tsx|py|rb|go|rs|java|c|cpp|h|hpp|sh|ps1|yaml|yml)$/.test(name)
  );
}

function previewKindFor(file) {
  if (isImageFile(file)) return "image";
  if (isVideoFile(file)) return "video";
  if (isAudioFile(file)) return "audio";
  if (isPdfFile(file)) return "pdf";
  if (isTextFile(file)) return "text";
  return "other";
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let current = bytes / 1024;
  let index = 0;
  while (current >= 1024 && index < units.length - 1) {
    current /= 1024;
    index += 1;
  }
  return `${current >= 100 ? current.toFixed(0) : current >= 10 ? current.toFixed(1) : current.toFixed(2)} ${units[index]}`;
}

function timeLeft(timestamp) {
  const ms = Number(timestamp || 0) - Date.now();
  if (ms <= 0) return "expired";
  const minutes = Math.ceil(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.ceil(hours / 24)}d`;
}

function shortHash(hash) {
  if (!hash) return "no hash";
  return `${hash.slice(0, 10)}...${hash.slice(-6)}`;
}

function formatAppVersion(version) {
  const raw = String(version || "");
  // Stable release: pad the patch to two digits (e.g. 0.1.2 -> 0.1.02).
  const stable = raw.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (stable) {
    return `${Number(stable[1])}.${Number(stable[2])}.${String(Number(stable[3])).padStart(2, "0")}`;
  }
  // Beta channel: its internal id is "-testing.N" (electron-updater reserves
  // "beta" for cascading updates), but users see it labelled as "beta".
  const beta = raw.match(/^(\d+)\.(\d+)\.(\d+)-testing\.(\d+)$/);
  if (beta) {
    const base = `${Number(beta[1])}.${Number(beta[2])}.${String(Number(beta[3])).padStart(2, "0")}`;
    return `${base}-beta.${Number(beta[4])}`;
  }
  return raw;
}
