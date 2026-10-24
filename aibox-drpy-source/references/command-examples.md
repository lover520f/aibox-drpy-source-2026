# Aibox 写源 CLI 示例

以下命令从仓库根目录运行。先查看当前帮助，参数与输出以实际 CLI 为准：

```powershell
node <skill-root>/scripts/aibox-skill-cli.mjs help
```

CLI 正常结果统一输出 JSON：

```json
{"ok":true,"command":"triage","data":{}}
```

失败结果包含结构化 `error.code/message/suggestions`；普通过程日志写入 stderr。

## 1. 环境检查

检查 Node、Aibox 原生引擎、便携 runtime、OCR、配置和云剪切板能力：

```powershell
node <skill-root>/scripts/aibox-skill-cli.mjs doctor
```

有真实验证码样本时：

```powershell
node <skill-root>/scripts/aibox-skill-cli.mjs doctor --ocr-image-file .\captcha.png
```

## 2. 读取知识资源

列出当前知识、示例、模板和 Prompt：

```powershell
node <skill-root>/scripts/aibox-skill-cli.mjs resources list
```

按短名称或完整 URI 读取单项资源：

```powershell
node <skill-root>/scripts/aibox-skill-cli.mjs resources read --name comic-source-development-playbook
node <skill-root>/scripts/aibox-skill-cli.mjs resources read --uri aibox://knowledge/drpy-basic-format-grammar
```

## 3. 站型判断

直接分析目标 URL：

```powershell
node <skill-root>/scripts/aibox-skill-cli.mjs triage --url "https://example.com"
```

结果重点查看 `route`、`contentType`、`implementationMode`、`risks`、`evidence` 和 `nextCommand`。

## 4. 模板发现与展开

列出当前 Aibox 引擎真实模板：

```powershell
node <skill-root>/scripts/aibox-skill-cli.mjs templates list
```

根据 URL 或已抓取内容推测候选模板：

```powershell
node <skill-root>/scripts/aibox-skill-cli.mjs templates guess --url "https://example.com"
node <skill-root>/scripts/aibox-skill-cli.mjs templates guess --content-file .\samples\home.html
```

查看源码或现有模块在模板继承后的有效规则：

```powershell
node <skill-root>/scripts/aibox-skill-cli.mjs resolved --code-file .\output\source.js
node <skill-root>/scripts/aibox-skill-cli.mjs resolved --module 源名称
```

## 5. 生成紧凑规则

按输入 schema 生成规则：

```powershell
node <skill-root>/scripts/aibox-skill-cli.mjs compose --input-file .\source-spec.json
```

输入应明确 `sourceKind`、`contentType`、`implementationMode`，以及实际需要的 `home/category/search/detail/catalog/reader/play` 阶段。简单站优先模板或字符串规则，签名、POST、动态域、聚合、解密阶段再使用 async。

App API 至少要提供真实 `host`、推荐接口、分类接口、详情接口和分类数据。下面是可生成分类入口并串联详情、目录、正文的最小结构；字段路径必须按真实响应修改：

```json
{
  "sourceKind": "app-api",
  "contentType": "comic",
  "implementationMode": "full-async",
  "siteName": "示例漫画接口",
  "host": "https://api.example.com",
  "classes": [
    { "name": "连载", "id": "serial" },
    { "name": "完结", "id": "finished" }
  ],
  "stages": {
    "home": { "url": "/api/home", "listPath": "data.list" },
    "category": { "url": "/api/comics?type=fyclass&page=fypage", "listPath": "data.list" },
    "detail": { "url": "/api/comic/fyid", "dataPath": "data" },
    "catalog": { "url": "/api/comic/fyid/chapters", "listPath": "data.chapters" },
    "reader": { "url": "/api/chapter/fyid", "dataPath": "data", "responseType": "json" }
  }
}
```

`classes` 也可以写成分段数一致的 `className/classUrl`。`home.url` 必须能脱离 `fyclass/fypage/**` 直接请求；没有真实推荐和分类证据时，生成器会拒绝输出只有推荐或空分类的源。

POST body 中的 `fyid/fyclass/fypage/**` 默认替换为原始值，适合 JSON body：

```json
{
  "method": "POST",
  "url": "/api/chapter",
  "bodyType": "json",
  "headers": { "Content-Type": "application/json" },
  "body": { "id": "fyid" }
}
```

只有接口明确要求 URI 编码时，才设置 `"bodyEncode": true` 或 `"bodyEncoding": "uri"`。例如字符串表单 `"body": "id=fyid"` 会保留 `id=`，仅把替换进去的 ID 编码；不要对 JSON body 默认编码，否则 `/`、中文等原始 ID 会被改变。

