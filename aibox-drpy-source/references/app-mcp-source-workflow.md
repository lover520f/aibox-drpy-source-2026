# AIBOX Studio MCP 写源与真机验收

本页只适用于影视、小说、漫画和 BT 的 DS/JS 源。先按用户要求确定交付边界：只诊断、完成草稿、提交到 App、管理已有源，或提交后分享。不要把“可调用工具”当成额外授权。源语法、内容类型和站点证据仍按本 Skill 的对应手册处理。

源的 helper/npm/WASM/coreJS 缺失，或需要修改公共引擎 JS 时，先读[依赖准备与引擎维护](engine-dependencies.md)。本地隔离准备、原包和完整基线备份、`aibox.engine.*` 草稿上传/验证/提交，以及干净本地候选同步是一条独立流程；引擎静态 validate 不等于源真机 L3。

## 连接与目标确认

1. 在 App 的“设置 → AIBOX Studio”查看实际 MCP 地址和认证模式。电脑连接手机时用手机局域网 IP；`127.0.0.1` 只代表发起连接的设备，除非已明确设置 adb 转发。
2. 使用当前客户端已有的 Streamable HTTP MCP 连接；Codex、Claude Code 的配置示例见[命令示例](command-examples.md#15-连接-app-内置-mcp)。端口监听或 adb 转发存在，不等于 Studio 已响应。若本轮没有可调用的 AIBOX MCP 工具，先说明连接步骤，再继续能独立完成的本地证据收集和 CLI 检查。
3. 初始化并实际列出工具；读取 `aibox.device.info`、`aibox.permissions.get`、`aibox.device.health`。确认设备与 App 版本；真机运行须检查 `engine.running`、`engine.reachable`、`engine.healthy`，不要仅凭顶层 `healthy` 判断引擎已启动。引擎任务已停时，源文件管理仍可用；需要真机运行的测试须等用户在 App 启动任务。
4. 只调用当前连接实际公布的工具。iOS 的后台连接受 App 生命周期影响；断线后重新确认设备和会话，不复用旧工作区 ID。

配对模式由用户在 App 生成一次性配对码，通过 `POST /api/studio/pair` 换取短期 Token。Token 只在安全凭据或客户端进程环境中传递；不得放入 URL、源码、日志、聊天正文或仓库。重新配对后让 MCP 客户端更新凭据并重连。

## 识别和读取源

`aibox.source.list` 返回每项的 `sourceKey`、`module`、内容类型等信息：`sourceKey` 用于源文件和工作区工具，`module` 用于正式源的 `aibox.runtime.*`、`aibox.setup.*` 和 `aibox.source.actions.*`。不要把显示名称、文件名、`module` 与 `sourceKey` 混用。

已有源先用 `aibox.source.read` 读取代码与原始源码 ETag；大文件或客户端截断工具输出时，用 `offset: 0, maxBytes: 8192` 开始，随后每次把 `offset` 设为返回的 `nextOffset`，直到 `complete: true`。`aibox.source.workspace.read` 也按此规则续读。任何单次返回不完整时不得把当前块当成完整源码；偏移必须是服务端返回的 UTF-8 边界。返回的 `redacted: true` 表示代码已经脱敏，`etag` 仍对应 App 内原始源码，不能拿脱敏文本计算 SHA-256 后与它比较。

## 隔离草稿与并发编辑

- 修改已有源：`aibox.source.workspace.open({"sourceKey":"spider/js/example.js"})`。新建源：`aibox.source.workspace.create({"filename":"example.js","code":"var rule = { title: 'Example', host: 'https://example.org' };"})`。两者返回 `workspaceId` 和 `draftEtag`；正式源此时未改变。
- 编辑时调用 `aibox.source.workspace.patch`，参数为 `workspaceId`、最新 `expectedDraftEtag`，以及完整 `code` **或** `patches`。定点补丁形如 `{"find":"旧的唯一片段","replace":"新的片段"}`；仅明确需要替换全部匹配处时才用 `replaceAll: true`。每次成功后使用新返回的 `draftEtag`。
- 若 `redacted: true`，工作区内部仍保留原值。只对能准确定位、且不包含脱敏凭据的片段使用 `patches`；禁止将 MCP 返回的脱敏源码作为完整 `code` 写回。需要迁移或修改敏感值时，声明 `more.aibox.setup`，由用户在 App 完成敏感输入。
- 提交前调用 `aibox.source.workspace.diff`；若 `truncated: true`，用 `workspace.read` 分块复核完整的可见草稿。脱敏部分仍不能被 MCP 完整复核，交付时说明这个边界。
- `DRAFT_CONFLICT`：重新读取工作区及 ETag，再重放当前修改；`SOURCE_CONFLICT`：重新打开正式源并合并；`WORKSPACE_NOT_FOUND`：工作区可能过期、断线或属于另一客户端。均不得强制覆盖。

## L1/L2/L3 与按需运行测试

对**完整且未脱敏**的本地候选文件，先在 Skill 根目录运行 `node scripts/aibox-skill-cli.mjs lint --code-file <路径>`，检查 AST、重复键和源契约。App 的 `aibox.validation.l1({"workspaceId":"..."})` 主要做结构与风险扫描，不能代替本地 AST；如果拿不到完整原文，就把 AST 项标为未验证。

草稿使用 `aibox.validation.l1/l2/l3`，至少传 `workspaceId`；L2 可传真实搜索词 `keyword`。L2/L3 会在 App 引擎中临时加载草稿，测试后清理临时模块，不要求先提交正式源。每次同时检查 MCP `isError` 和结构化结果 `success`：工具调用本身成功，不代表测试通过。

- L1：逐条检查 `summary.diagnostics` 的错误与警告。
- L2：检查 `summary.stages` 中实际执行的首页、分类、详情、搜索、播放/正文及各自的 `success`。当前实现会跳过没有取得输入 ID 的后续阶段，且搜索失败不会使汇总 `success` 自动变为 false；缺失或失败的阶段必须单独记录，不能仅看汇总布尔值。
- L3：检查 `evidence` 是否以真实 `class_id → vod_id → 剧集/章节 ID` 串联，并检查图片探测、小说正文长度及 `warnings`。返回嗅探警告时，只能确认规则链路，不能声称拿到最终媒体直链。L3 是代表性链路测试，不代表每个分类、线路和分页都已覆盖。

需要补充正式源诊断时，可使用 `aibox.runtime.refresh`、`aibox.runtime.home`、`aibox.runtime.category`、`aibox.runtime.search`、`aibox.runtime.detail`、`aibox.runtime.play`、`aibox.runtime.reader`；先从 `aibox.source.list` 取得 `module`，再使用上游真实返回的 `tid`、`id`、`url`。源声明的动作先用 `aibox.source.actions.list` 查看；导航动作只返回目标，`aibox.source.actions.invoke` 仅在用户要求执行该动作时调用。

用户要求管理已有源时，先用 `aibox.source.list` 确认 `sourceKey` 和目标，再按请求调用 `aibox.source.rename({"sourceKey":"...","name":"...","groupTag":"..."})`、`aibox.source.toggle({"sourceKey":"...","enable":false})` 或 `aibox.source.delete({"sourceKey":"..."})`。随后重新读取源列表并检查 `aibox.audit.list` 的脱敏记录；删除误操作仅能在当前 Studio 会话的回滚能力允许时恢复。

若获许可，可先用 `aibox.logs.status` 确认 drpy 采集和 MCP 读取权限，再用 `aibox.logs.list/wait` 定位真机报错；不得自行开启采集或读取其他来源日志。`aibox.setup.schema/status/preferences.get/validate` 可检查配置声明与非敏感偏好；`aibox.setup.apply` 只写非敏感字段，`USER_ACTION_REQUIRED` 交还 App 处理。

## 提交、回读和交付

仅当用户要求正式保存，且必需阶段有足够证据时，按最新 ETag 调用 `aibox.source.workspace.commit({"workspaceId":"...","expectedDraftEtag":"...","share":false})`。不要用 `share:true` 跳过提交后的检查。提交后用返回的 `sourceKey` 调 `aibox.source.read`：比较提交 ETag 与读回 ETag；仅当 `redacted: false` 且已读到 `complete: true` 时，再计算客户端源码 SHA-256 与 ETag 比对。脱敏时只能核对服务端 ETag 一致，不能声称已独立验证原始字节。

引擎正在运行时，再从 `source.list` 获取正式 `module`，执行 `aibox.runtime.refresh` 与至少一个首页/关键链路冒烟测试。若正式源行为与草稿验收不同，先报告差异；符合用户当前请求时，可用 `aibox.source.workspace.rollback` 撤销本次会话的提交。只有用户要求分享且提交回读成功后，才调用 `aibox.share.publish`。

交付时列出源类型、保存范围、L1/L2/L3 每一层实际执行的阶段、真实 ID 链路、警告、回读校验方式和剩余未验证项目。MCP 未连接、引擎未运行或仅完成本地 CLI 检查时，明确区分这些状态，不报告“真机通过”。
