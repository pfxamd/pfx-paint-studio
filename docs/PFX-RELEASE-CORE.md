# PFx shared application release engine

This application retains `release.config.json`, the existing first-parent Git
baseline, and the original build-time `version.json`/badge contract.
`scripts/pfx-release.mjs` keeps its Vite and static-export interfaces but
delegates release resolution to `@pfxamd/release-core`.

The adapter `scripts/pfx-release-loader.mjs` installs exactly
`v0.1.0-alpha.4` from a GitHub Release archive in the ignored
`.pfx-release-tools/` folder. No app dependencies or lockfiles are changed.
The build must have Node.js, npm, full Git history and access to the pinned
archive. Runtime visitors do not load this package; it runs only while building
the app. App versions remain independent from the versions of consumed cores.

The repository's existing Pages/Workers deployment stays unchanged. A failed
dependency fetch or shallow checkout fails visibly instead of inventing an
app version. Do not overwrite package versions to match application versions.
