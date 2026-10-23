# DailyWorkMate 安装指南

[返回功能介绍](../README_CN.md) · [English](installation.md)

这里集中介绍程序运行、源码安装、打包、可选组件和数据迁移。

## 选择运行方式

| 方式 | 使用方法 |
| --- | --- |
| **Windows 文件夹版** | 日常使用推荐。保留整个文件夹，运行其中的 `DailyWorkMate.exe`，无需每次解压程序。 |
| **Windows 安装版** | 运行对应版本的 setup EXE，按向导安装并创建快捷方式。 |
| **Windows portable EXE** | 单文件启动入口，运行时可能需要先解压程序。 |
| **源码运行** | 安装开发依赖，自行运行或构建分发包。 |

如果[发布页](https://github.com/SecondBrainSystem/DailyWorkMate/releases)提供所需版本和平台的产物，可直接使用；没有对应产物时从源码构建。文件夹版的 DLL、`resources/` 等必须与 EXE 保持在一起。

当前桌面与可选运行时验收以 Windows x64 为主。项目有 macOS/Linux 打包配置，但终端类型、原生依赖和运行时支持取决于平台，尚不能视为与 Windows 完全等效。

## 从源码安装与运行

准备 **Node.js 22.18 或更新版本**、npm 和 Git。原生依赖没有可用预编译包时，需要对应平台的编译工具；Windows 通常涉及 Python 和 Visual Studio C++ Build Tools。

```bash
git clone https://github.com/SecondBrainSystem/DailyWorkMate.git
cd DailyWorkMate
npm ci
```

Windows 开发模式：

```powershell
npm run dev:win
```

macOS/Linux 开发入口：

```bash
npm run dev
```

本地运行已构建程序：

```bash
npm run build
npm run preview
```

## 可选组件

### OpenCode 工作区运行时

在源码项目目录运行：

```bash
npm run companion:setup
```

脚本联网安装项目指定的 OpenCode v2 并检查版本，资源位于 `companion/runtime/opencode-v2/`。当前安装脚本使用 Windows 可执行文件，请勿将它视为通用的 macOS/Linux 安装器。

原生 OpenCode 功能需要可用运行时；普通模型接入和兼容 API 服务可独立配置。如需随分发包提供运行时，应在打包前安装匹配平台的资源。

### Claude Code

使用本机已安装、可被应用找到的 Claude Code CLI；OpenCode 安装脚本不会安装 Claude Code。在工作区选择对应引擎并配置兼容模型连接。CLI 的安装、认证和使用要求以其自身文档为准。

### 本地语音

```bash
npm run companion:speech:setup
```

这是可选下载，包含较大的识别与合成资源，当前安装流程已在 Windows x64 使用。打包前安装可随匹配平台的程序分发；第三方声明随资源保留，见[语音指南](speech.md)。

在助手“角色与语音”中选择语音来源。麦克风输入需要系统权限；不安装本地资源时，可使用可用的系统声音或单独配置兼容语音 API。聊天与语音接口分别配置。

## 首次配置

1. 在“模型接入”添加供应商/API 账号或 Ollama 节点；也可刷新并选择支持的免费模型。
2. 在助手或 AI 对话中选择模型。工作区任务还需要相应的工具能力。
3. 使用工作区时添加授权文件夹，确认只读或可编辑范围，再选择引擎打开会话。
4. 其他客户端需要接入时，在“API 服务”检查监听地址、本地 API Key 并启动服务。默认 OpenAI 兼容地址为 `http://127.0.0.1:11434/v1`；修改端口后以界面显示为准。
5. 发起请求后，在“用量监控”查看已经记录的用量和请求日志。

免费模型的可用性和额度由上游决定，目录可见不代表当下有可用额度。协议、模型名称与连接验证见[免费模型连接](free-models.md)及[供应商参考](providers/README.md)。

## 构建与检查

| 命令 | 用途 |
| --- | --- |
| `npm run typecheck` | 检查主进程、预加载与前端类型。 |
| `npm test` | 运行仓库回归测试。 |
| `npm run build` | 检查源码产物并构建到 `out/`。 |
| `npm run build:folder` | Windows x64 文件夹版。 |
| `npm run build:win` | Windows 安装版与自解压 portable EXE。 |
| `npm run build:mac` / `npm run build:linux` | macOS/Linux 打包入口。 |
| `npm run icons` | 从 `build/brand.svg` 生成 PNG 与 ICO 图标。 |

Windows 文件夹版主程序：

```text
dist/DailyWorkMate-folder/win-unpacked/DailyWorkMate.exe
```

其他分发产物位于 `dist/`。可选运行时只有在打包前准备好匹配平台资源，才会包含在产物中；安装包格式和架构以 `package.json` 为准。

## 数据位置与升级

| 数据 | 位置 |
| --- | --- |
| 应用配置与账号 | `~/.dailyworkmate/`。 |
| 界面偏好、对话数据库 | Electron 的 `dailyworkmate` 用户数据目录，Windows 通常为 `%APPDATA%/dailyworkmate/`。 |
| 文件夹版助手数据 | `DailyWorkMate.exe` 旁的 `companion/`。 |
| 自解压 portable 助手数据 | portable 启动文件旁的 `companion/`。 |
| 安装版助手数据 | 应用用户数据目录下的 `companion/`。 |
| 开发模式助手数据 | 项目内的 `companion/`。 |

升级前退出应用，保留现有数据目录。历史配置与对话的迁移保留源文件；替换分发包时也应保留自己的 `companion/` 数据。

可通过 `DAILYWORKMATE_COMPANION_HOME` 指定已有助手目录。例如，在 PowerShell 当前会话中：

```powershell
$env:DAILYWORKMATE_COMPANION_HOME = 'D:\DailyWorkMateData\companion'
& 'D:\Apps\DailyWorkMate\DailyWorkMate.exe'
```

该变量只覆盖助手目录，不改变全部配置和用户数据位置。下载的运行时、模型和个人数据不提交到 Git。

## 常见情况

| 情况 | 处理方法 |
| --- | --- |
| OpenCode 不可用 | 检查运行时是否已安装，或分发包是否包含匹配平台的资源。 |
| 终端缺少 WSL | 终端只列出本机已安装的发行版；先检查 WSL 安装情况。 |
| 重启后旧命令没有继续 | 普通 Shell 恢复标签、目录和布局，会启动新进程；原生工作会话记录与正在执行的任务也是不同状态。 |
| 免费模型报告额度限制 | 查看上游错误，稍后重试或切换可用模型；本地应用无法增加上游额度。 |
| 显示或显卡驱动问题 | 在设置中调整 GPU 合成选项并重启应用。 |
| 语音资源缺失 | 安装本地语音资源，或切换系统声音/语音 API。 |

## 开发目录

`src/main/` 包含 Electron 服务、代理、代理引擎与终端宿主；`src/preload/` 提供 IPC；`src/renderer/` 是 React 界面；`src/shared/` 存放共享类型。构建与检查脚本在 `scripts/`，测试在 `tests/`，品牌资源在 `build/`。