`responseType` 默认是 `json`。声明式 App API 只允许三个可验证的文本响应分支：影视 `play` 返回媒体直链、小说 `reader` 返回正文文本、漫画 `reader` 返回 JSON 字符串/数组或按换行（也兼容 `&&`）分隔的图片地址。列表、详情、目录等需要结构化字段的阶段若声明 `responseType: "text"`，`compose` 会直接拒绝，避免静默生成空数据。

只输出源代码时：

```powershell
node <skill-root>/scripts/aibox-skill-cli.mjs compose --input-file .\source-spec.json --code-only
```

## 6. L1 静态检查

```powershell
node <skill-root>/scripts/aibox-skill-cli.mjs lint --code-file .\output\source.js
```

`lint` 读取或解密源码，检查语法、AST、重复键、header、模板、继承、二级字典、请求输入和播放契约，不执行站点源码。

## 7. L1/L2/L3 实跑

只运行结构检查：

```powershell
node <skill-root>/scripts/aibox-skill-cli.mjs check --code-file .\output\source.js --level l1
```

执行单接口真实验证：

```powershell
node <skill-root>/scripts/aibox-skill-cli.mjs check --code-file .\output\source.js --level l2 --engine auto
```

执行真实 ID 完整链路：

```powershell
node <skill-root>/scripts/aibox-skill-cli.mjs check --code-file .\output\source.js --level l3 --engine auto
```

引擎选项：

- `auto`：优先原生 Aibox 引擎，无法使用时再 fallback。
- `native`：只接受原生引擎结果。
- `portable`：使用近似便携 runtime，结果不能单独作为正式上传门禁。

小说 L3 检查首末章正文；漫画 L3 检查首末章首尾图片文件头；影视 L3 检查至少一条真实播放链。

### Node 原生权限模型

原生 worker 会按当前 Node 构建自动选择受支持的权限参数（例如 `--permission` 或旧版 `--experimental-permission`），并仅授权引擎资源、规则文件、隔离工作目录及 drpy 明确探测的相邻资源目录。Node 24 下不应为了绕过旧参数错误而关闭权限模型；先更新 Skill runtime，再用 `node --version`、`doctor` 和原生 L3 测试确认运行状态。

只有排查 Node 权限模型本身时才可显式设置 `permissionModel: false`。这种 `process-only` 结果是诊断信息，不等价于标准隔离验收，也不能作为正式上传门禁。

## 8. 局部选择器调试

对已抓取内容调试 `pdfa/pdfh/pd`，必须同时给出 `--mode` 和 `--rule`：

```powershell
node <skill-root>/scripts/aibox-skill-cli.mjs debug-selector --content-file .\samples\home.html --mode pdfa --rule ".list&&li"
node <skill-root>/scripts/aibox-skill-cli.mjs debug-selector --content-file .\samples\home.html --mode pdfh --rule "h3&&Text" --base-url "https://example.com"
```

选择器局部成功只算调试证据，不能代替 L2/L3。

## 9. 生成修复补丁

默认只输出候选 diff，不改原文件：

```powershell
node <skill-root>/scripts/aibox-skill-cli.mjs heal --code-file .\output\source.js
```

确认补丁后才写入：

```powershell
node <skill-root>/scripts/aibox-skill-cli.mjs heal --code-file .\output\source.js --apply
```

`heal` 只修复有静态或真实响应证据的问题，不猜测搜索地址、headers、分类或模板。

## 10. 原子保存与版本递增

```powershell
node <skill-root>/scripts/aibox-skill-cli.mjs save --code-file .\output\source.js --file-name source.js
```

覆盖并递增 patch：

```powershell
node <skill-root>/scripts/aibox-skill-cli.mjs save --code-file .\output\source.js --file-name source.js --output-dir .\drpy-node\spider\js --overwrite --bump patch
```

`--bump` 支持 `patch`、`minor`、`major`。保存采用临时文件、回读校验和原子替换，失败时保留原文件。

## 11. 从剪切板读取海阔规则

剪切板里已经有完整 `home_rule/home_rule_v2` 或 `云2oooole/apidb/<key>` 时：

```powershell
node <skill-root>/scripts/aibox-skill-cli.mjs hiker-import --clipboard --save
```

指定云2 key：

```powershell
node <skill-root>/scripts/aibox-skill-cli.mjs hiker-import --key exampleKey --save
```

指定保存文件并允许覆盖：

```powershell
node <skill-root>/scripts/aibox-skill-cli.mjs hiker-import --clipboard --output-file .\output\source.hiker.json --overwrite
```

