\- Every update, make sure you change the version number accordingly. The version number should be "x.x.xx". after 99 minor changes, automatically set minor to zero and add 1 to the médium.

## Release channels (beta / stable)

WaterDrop ships on two independent auto-update channels, one per branch:

- **stable** — the `main` branch. Pushing to `main` triggers
  `.github/workflows/release.yml`, which publishes a full GitHub Release
  (marked `--latest`) with versions like `X.Y.Z` and a `latest.yml` manifest.
- **beta** — the `testing` branch. Pushing to `testing` triggers
  `.github/workflows/release-beta.yml`, which publishes a GitHub *prerelease*
  (never `--latest`) with versions like `X.Y.Z-testing.N` and a `testing.yml`
  manifest.

The channels are fully isolated: `src/main/updater.js` sets
`autoUpdater.channel` from the running build's own version (prerelease tag →
that channel, otherwise `latest`). A beta install only ever sees new betas; a
stable install only ever sees new stable releases. Promoting a feature = land it
on `testing` first, then merge/push to `main` for the stable release.

**Do not rename the beta channel to "alpha" or "beta".** electron-updater's
GitHub provider hardcodes those two identifiers as *cascading* channels: a
client on `beta` is forced to also accept stable releases and fall back to
`latest.yml`, which breaks the isolation. The channel is therefore called
`testing` (any name other than alpha/beta works). The GitHub release title still
reads "(beta)" for humans.

Beta versioning: base `X.Y.Z` is the next patch above the latest stable release
(or `package.json` if higher), and `N` is a per-base counter that restarts at 1
for each new base. This is handled automatically by the workflow — no manual
version edits needed for betas.
