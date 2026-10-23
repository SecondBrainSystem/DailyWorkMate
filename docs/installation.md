# DailyWorkMate installation guide

[Feature overview](../README.md) · [简体中文](installation_CN.md)

This guide covers running the app, source setup, packaging, optional components and data migration.

## Choose how to run

| Distribution | How to use it |
| --- | --- |
| **Windows folder build** | Recommended for everyday use. Keep the entire folder and run `DailyWorkMate.exe`, without per-launch extraction. |
| **Windows installer** | Run the version's setup EXE and follow the wizard to install and create shortcuts. |
| **Windows portable EXE** | A single launcher file that may extract the application at startup. |
| **Source checkout** | Install development dependencies and run or package the app yourself. |

Use a matching artifact from [Releases](https://github.com/SecondBrainSystem/DailyWorkMate/releases) if one is available for your version and platform; otherwise build from source. A folder build's DLLs and `resources/` must stay alongside its EXE.

Desktop and optional-runtime validation currently focuses on Windows x64. macOS/Linux build configurations exist, but shell choices, native dependencies and runtime support depend on the platform and have not been validated as equivalent to Windows.

## Install and run from source

Install **Node.js 22.18 or newer**, npm and Git. Native dependencies need platform build tools when compatible prebuilt binaries are unavailable; on Windows this commonly involves Python and Visual Studio C++ Build Tools.

```bash
git clone https://github.com/SecondBrainSystem/DailyWorkMate.git
cd DailyWorkMate
npm ci
```

Windows development mode:

```powershell
npm run dev:win
```

Development entry point for macOS/Linux:

```bash
npm run dev
```

Run a production build locally:

```bash
npm run build
npm run preview
```

## Optional components

### OpenCode workspace runtime

Run from the source checkout:

```bash
npm run companion:setup
```

The script downloads the project's selected OpenCode v2 version and checks it. Files are stored in `companion/runtime/opencode-v2/`. The current script uses a Windows executable; it is not a general macOS/Linux installer.

Native OpenCode features need an available runtime; ordinary model connections and the compatibility API service can be configured independently. Install matching platform resources before packaging if you want to bundle the runtime.

### Claude Code

Use a locally installed Claude Code CLI that the app can discover. The OpenCode setup script does not install Claude Code. Select its engine in Work and configure a compatible model connection. Follow the CLI's own documentation for installation, authentication and usage requirements.

### Local speech

```bash
npm run companion:speech:setup
```

This optional download includes substantial recognition and synthesis resources. The current setup has been exercised on Windows x64. Install before packaging to include matching resources; third-party notices are preserved with the components. See the [speech guide](speech.md).

Choose a speech source in the assistant's character and voice settings. Microphone input requires operating-system permission. Without local resources, use available system voices or separately configured compatible speech APIs. Speech and chat endpoints are configured separately.

## First-time configuration

1. In **Model connections**, add a provider/API account or Ollama node, or refresh and select a supported free model.
2. Choose a model in Assistant or AI Chat. Workspace tasks also require appropriate tool capabilities.
3. For Work, add authorized folders, confirm read-only or editable access, and choose an engine to open a session.
4. To connect other clients, check listeners and local API keys in **API service**, then start it. The default OpenAI-compatible base URL is `http://127.0.0.1:11434/v1`; use the address shown in the app if you change the port.
5. After sending requests, inspect recorded usage and request logs in **Usage monitor**.

Free availability and quotas are controlled upstream; a catalog entry does not guarantee available quota. See [free model connections](free-models.md) and the [provider reference](providers/README.md) for protocols, model identifiers and verification.

## Builds and checks

| Command | Purpose |
| --- | --- |
| `npm run typecheck` | Check main-process, preload and renderer types. |
| `npm test` | Run repository regression tests. |
| `npm run build` | Check source artifacts and build into `out/`. |
| `npm run build:folder` | Windows x64 folder distribution. |
| `npm run build:win` | Windows installer and self-extracting portable EXE. |
| `npm run build:mac` / `npm run build:linux` | macOS/Linux packaging entry points. |
| `npm run icons` | Generate PNG/ICO icons from `build/brand.svg`. |

The Windows folder build's executable is:

```text
dist/DailyWorkMate-folder/win-unpacked/DailyWorkMate.exe
```

Other distribution artifacts are written to `dist/`. Optional runtimes are bundled only when matching platform resources are available before packaging. See `package.json` for configured formats and architectures.

## Data locations and upgrades

| Data | Location |
| --- | --- |
| Application configuration and accounts | `~/.dailyworkmate/`. |
| UI preferences and conversation databases | Electron's `dailyworkmate` user-data directory, normally `%APPDATA%/dailyworkmate/` on Windows. |
| Folder-build companion data | `companion/` beside `DailyWorkMate.exe`. |
| Self-extracting portable companion data | `companion/` beside its launcher. |
| Installer companion data | `companion/` inside application user data. |
| Development companion data | The checkout's `companion/` directory. |

Quit the app before upgrading and keep existing data directories. Historical settings and conversation migrations preserve their source files. Retain your own `companion/` data when replacing a distribution folder.

Set `DAILYWORKMATE_COMPANION_HOME` to reuse an existing companion directory. For example, in the current PowerShell session:

```powershell
$env:DAILYWORKMATE_COMPANION_HOME = 'D:\DailyWorkMateData\companion'
& 'D:\Apps\DailyWorkMate\DailyWorkMate.exe'
```

This variable overrides only the companion directory, not all configuration and user-data locations. Downloaded runtimes, models and personal data are excluded from Git.

## Common situations

| Situation | What to check |
| --- | --- |
| OpenCode is unavailable | Check that the runtime is installed or that the distribution contains matching platform resources. |
| WSL is missing from the terminal list | Only installed distributions can be offered; check the local WSL installation. |
| An old command does not continue after restart | Ordinary shell restoration recreates tabs, directories and layouts using new processes. Native conversation history is also separate from a running task. |
| A free model reports a limit | Inspect the upstream error, retry later or choose an available model. The app cannot increase upstream quota. |
| Display or graphics-driver problems | Change GPU compositing in Settings and restart the app. |
| Speech resources are missing | Install local speech or select a system voice/speech API. |

## Source layout

`src/main/` contains Electron services, the proxy, agents and terminal hosts; `src/preload/` exposes IPC; `src/renderer/` holds the React UI; `src/shared/` defines shared contracts. Build and checking scripts are in `scripts/`, regression tests in `tests/`, and branding assets in `build/`.
