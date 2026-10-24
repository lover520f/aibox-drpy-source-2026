# Aibox 写源能力映射

本 Skill 将旧 Aibox MCP 和历史 CLI 的能力收口为一条本地工作流：

```text
resources -> doctor -> hiker-import/triage -> templates/resolved -> compose -> lint -> check -> heal -> save -> share
```

## 主能力

| 目标 | 新主命令 | 旧 MCP/CLI 来源 |
|---|---|---|
| 知识、示例与模板读取 | `resources list/read` | `list-resources`、`read-resource`、`list-examples` |
| 环境与 OCR 检查 | `doctor` | `drpy-doctor`、`ocr-check` |
| 站型与风险判断 | `triage` | `build-blueprint`、`plan-workflow`、`analyze-content` |
| 模板发现 | `templates list/guess` | 模板资源与人工比对 |
| 展开有效规则 | `resolved` | 新增原生 Aibox 模板解析能力 |
| 海阔分享规则读取 | `hiker-import` | Windows 剪贴板、`home_rule/home_rule_v2`、海阔云2/textdb |
| 生成紧凑规则 | `compose` | `aibox_compose_drpy_rule`、`compose-rule` |
| 非执行静态检查 | `lint` | `aibox_check_drpy_syntax`、`check-syntax`、静态部分 `validate-rule` |
| L1/L2/L3 验收 | `check` | `aibox_validate_drpy_rule`、`validate-rule`、`live-check` |
| 候选补丁/应用 | `heal` | `live-heal`，改为默认只输出 diff |
| 原子保存与版本 | `save` | `aibox_save_rule_file`、`save-rule` |
| 云1/云G1 分享 | `share` | `aibox_upload_clipboard`、`upload-clipboard` |
| 局部选择器调试 | `debug-selector` | `aibox_debug_drpy_rule`、`debug-rule` |
| 手动便携引擎 | `runtime start/stop` | `drpy-start`、`drpy-stop` |
| 依赖与公共引擎维护 | `aibox-engine-tools.mjs inspect/prepare/backup/apply/sync/mcp` | 隔离 npm/helper/WASM、实际工具发现、完整备份和干净候选；见[依赖准备](engine-dependencies.md) |

## 保留能力

- `resources read --name/--uri` 用于按需加载单项知识，避免一次读取整个知识库。
- `debug-selector --mode --rule` 只用于选择器局部调试，不能代替 L2/L3。
- `runtime start/stop` 仅用于手动诊断；正常 `check --engine auto` 优先直接调用原生 Aibox 引擎。
- OCR、动态域、漫画图片代理、小说/漫画首末章、BT/magnet、云剪切板均继续支持。
- 源级账户、线路、筛选默认值与搜索偏好统一使用 `more.aibox.setup`；支持分区、条件显示、单选、多选和滑杆，并与分类页临时筛选保持分层。

## Deprecated Alias

历史命令保留为兼容别名并在结果中返回替代命令提示。文档、Prompt 和新自动化不再使用旧命令名。

## 不内置的桥接

- 浏览器真实渲染、XHR 观察和交互操作使用当前环境可用的浏览器工具。
- 联网文档搜索使用当前环境可用的搜索工具。
- Cloudflare、滑块、登录墙、DRM 等强反爬只做识别和证据收集，不伪造“已自动解决”。

核心原则：能在本地稳定实现的能力进入 CLI；依赖外部运行环境的能力明确边界，不做假适配。

## App 内置 MCP 能力

Android、Windows 和 iOS 客户端可随 AIBOX Studio 在 `http://<局域网IP>:8765/mcp` 提供 Streamable HTTP MCP；同时兼容 `2026-07-28` 的 `server/discover` 与 `2025-11-25` 初始化协议。默认允许可信局域网免 Token 访问；开启“需要配对 Token”后，才要求先用 6 位一次性配对码换取 Bearer Token。

| 阶段 | App MCP 能力 | 用途 |
|---|---|---|
| 设备确认 | `aibox.device.info/health`、`aibox.permissions.get` | 确认目标设备、权限，以及嵌套的引擎运行与可达状态 |
| 源读取 | `aibox.source.list/read`、`aibox.source.workspace.read` | 区分 `sourceKey` 与 `module`，按 `nextOffset` 读取完整的脱敏文本 |
| 隔离编辑 | `aibox.source.workspace.open/create/patch/diff` | 用 `expectedDraftEtag` 管理草稿；脱敏源码只做非敏感片段补丁 |
| 正式变更 | `aibox.source.workspace.commit/rollback` | 原子提交并保留回滚快照 |
| 源管理 | `aibox.source.delete/rename/toggle` | 删除、重命名和启停源 |
| 源动作 | `aibox.source.actions.list/invoke` | 只调用源已声明的可执行动作；导航动作返回目标 |
| 真机运行 | `aibox.runtime.refresh`、`aibox.runtime.home`、`aibox.runtime.category`、`aibox.runtime.search`、`aibox.runtime.detail`、`aibox.runtime.play`、`aibox.runtime.reader` | 用正式 `module` 和真实上游 ID 调用当前 App 引擎 |
| 草稿验收 | `aibox.validation.l1/l2/l3` | 分别查看结构诊断、实际执行的单阶段、真实 ID 链路和警告 |
| 源配置 | `aibox.setup.schema/status/preferences.get/apply/validate` | 读取声明和状态，只自动写非敏感值；敏感输入留在 App |
| drpy 日志 | `aibox.logs.status/list/wait` | 获许可后分页读取当前进程内已采集的 drpy 日志 |
| 分享审计 | `aibox.share.publish`、`aibox.audit.list` | 分享已验证源并检查脱敏审计记录 |

App MCP 的 L1 是结构扫描，不等于本地 CLI 的 AST 校验；L2 的汇总成功也不证明所有阶段都被执行。`source.read` 的 ETag 是原始代码的 SHA-256，`redacted: true` 时不能由回读文本独立重算。具体调用顺序、错误恢复和交付口径见[App MCP 写源与验收](app-mcp-source-workflow.md)。Cookie、Token 和密码明文由用户在 App 内填写，MCP 只接收脱敏状态。
