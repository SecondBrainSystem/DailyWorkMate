<p align="center"><img src="build/icon.png" width="112" alt="DailyWorkMate octopus and DWM logo"></p>

<h1 align="center">DailyWorkMate</h1>
<p align="center">An AI assistant, your workspaces, and a terminal — together on your desktop.</p>
<p align="center"><a href="README_CN.md">简体中文</a> · English · <a href="https://github.com/SecondBrainSystem/DailyWorkMate">GitHub</a> · <a href="LICENSE">GPL-3.0</a></p>

DailyWorkMate is a desktop companion for everyday work. Talk through a plan, let an AI agent work with folders you authorize, and keep your terminal sessions close at hand. Connect your AI providers or Ollama models and choose the model and working mode for each task.

## Assistant

![Assistant with a sample daily plan](docs/screenshots/assistant.png)

- **Chat and plan:** streaming replies, conversation history, model selection, and an editable assistant name and persona.
- **From conversation to action:** chat-only mode can hand file tasks to a workspace agent when a workspace is connected and the model supports the handoff tool.
- **Voice:** microphone input, optional spoken replies, full or summarized reading, and voice settings. Local recognition and synthesis require the optional speech resources; system voices and compatible speech APIs are also supported.
- **Your companion:** the included octopus, a custom image, or a supported GLB/GLTF avatar with a 3D viewer.

## Workspaces

![Authorized folders and read/edit permissions](docs/screenshots/workspaces.png)

Authorize folders, group related directories, and choose **read only** or **can edit** access. Each Work tab is a separate agent session bound to a folder or group, with its model, engine and scope visible. Recent sessions can be reopened.

| Feature | Purpose |
| --- | --- |
| File browser | Browse authorized text files and attach their contents to a conversation. |
| Folder groups | Work across related folders, or narrow a task to one subfolder. |
| OpenCode | Use a native OpenCode v2 session inside the app; install the optional runtime with the setup script. |
| Claude Code | Use a locally installed Claude Code CLI through the configured model proxy. |
| Task visibility | Follow responses, tools, errors and permission requests; stop tasks or change models. |

Shell commands run with your operating-system account's permissions. Folder rules constrain agent tools; they are not an OS sandbox. Read-only and subfolder scopes disable commands where the engine cannot enforce a narrower boundary.

## Terminal

![PowerShell and CMD terminal tabs](docs/screenshots/terminal.png)

The **Terminal** tab is a real PTY terminal with xterm.js. On Windows it supports **PowerShell, CMD and installed WSL distributions**. Choosing OpenCode opens a folder-bound Work session.

- Keep multiple terminal tabs open and switch views without restarting their processes.
- See the current directory on each tab; use normal shell history, copy output, and resize the terminal.
- Restore unclosed tabs at startup. If their processes have exited, restoration starts new shells in the saved directories.
- Optionally keep terminals running after the app closes and reattach later. Live process continuity lasts while the background host is alive, and does not survive a reboot.

Screenshots show the real application with fictional demonstration data. The terminal capture uses a real local PowerShell process. No personal accounts or conversations are included.

## Models and integrations

DailyWorkMate includes provider/account management, official API-key presets, Ollama nodes, model mappings, request logs and a local OpenAI-compatible proxy. The separate AI Chat page supports task prompts and translation target languages. OpenCode's free-model catalog is provided dynamically; availability and quotas may change.

Configure a provider or Ollama node first, then select a model in the assistant. Image, reasoning and tool support depend on the selected provider/model. Speech endpoints are separate from chat endpoints.

See the [provider reference](docs/providers/README.md) for built-in model defaults and provider-specific limitations.

## Run on Windows

**Prefer the folder distribution for everyday use.** Keep the entire folder and run `DailyWorkMate.exe`; its DLLs and `resources/` must stay alongside it. Unlike a single-file portable EXE, this starts without unpacking the application on every launch.

Build from source:

```powershell
git clone https://github.com/SecondBrainSystem/DailyWorkMate.git
cd DailyWorkMate
npm ci
npm run build:folder
```

Output: `dist/DailyWorkMate-folder/win-unpacked/DailyWorkMate.exe`. Optional runtimes are bundled only when set up for the target platform before packaging.

## Development

Requires **Node.js 22.18+**, npm and Git. Native dependencies may require platform build tools if compatible prebuilt binaries are unavailable.

```bash
npm ci
npm run dev:win       # Windows
npm run dev           # macOS / Linux
npm run typecheck
npm test
npm run build
```

| Command | Purpose |
| --- | --- |
| `npm run build:folder` | Windows x64 folder distribution, without per-launch extraction. |
| `npm run build:win` | Windows installer and self-extracting portable EXE. |
| `npm run build:mac` / `npm run build:linux` | Other platform packages. |
| `npm run companion:setup` | Download the supported OpenCode runtime. |
| `npm run companion:speech:setup` | Install optional [local speech resources](docs/speech.md). |
| `npm run icons` | Generate PNG/ICO assets from the [editable SVG](build/brand.svg). |

Windows is the currently exercised desktop target. macOS/Linux build configurations exist, but shell choices and bundled runtimes depend on the platform; Windows feature validation does not imply validation elsewhere.

## Data and upgrades

- Configuration and accounts: `~/.dailyworkmate/`.
- UI preferences and conversation databases: Electron's `dailyworkmate` user-data directory.
- Folder-distribution companion data: `companion/` next to the EXE. Installer builds use user data; development uses the project's `companion/` directory.
- Set `DAILYWORKMATE_COMPANION_HOME` to reuse an existing companion directory, such as the `companion` folder beside a previous portable EXE.
- Upgrades import old settings and history while preserving the originals. Legacy encryption identifiers and environment aliases remain for compatibility.

Downloaded runtimes, models, personal data and internal planning records are excluded from Git. Requests go to the providers you select; a desktop client does not make a remote model local.

## Source layout

`src/main/` contains Electron services, agents, terminals and the proxy; `src/preload/` exposes IPC; `src/renderer/` holds the React interface; `src/shared/` defines shared contracts. `scripts/` contains builds and checks, `tests/` holds regression coverage, and `build/` contains branding assets.

## License

GPL-3.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for attribution. Electron, OpenCode, Claude Code and optional speech components are separate projects with their own licenses and requirements; runtime setup preserves their notices.
