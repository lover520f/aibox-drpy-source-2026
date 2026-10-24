# 源依赖、引擎草稿与本地发布候选

遇到 `$.require`、npm、helper、WASM 或 coreJS 依赖时，先完成本页流程，再跑源的真实链路。入口是 `scripts/aibox-engine-tools.mjs`，先读 `help`。引擎路径按显式 `--engine-root` 优先，其次从实际项目 cwd 向祖先搜索并校验 `package.json` 与 `libs/drpyS.js`；已安装 Skill 的 `.codex/skills` 位置不是项目路径。CLI 本地测试不等于 App 验收。

## inspect → prepare

```powershell
node <skill-dir>/scripts/aibox-engine-tools.mjs inspect --source candidate.js --engine-root <engine-dir>
node <skill-dir>/scripts/aibox-engine-tools.mjs prepare --source candidate.js --engine-root <engine-dir> --out <new-preparation-dir> --assets assets.json --pins pins.json
```

扫描使用 acorn AST，不执行源；识别静态 import、require、`$.require`、WASM URL 与 coreJS 使用。计算型依赖报 `UNRESOLVED_DEPENDENCY`，要改成已确认的字面量或拆出可检查的 helper；不能把日志里的包名当依赖证据。

`pins.json` 是精确版本映射，例如 `{"webp-wasm":"1.0.5","jpeg-js":"0.4.4"}`；这些是格式示例，实际版本来自当前 lockfile 或明确的兼容性证据。未知包没有 pin 时返回 `PIN_REQUIRED`，禁止猜 latest。assets 是数组：`{"file":"helper.js","path":"spider/js/_lib.helper.js","sha256":"64位hex"}`。路径相对 assets.json；远端 helper 先取得完整文件和可信 SHA，再用 `specifier` 映射原始 URL。新 helper/WASM 必须提供 SHA，既有 helper 可用实际引擎内字节作为基线 pin。

prepare 递归检查 helper，再从 lockfile 找到 npm 的精确版本和传递依赖；保留包内 WASM、版本和逐文件 SHA。`coreJS` 是使用线索，不是自动安装同名 npm 包的依据：若由源中的 `$.require` 加载，则随对应 helper 递归准备；若来自宿主注入，则从实际运行时确认。需要替换或新增 coreJS helper 时同样提供文件与 SHA。

本地缺包时加 `--install`；已有 lock 的版本保持冻结，否则只按明确的直接 pin 在新目录建立锁，再 `npm ci`。生命周期脚本始终 `--ignore-scripts`，不在活动原引擎运行 npm install。可用 `--lockfile` 提供匹配该隔离依赖集合的完整锁。依赖范围首次解析仍需检查产出的传递依赖锁；之后复用锁。

产物为 `bundle/`、`bundle.zip`、`patch-manifest.json` 和 `dependency-lock.json`。它们是依赖补丁和收据；dependency-lock 不覆盖整个引擎锁。manifest 记录原文件 `baseSha256`、候选 SHA、精确版本及平台要求。原生 addon、`gypfile`、native install 声明、`.node` 或 OS/CPU 限制返回平台 requirement 和 `success: false`；不能把桌面 sharp 当作 Android/iOS libnode 可用证据。默认优先已验证的纯 JS/WASM。

## backup → apply / sync

正式应用或本地同步前必须备份。`backup` 完整复制原引擎（包括本地用户文件），有原始 ZIP 时传 `--original-zip` 原样保留；逐文件回读验证 SHA 后才返回成功。备份是私有恢复材料，不能进入分享或发布 ZIP。输出、备份与准备目录必须在活动引擎外；拒绝 symlink/junction，已有 preparation 输出不覆盖。

```powershell
node <skill-dir>/scripts/aibox-engine-tools.mjs backup --engine-root <engine-dir> --backup-dir <private-backups> --original-zip <original.zip>
node <skill-dir>/scripts/aibox-engine-tools.mjs sync --engine-root <engine-dir> --archive <export-or-bundle.zip> --sha256 <verified-sha> --manifest <export-meta-or-patch-manifest.json> --backup-dir <private-backups> --original-zip <original.zip> --out <candidate-parent>
```

sync 自动再备份，验证整体 ZIP SHA、ZIP 路径/CRC/大小和 manifest，然后用原基线生成独立 staging。过滤用户源、Cookie/配置/数据/密钥、原生平台二进制等；重建空 `aibox.json/index.json`。每次输出唯一 `candidateVersion`、目录、外置 manifest 与 ZIP SHA，不改变活动原引擎。

App export 的 `syncPatchMetadata.entries` 使用 `relativePath/baseSha256/newSha256/storedArtifact/baseVersion/platform/arch`；CLI 校验它与 ZIP 内 `engine-maintenance-patches.json` 一致，仅合并记录中的补丁，保留本地无关修改。下载后转成仅含补丁的 ZIP 与 `manifest.files`（path、baseSha256、sha256/delete），空目录清单不进入补丁。纯 bundle 同样使用 `manifest.files`。冲突写入候选报告并返回失败；不强制覆盖，也不把冲突候选当可发布包。敏感字面量需先审查清除；过滤不是自动证明所有代码无秘密。

`apply` 接受同样的 archive/SHA/manifest/backup 参数，先完成完整备份与冲突检查，再应用本地补丁并回读 SHA。应用失败会给出备份位置和 `APPLY_INCOMPLETE`，需要按记录恢复；CLI 不声称本地文件写入等于引擎已成功启动。删除只限 manifest 中的允许路径，原文件保存在备份中。

