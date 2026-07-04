# Water Drop

AirDrop-style private file sharing for your own Tailscale network.

The app listens on port `41737` by default and falls forward if that port is busy.

## Run

```powershell
npm install
npm start
```

For live renderer development:

```powershell
npm run dev
```

## Use With Tailscale

Open the desktop app, then use the QR code on your phone. If `/drop` is not published yet, click **Publish** in the app. The app will run:

```powershell
tailscale serve --bg --yes --set-path /drop http://127.0.0.1:<port>
```

Files stay available for 7 days by default.

## Background Mode

Use the desktop settings panel to enable **Start on login**. When enabled, Water Drop starts silently in the tray with the server already running. Clicking the tray icon opens the app window.
