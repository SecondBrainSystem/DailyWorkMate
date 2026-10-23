# DailyWorkMate companion resources

- `runtime/`: downloaded OpenCode and optional speech runtimes; excluded from Git.
- `data/`: assistant settings, imported avatars and agent state; excluded from Git.
- `models/`: optional local resources; excluded from Git.

Run `npm run companion:setup` to install the supported OpenCode v2 runtime. Run `npm run companion:speech:setup` for optional local speech. Packages include matching runtimes only when installed before the build. Third-party license files are preserved with the resources.

Development uses this directory. The Windows folder distribution uses `companion/` beside `DailyWorkMate.exe`; the self-extracting portable uses `companion/` beside its launcher. Installer builds use Electron's user-data directory. `DAILYWORKMATE_COMPANION_HOME` overrides the location and can point at an existing companion directory.

Configure voices and microphone input in the assistant settings. Local speech uses the optional bundled resources; API speech sends audio/text to the separately configured speech endpoint. The chat proxy is not a speech endpoint.

See the [feature overview](../README.md), [installation guide](../docs/installation.md) and [speech guide](../docs/speech.md).
