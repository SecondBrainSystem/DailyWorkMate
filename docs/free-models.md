# 免费模型连接

助手聊天和 AI 对话共享 Kilo 免费模型来源，OpenCode 官方免费模型保留现有原生运行时入口。公共 server 同时支持 OpenCode 与 Kilo 免费模型转发，无需添加免费模型账号。

| 来源 | 模型目录 | 推理方式 |
| --- | --- | --- |
| OpenCode | 官方在线列表与 models.dev 零价格条目的交集 | 桌面使用 OpenCode v2 原生运行时；公共代理直连 `/inference/v1/chat/completions` |
| Kilo | `https://api.kilo.ai/api/gateway/models` 的 `isFree: true` 文本模型 | 主进程请求 `https://api.kilo.ai/api/gateway/chat/completions`，不携带账号或 Key |

Kilo 模型以 `kilo-free/<upstream-id>` 保存，避免与配置模型重名；支持 `kilo-auto/free` 等上游明确标记的免费路由。模型列表与能力均来自上游，代码不保存静态模型名单。目录内存缓存 15 分钟，失败后普通请求冷却 30 秒，手动刷新可立即重试。目录过期或刷新失败后停止生成，不回退到缓存中的免费资格，也不自动换模型。模型列表响应单独携带 Kilo 状态，其他配置模型仍可选择。

AI 对话的普通聊天通过内部 IPC 推理服务调用 Kilo，不依赖公开代理监听端口。助手保留对话中选择的引擎：纯聊天走内部推理；OpenCode v2/Claude Code 工作区引擎使用受鉴权的私有兼容桥接。工作区仍受原有目录授权与工具执行策略约束；不支持工具的模型会明确报错。桌面 OpenCode 免费模型继续走原生入口，公共 API 则使用独立协议适配层。

## 通过本地 11434 转发

运行更新后的应用并启动本地代理（默认 `127.0.0.1:11434`），外部客户端即可访问。应用内 IPC 聊天本身不会启动公共监听；旧安装包需更新后才包含这些路由。

| 客户端接口 | 地址与模型 |
| --- | --- |
| OpenAI 兼容 Base URL | `http://127.0.0.1:11434/v1` |
| 模型发现 / 对话 | `GET /v1/models` / `POST /v1/chat/completions` |
| Ollama 兼容 | Base URL `http://127.0.0.1:11434`，`GET /api/tags`、`POST /api/show`、`POST /api/chat` |
| Anthropic 兼容 | `POST /v1/messages` |
| 模型名 | 从列表取完整 ID：`opencode-free/<id>` 或 `kilo-free/<id>` |

流式与非流式均可使用。本地鉴权开启时，填写应用中创建的代理 API Key（`Authorization: Bearer <本地 Key>` 或 `X-API-Key`）；Key 不会转发给免费上游。本地鉴权关闭时，本机回环请求可不带 Key，来自其他设备的请求仍要求有效 Key。无需在免费供应商处申请个人 Key。

PowerShell 示例（把模型名替换成当前 `/v1/models` 返回的值）：

```powershell
$base = 'http://127.0.0.1:11434'
$headers = @{ Authorization = 'Bearer <应用中的本地代理 Key>' }
Invoke-RestMethod "$base/v1/models" -Headers $headers
$body = @{
  model = 'opencode-free/deepseek-v4.1-flash-free'
  messages = @(@{ role = 'user'; content = 'Reply with only OK.' })
  stream = $false
  max_tokens = 256
  session_id = 'my-conversation-1'
} | ConvertTo-Json -Depth 6
Invoke-RestMethod "$base/v1/chat/completions" -Method Post -Headers $headers -ContentType 'application/json' -Body $body
```

`GET /v1/models` 和 `/api/tags` 共享目录，返回各来源的独立状态；某一来源失败只移除该来源的过期条目。请求头 `X-Refresh-Free-Models: true` 可强制刷新。详情路径中的完整模型 ID 需 URL 编码。

### 将全部 API 请求统一到免费模型

进入 **Ollama 节点 → 全局模型路由**，点击“刷新免费模型”，从 **OpenCode Free** 或 **Kilo Free** 分组选择模型，然后打开“强制使用指定模型”。保存即时生效，不需要添加 Ollama 节点或账号；免费模型列表通过内部 IPC 加载，不依赖公共端口是否启动。外部调用仍需启动本地代理。

启用后，公共 OpenAI Chat/Completions、Ollama `/api/chat` 和 Anthropic `/v1/messages` 请求统一转到所选模型，包括客户端指定了另一免费模型的情况。关闭后恢复按客户端模型路由。桌面内部推理始终使用聊天界面中的明确选择；公共调用只有显式发送 `X-DailyWorkmate-Model-Selection: explicit` 时才跳过全局覆盖。

免费来源不使用 Ollama 的自动 URL 或固定节点设置，切换到免费模型时清除固定节点 ID。来源目录失效会显示独立错误并保留已保存的模型，不自动替换为其他模型；生成失败或限流也不会回退。切回 Ollama 模型后可继续配置节点选择。

### 保留客户端请求模型与测试路由