## 当前 App MCP 引擎流程

先 initialize 并 tools/list，工具必须是连接实际公布的名称。工具按 owner/MCP 连接隔离；返回 `Mcp-Session-Id` 时后续全部带相同值，直接 LAN 模式可能协商为 sessionless，不伪造服务器 ID。断线后重新发现并打开草稿，不复用旧工作区/上传 ID。同时检查工具 `isError`、JSON 结果 `success/valid/ok`，还需检查阶段证据和诊断。

| canonical 工具 | 关键参数 / 结果 |
|---|---|
| `aibox.engine.info` | 活动引擎和实际维护能力 |
| `aibox.engine.dependencies.inspect` | 可选 workspaceId、paths；静态依赖证据 |
| `aibox.engine.workspace.open` | 返回 workspaceId、draftEtag |
| `aibox.engine.workspace.file.read` | workspaceId、path、offset/maxBytes；content/code、etag、draftEtag、complete/nextOffset |
| `aibox.engine.workspace.file.patch/delete` | workspaceId、path、expectedDraftEtag；patch 用 content 或 patches；成功刷新 draftEtag。服务内部支持 ifMatch，但使用当前 gateway 公布的 schema |
| `aibox.engine.workspace.diff/validate` | workspaceId；validate 的 modules 是相对路径列表，检查 valid 和诊断，仍需启动验证 |
| `aibox.engine.workspace.commit` | workspaceId、expectedDraftEtag、modules（运行时文件路径）、sourceModules（业务源 module 名称）；先持久备份再启动/验证候选，返回 transactionId |
| `aibox.engine.workspace.export` | workspaceId、expectedDraftEtag；artifactPath、size、sha256、syncPatchMetadata |
| `aibox.engine.export.read` | artifactPath、offset、maxBytes ≤262144；base64Content、nextOffset、totalBytes、complete、sha256；用原始字节偏移下载 |
| `aibox.engine.workspace.rollback` | transactionId，可选 expectedCurrentEtag；随后检查状态 |
| `aibox.engine.upload.begin` | workspaceId、totalBytes、sha256、expectedDraftEtag → uploadId |
| `aibox.engine.upload.append` | uploadId、offset、base64Chunk；offset 是原始字节数，不是字符数 |
| `aibox.engine.upload.status/finish/abort` | uploadId；status 核对 received/totalBytes；finish 带 expectedDraftEtag、验证 SHA 和安全路径并刷新 draftEtag；失败 abort |
| `aibox.engine.backups.list`、`aibox.engine.status` | 备份摘要与 transactionId 状态；不能只凭 commit 响应推断最终状态 |

分块读文本使用返回的 nextOffset，检查文件与草稿 ETag 期间不变。`redacted: true` 时只能对非敏感可见片段局部补丁；不能整份回写，也不能用脱敏内容验证原始 SHA。

```powershell
node <skill-dir>/scripts/aibox-engine-tools.mjs mcp --url http://<trusted-host>:8765/mcp
node <skill-dir>/scripts/aibox-engine-tools.mjs mcp --url http://<trusted-host>:8765/mcp --plan engine-plan.json --engine-root <engine-dir> --backup-dir <private-backups> --original-zip <original.zip> --source-modules source-modules.json --download-dir <verified-downloads> --sync-out <candidate-parent>
```

plan 是数组；operation 使用上表去掉 `aibox.engine.` 的工作流后缀。客户端自动串接 workspaceId 和最新 draftEtag；`workspace.commit` 自动 diff/validate，并验证本地备份。`upload` 是本地便捷步骤，需 file、sha256，可选 chunkBytes。`export.read` 由下载流程自动顺序调用。例：

```json
[
  {"operation":"info"},
  {"operation":"workspace.open"},
  {"operation":"upload","file":"prepared/bundle.zip","sha256":"实际ZIP的SHA"},
  {"operation":"workspace.validate","args":{"modules":["spider/js/_lib.helper.js"]}},
  {"id":"commit","operation":"workspace.commit","args":{"modules":["spider/js/_lib.helper.js"],"sourceModules":["从aibox.source.list取得的实际业务module"]}},
  {"operation":"workspace.export"},
  {"operation":"status"}
]
```

只在用户授权正式应用时加入 commit；需要恢复时加 `{"operation":"workspace.rollback","from":"commit"}` 或传 args.transactionId。源测试仍用已公布的 `aibox.validation.*`。`modules` 仅表示公共运行时文件/库引用；`sourceModules` 是 `aibox.source.list` 的业务 module 名称，单独用于候选引擎的源 L3，不能把库路径当内容源。CLI 的 `--source-modules` 接受 JSON 文件或内联 JSON 字符串数组；plan 的 args.sourceModules 可覆盖该次提交的默认列表。

workspace.export 返回的是 App 内 artifactPath，不能当电脑文件。当前连接公布 `aibox.engine.export.read` 后，`--download-dir` 在同一 MCP 会话下载完整 ZIP：每块核对 nextOffset、totalBytes、SHA 和 Base64，完成后重新验证总字节数与整包 SHA。`--sync-out` 同时把验证后的导出转为 patch-only ZIP/manifest 并调用 syncCandidate；它要求 `--backup-dir`，下载原包、metadata、patch.zip 与 patch-manifest 均保留在独立目录。只加 --sync-out 时自动建立独立下载目录。下载能力未公布时明确失败，不臆造 HTTP 路由；连接不可用时完成 inspect/prepare/本地测试并明确“App 未验证”。

协议与冻结安装依据：[MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)、[npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci/)。
