<p align="center"><img src="build/icon.png" width="112" alt="DailyWorkMate 章鱼与 DWM 图标"></p>

<h1 align="center">DailyWorkMate</h1>
<p align="center">把 AI 助手、工作区和终端放在一起的桌面工作搭档。</p>
<p align="center">简体中文 · <a href="README.md">English</a> · <a href="https://github.com/SecondBrainSystem/DailyWorkMate">GitHub</a> · <a href="LICENSE">GPL-3.0</a></p>

DailyWorkMate 面向每天真正要完成的工作：聊清楚计划，让 AI 在你授权的文件夹中处理任务，再随时切回终端继续操作。你可以接入自己的 AI 服务商或 Ollama 模型，为不同任务选择模型和工作方式。

## 助手：从聊一聊，到开始做

![助手界面与每日计划示例](docs/screenshots/assistant.png)

- **聊天与规划**：流式回复、会话历史、模型选择，默认名称为 **DailyWorkMate**。点击名字旁的铅笔，或进入“角色与语音 → 助手名字”，可以修改并保存自己的名字与角色设定。
- **连接实际工作**：“仅聊天”模式可在已连接工作区、模型支持交接工具时，将文件任务交给工作区代理处理。
- **语音交流**：麦克风输入、自动朗读、全文或摘要朗读，以及音色、语速等设置。本地识别与合成需要安装可选语音资源，也可使用系统语音或兼容语音 API。
- **自己的搭档形象**：内置章鱼、自定义图片，或受支持的 GLB/GLTF 3D 模型。

## 工作区：带着明确的文件范围处理任务

![按项目分组的授权文件夹与读写权限](docs/screenshots/workspaces.png)

从文件管理器把一个或多个本地文件夹直接拖入工作区（也可使用“添加文件夹”），在确认面板里加入已有分组或创建新分组，并分别指定“只读”或“可编辑”。工作区每个标签都是独立代理会话，绑定具体文件夹或分组；模型、引擎和访问范围可见，最近的会话可以重新打开。

| 功能 | 用途 |
| --- | --- |
| 打开目录 | 点击工作区标签栏或授权文件夹旁的文件夹图标，直接在系统文件管理器中打开对应目录。 |
| 文件访问 | 浏览授权目录中的文本文件，把内容加入对话。 |
| 工作区分组 | 一起处理相关目录，也可收窄到某个子目录。 |
| OpenCode | 在应用内运行原生 OpenCode v2 会话，可通过脚本安装运行时。 |
| Claude Code | 使用本机已安装的 CLI，通过应用配置的模型代理工作。 |
| 任务过程 | 查看回答、工具调用、错误和权限请求，停止任务或更换模型。 |

Shell 命令以当前系统用户权限运行。文件夹权限约束代理工具，不等于操作系统沙箱；引擎无法限制更小访问范围时，只读或子目录任务会禁用命令执行。

## Terminal：真正的终端，和任务放在一起

![带 PowerShell 和 CMD 标签的终端](docs/screenshots/terminal.png)

独立的**终端**标签使用真实 PTY 和 xterm.js。Windows 下支持 **PowerShell、CMD 和已安装的 WSL**；选择 OpenCode 时进入绑定授权文件夹的工作会话。

- 多个终端标签同时运行，切换页面时保留进程。
- 拖入文件夹后，选择“在此目录打开终端”或“加入授权工作区”。
- 底部显示当前目录；点击文件夹图标或路径直接打开该目录，执行 `cd` 后跟随更新。支持命令历史、输出复制和窗口缩放。
- 可在启动时恢复未关闭标签；原进程已退出时，会在保存的目录中启动新 Shell。
- 可选择退出界面后仍让终端在后台运行，之后重新连接。后台宿主存活时才保留原进程，重启电脑后不会恢复原进程。

以上截图来自实际应用界面，使用虚构演示数据；终端连接了真实本地 PowerShell。不包含个人账号或私人对话。

## 模型与接入

应用提供供应商与账号管理、官方 API Key 预设、Ollama 节点、模型映射、请求日志和本地 OpenAI 兼容代理。独立 AI 对话页支持任务提示词和翻译目标语言。OpenCode 免费模型目录由服务商动态提供，可用性和配额可能变化。

先添加供应商或 Ollama 节点，再到助手中选择模型。图像、思考和工具能力取决于实际模型与服务商。语音接口单独配置，聊天接口不能直接当作语音接口使用。

内置默认模型及各渠道限制见[供应商参考](docs/providers/README.md)。

## Windows 使用

**日常推荐文件夹式免安装版。** 保留整个文件夹，运行 `DailyWorkMate.exe`。旁边的 DLL 和 `resources/` 都是程序的一部分，不要单独拿走 EXE。文件夹版无需像单文件 portable 那样每次启动重新解压。

本地构建：

```powershell
git clone https://github.com/SecondBrainSystem/DailyWorkMate.git
cd DailyWorkMate
npm ci
npm run build:folder
```

产物：`dist/DailyWorkMate-folder/win-unpacked/DailyWorkMate.exe`。OpenCode 和语音资源只有在打包前安装好对应平台版本，才会包含在产物中。

## 开发与打包

需要 **Node.js 22.18+**、npm 和 Git。原生依赖没有可用预编译包时，还需要对应平台的构建工具。

```bash
npm ci
npm run dev:win       # Windows
npm run dev           # macOS / Linux
npm run typecheck
npm test
npm run build
```

| 命令 | 用途 |
| --- | --- |
| `npm run build:folder` | Windows x64 文件夹式免安装版。 |
| `npm run build:win` | Windows 安装版与自解压 portable EXE。 |
| `npm run build:mac` / `npm run build:linux` | 其他平台打包。 |
| `npm run companion:setup` | 下载支持的 OpenCode 运行时。 |
| `npm run companion:speech:setup` | 安装可选[本地语音资源](docs/speech.md)。 |
| `npm run icons` | 从[可编辑 SVG](build/brand.svg)生成 PNG 与多尺寸 ICO。 |

当前桌面验收以 Windows 为主。项目包含 macOS、Linux 构建配置，但终端类型与运行时取决于平台，不代表全部 Windows 功能已在其他系统实测。

## 数据与升级

- 应用配置和账号：`~/.dailyworkmate/`。
- 界面偏好和对话数据库：Electron 的 `dailyworkmate` 用户数据目录。
- 文件夹版助手数据：EXE 旁的 `companion/`；安装版位于用户数据目录，开发模式位于项目的 `companion/`。
- 设置 `DAILYWORKMATE_COMPANION_HOME` 可以继续使用已有助手目录，例如旧 portable EXE 旁的 `companion` 文件夹。
- 升级导入旧配置和历史，保留原始文件。旧加密标识及环境变量别名仅用于兼容读取。

下载的运行时、模型、个人数据和内部规划记录不提交到 Git。请求发送到你选择的服务商，桌面应用不等于模型也在本地运行。

## 代码结构

`src/main/` 是 Electron 服务、代理和终端宿主；`src/preload/` 提供 IPC 桥接；`src/renderer/` 是 React 界面；`src/shared/` 存放共享类型。构建与检查脚本在 `scripts/`，回归测试在 `tests/`，品牌文件在 `build/`。

## 许可证与致谢

GPL-3.0，参见 [LICENSE](LICENSE) 和记录项目来源的 [NOTICE](NOTICE)。Electron、OpenCode、Claude Code 及可选语音组件是独立项目，分别遵循各自许可证和使用要求；运行时安装脚本保留对应第三方声明。
