# WaterDrop Plan

WaterDrop is a private file shelf for a Tailnet. The desktop app starts a local HTTP server, serves a responsive file explorer at `/drop/`, and lets phones or computers upload/download files without transcoding or quality changes.

## Architecture

- Electron main process starts the file server and opens the desktop UI.
- One responsive React/Vite renderer is served both inside Electron and to phones at `/drop/`.
- File bytes never cross Electron IPC. Uploads and downloads go directly between the browser and the Node HTTP server.
- Metadata lives in the app data directory as JSON; file payloads are stored as opaque IDs on disk.
- Every file receives `createdAt` and `expiresAt`; cleanup runs on startup and hourly.
- Desktop-only actions, such as choosing a download folder and copying a stored file there, go through a small preload bridge.

## Tailscale Model

- The app runs on `127.0.0.1` for Electron/Tailscale Serve and listens broadly enough for direct Tailnet IP fallback.
- The default local port is `41737`, with automatic fallback to the next available port if needed.
- Requests from non-loopback addresses are limited to Tailscale ranges (`100.64.0.0/10` and `fd7a:115c:a1e0::/48`) so the app is not casually exposed to the LAN.
- The preferred URL is `https://<machine>.<tailnet>.ts.net/drop/` through Tailscale Serve.
- If Serve is not configured yet, the UI can publish `/drop` with:

```powershell
tailscale serve --bg --yes --set-path /drop http://127.0.0.1:<port>
```

- If Serve is unavailable, the QR falls back to `http://<tailscale-ip>:<port>/drop/`.

## Performance

- Uploads are multipart streams handled by Busboy and written straight to disk.
- Downloads are file streams with `Accept-Ranges: bytes`, enabling resumable and partial reads.
- The server does not base64 encode payloads and does not buffer whole files in memory.
- File hashes are calculated while streaming to support integrity checks without a second read.
- The UI uploads files independently so multiple files can progress in parallel.

## Retention

- Default retention is 7 days.
- Expired files disappear from the explorer and are removed from disk.
- Manual deletion is available from the desktop/mobile UI.

## UX

- Desktop: dense two-column command surface, QR/link panel, shelf table/grid, folder selection, save-to-folder action.
- Mobile: thumb-friendly upload tray, compact cards, sticky access/link panel, native browser download to the phone's downloads area.
- Visual language follows the referenced app: true black, warm ivory ink, thin engraved borders, restrained cards, QR as a primary object, and one-shot entrance motion only.

## Background Behavior

- The tray icon opens the app on left click.
- Closing the window hides it to tray by default, leaving the server ready.
- Start-on-login stores an Electron login item with `--hidden`, so boot launches are silent.