打开“路由原始请求模型”后，客户端请求的模型不会被全局指定模型替换。Ollama 请求仍可选择固定节点，或自动选择支持该模型的节点；模型不可用时返回错误，不回退到保存的强制模型。带 `opencode-free/` 或 `kilo-free/` 前缀的请求继续走对应免费服务。两种路由开关互斥，切换不会丢失已保存的强制模型；两个开关都关闭时使用常规供应商路由。

“测试路由”按照已保存的设置发送一条简短生成请求，显示请求模型、实际模型、来源、耗时和回复或错误。原始模型模式需要填写客户端模型名；强制模式可留空，也可填写任意客户端别名来确认覆盖。测试通过内部调度执行，不检查公开端口是否已监听。

### 首次使用也遇到限流

两条免费通道均连接官方服务，没有经过额外的第三方中转。Kilo 使用匿名访问，OpenCode 公共代理使用官方公共凭据 `public`，均不代表一个独享的个人免费额度。

截至 2026-10-22，[Kilo 官方说明](https://kilo.ai/docs/gateway/usage-and-billing)规定免费请求（包括已认证请求）按公网 IP 限制为每小时 200 次。因此共享网络出口可能导致首次使用本应用也收到 429。[OpenCode 官方 FAQ](https://opencode.ai/go)说明免费层有每日 200 次请求配额；仅凭 `Free usage limit reached` 无法判定某个用户的具体计数或恢复时间。

应用会保留上游原始错误和 `Retry-After`，并把免费限制解释为上游限制，不再笼统显示“操作未完成”。上游限制无法在本地重置；等待恢复或选择其他已配置的服务。刷新模型目录仅更新可用模型，不会重置使用额度。

OpenCode 公共代理目前支持目录中 `chat-completions` 协议的免费模型。未来若目录增加 Responses 或 Messages 专用模型，它们仍保留桌面原生入口，公共目录暂不广播，明确指定时返回不支持协议错误。模型列表和免费价格判断仍以官方来源为准，禁止按名称猜测免费资格。

OpenCode 适配层参考 `dsh-our-free-model` 的 v2 兼容协议：固定官方端点、`Bearer public`、v2 User-Agent、四个同值会话头、官方 `read` / `shell` 工具定义。代码保留参考来源与 MIT 声明。会话优先使用 `X-OpenCode-Session-Id` / `X-OpenCode-Session` / `X-Session-Id` 或 `session_id` / `sessionId`，否则以首条用户消息及本地客户端身份派生稳定会话；重试不轮换会话。没有客户端工具时附加的工具仅用于协议声明，返回这些调用会明确失败；代理不读取文件或执行命令。调用方同名工具会别名化并同步历史、`tool_choice`，响应侧完整还原；工具片段在名称校验后返回，普通正文保持流式。

上游 403/429 与目录错误会返回客户端，不自动更换来源或模型；429 保留可解析的 `Retry-After`。协议指纹可能随上游更新，不能保证所有模型持续可用。

Kilo 请求只转发支持的标准参数，限制输出预算并校验图片、工具和思考能力。思考控制转换为 `reasoning`；部分模型强制思考，上游拒绝关闭时保留错误。免费通道没有实现联网搜索或深度研究。流式解析按响应内容判断 SSE/JSON，支持拆分的 UTF-8、思考字段、工具调用与用量尾包；空流、中断和上游错误不会标记为成功。停止会取消目录等待或上游请求。共享目录刷新不会被单个请求取消。

Kilo 免费池上游可能记录提示词并用于改进服务；两个页面在选中 Kilo 时显示说明。免费服务的限额和可用性由上游决定。当前验证不代表所有列出的模型均已逐一实测。

实现参考：[dsh-our-free-model Kilo 调用](https://github.com/Ebony-Vinyl/dsh-our-free-model/blob/main/src/kilo.js)、[OpenCode 调用](https://github.com/Ebony-Vinyl/dsh-our-free-model/blob/main/src/upstream.js)。

验证入口：

- `node --test tests/inference/kilo-free.test.mjs tests/inference/direct-dispatch.test.mjs tests/inference/model-connection.test.mjs`：离线目录、调用、错误、取消和工作区连接回归。
- `node --test tests/inference/opencode-free.test.mjs tests/proxy/free-model-http.test.mjs`：OpenCode 会话/工具适配及两来源公共 HTTP 鉴权、目录、协议、日志与失败隔离。
- `node scripts/check-free-proxy-live.cjs --port 11434`：临时使用真实公共服务路由和隔离存储，分别验证两来源流式与非流式；端口占用时失败，不替换正在运行的服务。默认不传 `--port` 时使用系统分配的临时端口，结果保存在 `tmp/qa/free-proxy-live-*/report.json`。
- 加上 `--force-routing` 验证客户端占位模型名被全局路由替换；`--source opencode` 或 `--source kilo` 可单独验证一个来源。构建后用 Electron 运行 `scripts/check-ollama-ui.cjs` 验证分组、保存、无节点、目录失败恢复和窄屏/明暗主题。
- `node scripts/check-kilo-live.cjs`：显式在线检查，仅向当前免费模型发送固定的 `Reply with only OK.`，验证流式与非流式输出，证据写入 `tmp/qa/kilo-live-*/report.json`。
- 构建后用 Electron 运行 `scripts/check-workspace-chat-ui.cjs`：两个页面的模型分组、发送、目录失败恢复及明暗/窄屏界面验收。
