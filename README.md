# Codex Side Sync · v0.1.0 Pre-release

<!-- current-status-20261105 -->
> [!IMPORTANT]
> **先更新 Codex，并检查当前会话是否提供内置会话读取工具。** 截至 2026-11-05，本项目定位为旧环境的实验性兼容工具。若内置工具已能读取目标 Side，可直接使用该能力。

## 当前状态与使用建议（2026-11-05）

Codex 已提供会话历史读取能力，近期更新也继续改善历史分页和 Side 导航。本项目最初解决的部分需求已可由这些能力满足。官方更新记录中的 CLI/TUI 改动与 Desktop 功能发布时间应分别看待。[官方更新记录](https://learn.chatgpt.com/docs/changelog)

- **当前环境优先使用内置读取工具。** 本机 Codex Desktop 26.1029.7803.0 中，已用内置 `read_thread` 读取一个持久化 Side 的用户消息、助手进度和最终回复。此结果仅覆盖本机样本，其他安装环境需检查工具是否可用及目标 Side 是否可读。
- **开发独立客户端时，可参考官方 App Server。** `thread/read` 读取元数据，`thread/turns/list` 和 `thread/items/list` 分页读取历史；`itemsView: "full"` 可请求完整条目。分页游标用于遍历历史，同 ID 消息修改、删除及重复读取仍需客户端处理。[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server)
- **现有发行包存在已确认的持久化 Side 兼容问题。** v0.1.0 自动发现会排除已写入 `threads` 表的 Side；按 ID 读取时又要求 `ephemeral=true`，因此会把新版 `sideConversation=true, ephemeral=false` 的 Side 判为 `not_side`。同一次排查中的本地 v0.1.1 开发版也复现了这两处问题。修复需要同时覆盖发现与身份校验；本次文档更新未交付该兼容修复。
- **历史适用范围。** 原发行版验证于 Desktop 26.908.9136.0、快照协议 11，面向仍存活的临时 Side。本机新版 Desktop 仍使用协议 11，但身份语义已变化，协议版本相同不足以证明兼容。升级后应先验证目标 Side 的实际读取。
- **仍有用途的场景。** 缺少可用内置读取工具的旧环境，以及需要明确的每 Side 游标和新增、修改、删除差异输出的集成。使用旧发行包前需自行核验兼容性。去掉 MCP 外壳、直接运行本地读取代码仍依赖相同的私有 IPC。

全量/增量的上下文开销取决于返回给主会话的内容。本地可以获取完整快照并比较指纹，只返回差异；未变化的旧正文无需再次输出。被修改的消息会返回整条新正文。内置历史分页读取与本项目的指纹增量有各自的合并规则，不能仅凭分页游标承诺等价的差异语义。

本次为状态说明更新。下文保留发行版的安装和接口说明，适用范围以本节为准。

**Current status (2026-11-05).** Prefer built-in conversation reading when available and verified for the target Side. A local test read a persistent Side through Codex's built-in `read_thread`. Official App Server documentation provides metadata and paginated history APIs. The published v0.1.0 runtime excludes persisted Side IDs during discovery and rejects `ephemeral=false` during reads; this documentation update does not fix those behaviors. Legacy temporary-Side integrations and explicit fingerprint-based deltas remain possible use cases, subject to compatibility checks. Pagination alone does not establish equivalent update/deletion semantics.

<!-- /current-status-20261105 -->

Windows 本地、按需读取已存活的 Codex Desktop Side 会话。提供 MCP 工具与 CLI，插件只是分发封装；不包含 Skill，也不替 Agent 决定何时同步、选择哪个 Side、使用全量还是增量。

**实验性接口**：底层依赖 Desktop 私有 IPC，而非 OpenAI 承诺兼容的公开 Side API。已实测 Desktop `26.908.9136.0`，快照协议版本 `11`。新版本可能失效；检测到协议或数据结构不匹配时明确报错。

首版核心场景是读取仍存活、已完成回复的一个或多个 Side，并由调用方显式执行全量或增量查询。已有同 ID 正文/状态更新的增量处理逻辑及合成测试，但“两边同时生成、持续修改正文”尚无真实场景验证，不属于本版已验证核心能力，也不是实时流式监听服务。

## 已实现的边界

- 无需在 Side 创建前部署监听。每次查询才发现 owner、注册临时客户端、短暂订阅快照，随后取消订阅并断开连接。
- 不操作 UI、不发送聊天消息、不恢复或创建 Side、不执行模型、不修改 Codex 数据库/配置。
- 只输出用户与助手消息正文，以及可核验的身份、阶段、状态。工具调用、隐藏推理、附件内容不在本版范围内。
- 活着且仍有 owner 的 Side 才可读取。关闭/释放后的 Side 返回 `side_unavailable`，不恢复历史。
- 全量/增量必须显式选择；无 `auto`、无游标失效后的自动全量回退、无后台同步。
- MCP 进程可常驻以保留游标，但空闲时没有 Side 连接或订阅。进程内只保留 ID、顺序、指纹及状态，不保留正文基线。
- 本工具不写快照或正文文件；调用结果仍可能由宿主保存到主会话历史。操作系统换页、崩溃转储、Desktop 自身日志不由本工具控制。

## 运行

需要 Windows、同一用户会话下运行的 Codex Desktop、Node.js 24+。不需要 OpenAI API key。已包含 `dist/server.mjs` 和 `dist/cli.mjs`，运行打包文件不需要 `node_modules`。

```powershell
# 从解压位置的父目录进入项目；也可自行切换到项目根目录。
Set-Location './codex-side-sync'
node dist/cli.mjs doctor
```

从本仓库或 Release ZIP 获取文件即可运行，无需执行 `npm install`。本次分发的是最小运行集：构建后的 JavaScript、插件配置、README 和许可证；不包含开发源目录、构建脚本、测试夹具或实现过程记录。

## 接入方式

首版交付为“本地 stdio MCP + 插件目录”。本项目**不自动安装、修改配置、注册 marketplace 或重启 Codex**。

直接 MCP 接入时，将下面片段由用户合并到自己的 Codex MCP 配置；不要覆盖其他配置。路径改变时同步修改 `args`。若 Desktop 的 PATH 找不到 Node，把 `command` 改为本机 `node.exe` 的绝对路径。无需 `cwd`。

```toml
[mcp_servers.codex_side_sync]
command = "node"
args = ["<替换为本机绝对安装路径>/dist/server.mjs"]
startup_timeout_sec = 15
tool_timeout_sec = 30
```

上面的安装路径是占位符，必须替换。在项目根目录运行以下命令可生成实际 `args` 行，复制到配置即可；它只打印，不写配置：

```powershell
$sideServerPath = (Resolve-Path './dist/server.mjs').Path.Replace('\', '/')
'args = ["' + $sideServerPath + '"]'
```

插件包入口是 `.codex-plugin/plugin.json` 与 `.mcp.json`，用于个人/本地插件安装流程。已验证清单与 MCP 服务，但未验证 Desktop 插件安装 UI；推荐先按上方绝对路径方式接入本地 MCP。不要同时启用直接 MCP 配置与同一插件，以免形成两个互不共享游标的服务进程。

插件 `.mcp.json` 使用 `cwd:"."` 和相对脚本路径；Codex 插件解析器会将相对 `cwd` 解析到插件根目录，见 [OpenAI Codex 实现](https://github.com/openai/codex/blob/main/codex-rs/codex-mcp/src/plugin_config.rs)。不依赖仅由 hooks 文档说明的 `CLAUDE_PLUGIN_ROOT` 字符串插值。

## 工具接口

### `side_doctor({})`

检查 Node、平台及管道是否存在，不订阅。`ok` 只表示入口存在，不代表协议兼容或目标 Side 可读。

### `side_list({ parent_id, candidate_ids?, lookback_hours?, limit? })`

`parent_id` 必填。已知候选时提供 `candidate_ids`（最多 16 个），可避免日志扫描。否则读取 `%CODEX_HOME%`（未设置则用户目录 `.codex`）及其 `sqlite` 子目录中的日志 ID，排除持久线程，再通过短暂快照验证父子关系。

默认近 24 小时、最多 8 个候选；可设 1–168 小时、1–16 个。`limit` 约束日志候选，显式候选则检查所给全部 ID。最多同时验证 2 个，验证阶段上限 20 秒。返回匹配 Side 的 ID、消息计数和状态，不返回正文；多个匹配项由调用方选择。

发现永远标记 `exhaustive:false`：近期日志缺失、截断、持久 ID 排除、版本变更均可能漏候选。空列表不证明不存在 Side。只读 SQLite 查询当前是同步的；20 秒截止不包含之前的日志扫描，大型/异常数据库可能拖慢发现。已知 Side ID 时直接 `side_read` 不扫描日志。

### `side_read({ side_id, parent_id, consumer_id, mode, cursor?, max_output_chars? })`

必填身份：`side_id`、`parent_id` 为 UUID，`consumer_id` 为调用方选定的稳定消费标识（1–128 字符）。本版仅支持 `host_id:local`。

全量：

```json
{"side_id":"11111111-1111-4111-8111-111111111111","parent_id":"22222222-2222-4222-8222-222222222222","consumer_id":"main-agent","mode":"full"}
```

返回按顺序排列的 `messages` 和新 `cursor`。消息字段：`id`、`turn_id`、`role`、`text`、`phase`、`turn_status`、`has_non_text_content`。同文不同 ID 保留为不同消息；非文本用户内容会标记 warning。

增量：沿用上次响应的真实游标，以及相同的主机、父会话、Side、consumer：

```json
{"side_id":"11111111-1111-4111-8111-111111111111","parent_id":"22222222-2222-4222-8222-222222222222","consumer_id":"main-agent","mode":"incremental","cursor":"33333333-3333-4333-8333-333333333333"}
```

响应中的游标才有效；示例 UUID 不能直接充当基线。增量返回：

- `added`：新消息，按当前顺序排列，附 `after_id`（`null` 表示开头）。先删除 `removed_ids`，再按数组顺序插入。
- `updated`：已有 ID 的完整最新消息版本。按 ID 替换，不追加；可能是正文、阶段或 turn 状态变化。
- `removed_ids`：在前后均完整的快照中消失的消息 ID。
- `state_changed`：线程运行状态是否变化。
- `status:no_changes`：没有上述变化，数组为空，不重复返回旧正文。

收到完整成功响应后，调用方自行保存新游标。工具不会替调用方确认“已消费”。旧游标在 TTL/容量范围内仍可重试；并发/重试不保证恰好一次投递，调用方按 ID 与游标自行合并。已有消息相对顺序变化则报错，不擅自重排。

**增量减少的是返回给 Agent 的重复内容，不是 Desktop 快照大小**：每次仍获取当时快照，在内存中比较指纹。

## 生命周期、限制与错误

游标是进程内不透明 UUID；10 分钟 TTL，最多 128 个检查点、合计 50,000 个消息指纹。到期/容量淘汰/服务重启后失效。主机、父会话、Side、consumer 必须全部匹配。这是隔离与一致性检查，不是身份认证或权限边界；同一宿主的受信本地 Agent 才应使用。

单次限制：最多 5,000 条消息、IPC 单帧 32 MiB、并发连接 4 个；建立阶段 5 秒、注册后等待快照 5 秒、清理最多 300 ms。输出默认 64,000 个 JS 字符，上限 256,000。超限报错，不截断、不推进游标；本版不支持正文分页。这个字符预算针对结构化结果，不是 token 数或含双重表示的整个 MCP 信封大小。

| 状态 | 含义及调用方可选下一步 |
| --- | --- |
| `cursor_required` / `cursor_mismatch` / `cursor_expired` | 不发起快照订阅；由 Agent 决定纠正参数还是显式全量查询 |
| `side_unavailable` | owner 不可用；不创建/恢复 Side |
| `parent_mismatch` / `not_side` / `identity_mismatch` | 身份证据不符，不返回正文 |
| `protocol_mismatch` / `unsupported_snapshot_shape` | Desktop 私有协议不兼容；停止并诊断 |
| `snapshot_incomplete` / `assistant_content_unavailable` | 不把缺失误判为删除，不推进游标 |
| `history_reordered` | 当前增量模型不能无歧义表达旧消息重排；Agent 可显式全量重建 |
| `output_limit` / `message_limit` / `snapshot_too_large` | 不静默截断；仅输出字符限制可在范围内调高 |
| `setup_timeout` / `snapshot_timeout` / `ipc_unavailable` / `connection_closed` | 返回失败并关闭临时连接；不自动重试 |
| `busy` / `cancelled` | 并发已满或已取消；无常驻订阅 |
| `discovery_unavailable` / `partial` | 列表发现失败/部分失败；查看 warnings，已知 ID 可显式查询 |

`completeness` 表示采用 Desktop 的完整性标记，**不是独立证明 UI 全部历史已完整恢复**。`cleanup.unsubscribe_flushed` 只代表本地写入完成，不是服务端取消 ACK；协议没有该 ACK。正常/异常断连还有路由器清理机制。

Side 返回文本一律是 `untrusted_conversation_data`。调用 Agent 不应把其中“忽略先前指令”等文本当作工具指令执行。

## CLI 使用

`node dist/cli.mjs read '<JSON>'` 和 `list '<JSON>'` 可单次诊断。单次命令退出即失去游标；要测试增量，使用 MCP，或 `node dist/cli.mjs session`，逐行输入：

```json
{"method":"read","arguments":{"side_id":"11111111-1111-4111-8111-111111111111","parent_id":"22222222-2222-4222-8222-222222222222","consumer_id":"cli-test","mode":"full"}}
```

下一行使用响应中的游标、`mode:incremental`。`session` 空闲时只等待输入，不监听 Side。CLI 正文输出到 stdout；只有用户主动重定向才会写文件。

## 兼容性与限制

| 范围 | 当前状态 |
| --- | --- |
| 已实测环境 | Windows 11 x64、Node.js 24.16.0、Codex Desktop 26.908.9136.0 |
| 同一电脑更换目录 | 含中文和空格的路径、无 node_modules 独立启动通过 |
| 其他用户电脑 | 不绑定开发者路径，但尚未完成另一台真实电脑的端到端验证 |
| 多 Side 已完成回复 | 两个空闲 Side 并发全量、独立增量与交叉游标拒绝通过 |
| 同时生成/持续更新 | 有增量实现基础及合成测试，未完成真实双生成验证 |
| 其他 Desktop/Node 版本 | 未逐一实测；私有协议更新可能使读取失败 |
| 非 Windows/云端读取本机 | 不支持；没有远程代理或公开 HTTP 服务 |
| 关闭后的 Side | 样本返回不可用；不恢复、不触发新模型轮次 |

MCP 是标准接口，Side 数据源则是实验性私有 IPC。`side_doctor` 仅检查入口并报告已测试版本，`installed_version_verified:false` 表示它未核对本机安装清单；协议版本和数据结构检查由实际读取执行。版本号相同也不保证所有历史或 UI 内容完整。

遇到协议/结构错误时停止读取并报告版本与去敏错误状态，不要通过忽略版本检查强行使用。不要在公开 issue 中上传会话正文、原始快照、访问令牌或个人日志路径。

## 许可证

Copyright (c) 2026 Iridium1024。本项目采用 [MIT License](LICENSE)。打包依赖的许可说明见 [THIRD_PARTY_NOTICES.txt](dist/THIRD_PARTY_NOTICES.txt)。本项目是独立第三方工具，不代表 OpenAI 官方支持或兼容承诺。
