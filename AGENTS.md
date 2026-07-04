\- Every update, make sure you change the version number accordingly. The version number should be "x.x.xx". after 99 minor changes, automatically set minor to zero and add 1 to the médium.

## Release channels (beta / stable)

WaterDrop ships on two independent auto-update channels, one per branch:

- **stable** — the `main` branch. Pushing to `main` triggers
  `.github/workflows/release.yml`, which publishes a full GitHub Release
  (marked `--latest`) with versions like `X.Y.Z` and a `latest.yml` manifest.
- **beta** — the `testing` branch. Pushing to `testing` triggers
  `.github/workflows/release-beta.yml`, which publishes a GitHub *prerelease*
  (never `--latest`) with versions like `X.Y.Z-beta.N` and a `beta.yml`
  manifest.

The channels are fully isolated: `src/main/updater.js` sets
`autoUpdater.channel` from the running build's own version (a `-beta` suffix →
`beta` channel, otherwise `latest`). A beta install only ever sees new betas; a
stable install only ever sees new stable releases. There is intentionally **no**
`generateUpdatesFilesForAllChannels`, so neither channel writes the other's
`.yml`. Promoting a feature = land it on `testing` first, then merge/push to
`main` for the stable release.

Beta versioning: base `X.Y.Z` is the next patch above the latest stable release
(or `package.json` if higher), and `N` is a per-base beta counter that restarts
at 1 for each new base. This is handled automatically by the workflow — no
manual version edits needed for betas.