命令只解析和保存规则，不执行海阔脚本。结果会列出 `pages`、`$.require/requirejs/require` 依赖及未内嵌依赖警告。

## 12. 云1 单源分享

```powershell
node <skill-root>/scripts/aibox-skill-cli.mjs share --code-file .\output\source.js --name 源名称 --category comic --group-tag 漫画
```

只验证编码和分享码形态：

```powershell
node <skill-root>/scripts/aibox-skill-cli.mjs share --code-file .\output\source.js --name 源名称 --category comic --group-tag 漫画 --dry-run
```

上传后复制分享码：

```powershell
node <skill-root>/scripts/aibox-skill-cli.mjs share --code-file .\output\source.js --name 源名称 --category comic --group-tag 漫画 --copy
```

## 13. 云G1 分组分享

```powershell
node <skill-root>/scripts/aibox-skill-cli.mjs share --group-file .\group.json --name 漫画分组 --category comic --group-tag 漫画
```

默认先执行必要校验，并在上传后回读核对字节数和 SHA-256：

- `--force`：显式越过失败门禁，并在结果中标记 `forced: true`。
- `--no-verify`：显式关闭上传后回读验证，只用于受控诊断。
- 分组任一单项失败时，不能报告整组成功。

## 14. 手动便携 Runtime

正常检查优先使用 `check --engine auto`。只有排查便携 runtime 本身时才手动启动，默认选择随机空闲端口：

```powershell
node <skill-root>/scripts/aibox-skill-cli.mjs runtime start
node <skill-root>/scripts/aibox-skill-cli.mjs runtime stop
```

CLI 只停止由本 Skill 创建且状态信息匹配的 runtime，不接管任意现有 Node 服务。

## 旧命令

`compose-rule`、`validate-rule`、`check-syntax`、`live-check`、`live-heal`、`save-rule`、`upload-clipboard`、`drpy-doctor` 等仅作为 deprecated alias 保留。新文档和新自动化只使用本页主命令。

## 15. 连接 App 内置 MCP

在 App 的“设置 → AIBOX Studio”启动服务，使用那里显示的地址。`127.0.0.1` 只代表 MCP 客户端所在设备；电脑连手机时用手机局域网 IP，或明确设置 adb 转发。TCP 端口处于监听状态并不能证明 Studio 已响应；连接后须列出工具并调用 `aibox.device.info/health`。

### Codex 桌面端、CLI 和 IDE

免配对模式可从终端添加：

```powershell
codex mcp add aibox --url http://device.example.com:8765/mcp
codex mcp list
```

也可以在 `~/.codex/config.toml` 中配置；桌面端添加后按其提示重启连接：

```toml
[mcp_servers.aibox]
url = "http://device.example.com:8765/mcp"
```

如 App 开启“需要配对 Token”，先在 App 生成一次性配对码，再从**将要启动 Codex 的同一个 PowerShell 进程**配对。不要输出或写入真实 Token；已运行的桌面 App 不会自动继承新设的进程环境变量。

```powershell
$aiboxBaseUrl = 'http://device.example.com:8765'
$pairBody = @{ code = '<App 中的 6 位配对码>'; clientLabel = 'Codex' } | ConvertTo-Json
$pairResult = Invoke-RestMethod -Method Post -Uri "$aiboxBaseUrl/api/studio/pair" -ContentType 'application/json' -Body $pairBody
$env:AIBOX_MCP_TOKEN = $pairResult.token
```

配对模式的 Codex 配置为：

```toml
[mcp_servers.aibox]
url = "http://device.example.com:8765/mcp"
bearer_token_env_var = "AIBOX_MCP_TOKEN"
```

Token 失效后在 App 重新配对，并让 Codex 进程读取新的环境变量。`codex mcp list` 只证明配置存在；本轮真机可用性仍以 MCP 初始化、工具列表和设备/引擎状态为准。Codex Streamable HTTP 的 `url`、`bearer_token_env_var` 及重连方式以[官方 MCP 文档](https://developers.openai.com/codex/extend/mcp)为准。

### Claude Code 等 JSON MCP 客户端

免配对模式示例：

```json
{
  "mcpServers": {
    "aibox": {
      "type": "http",
      "url": "http://device.example.com:8765/mcp"
    }
  }
}
```

配对模式按客户端支持的凭据或环境变量 Header 配置 Bearer Token；只有客户端明确支持环境变量插值时才使用对应语法，不把真实 Token 写入可提交的配置。具体工具参数、脱敏草稿编辑、L1/L2/L3 结果判断和冲突恢复见[App MCP 写源与验收](app-mcp-source-workflow.md)。
