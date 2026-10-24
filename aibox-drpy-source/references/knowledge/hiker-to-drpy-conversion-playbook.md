# 海阔源转换为 Aibox ds 源 Playbook

## 适用场景

当用户给出以下任一信息时，按本流程处理：

- 海阔规则标题，例如 `示例规则`
- 海阔 Web 编辑链接，例如 `http://device.example.com:52020/ruleEdit#/?rule=示例规则`
- 海阔 `home_rule` / `home_rule_v2` 完整分享口令
- 海阔云剪切板 2 号短口令，例如 `云2oooole/apidb/exampleKey`
- 明确要求“把海阔源转换成 Aibox 源 / ds 源”

目标不是把海阔 UI 代码逐行翻译成 ds 源，而是从海阔规则中还原真实数据链路，再用 Aibox 的 `var rule = {}` 格式重写。

## 目录

1. 取得海阔规则
2. 拆解海阔字段
3. 映射字段
4. 选择转换策略
5. 参考案例
6. 执行验收
7. 按标准交付

## 1. 取得海阔规则

### 1.1 从 ruleEdit 链接读取

`ruleEdit#/?rule=...` 链接中的 host 和端口是用户设备的海阔 Web 编辑服务地址，`rule` 参数是规则标题。先使用用户授权的浏览器查看该编辑界面，或请用户导出完整 `home_rule/home_rule_v2` 分享文本；URL 编码的标题应正确解码。不要猜测或扫描局域网设备。

本发行包不附带独立的 `aibox-hiker` Skill 或其远程客户端；用户另行安装了该工具时，才按其实际帮助操作。缺少浏览器或设备连接时，使用下一节的文本导入，不报告已经读取了远程规则。

读取结果通常是一个海阔规则 JSON，重点看 `title`、`type`、`group`、`icon`、`url`、`search_url`、`find_rule`、`detail_find_rule`、`pageList` 和 `pages`。旧分享常只有字符串型 `pages`，要先 `JSON.parse` 恢复页面数组。

### 1.2 从系统剪切板、home_rule 或云2读取

用户已经复制海阔分享口令时，直接读取 Windows 剪切板并保存规则 JSON：

```powershell
node <skill-root>/scripts/aibox-skill-cli.mjs hiker-import --clipboard --save
```

只分析、不保存：

```powershell
node <skill-root>/scripts/aibox-skill-cli.mjs hiker-import --clipboard
```

也支持直接给云2短口令中的 key、textdb URL 或文本文件：

```powershell
node <skill-root>/scripts/aibox-skill-cli.mjs hiker-import --key exampleKey --save
node <skill-root>/scripts/aibox-skill-cli.mjs hiker-import --url https://api.textdb.online/exampleKey --save
node <skill-root>/scripts/aibox-skill-cli.mjs hiker-import --text-file .\share.txt --save
```

云2样本的实际分层是：

```text
云2oooole/apidb/<key>
  -> GET https://api.textdb.online/<key>
  -> 外层 Base64
  -> 海阔 home_rule_v2 分享口令
  -> base64://@规则名@<规则 JSON 的 Base64>
  -> 海阔规则 JSON
```

协议边界必须写清：

- 上传端使用 `POST https://api.textdb.online/update`，`Content-Type` 为 `application/x-www-form-urlencoded`，字段是 `key` 和 `value`。
- 回读端使用 `GET https://api.textdb.online/<key>` 或 `GET https://textdb.online/<key>`。
- `云2oooole/apidb/<key>` 中的 `/apidb/` 是海阔侧短口令标记，不应机械拼成 `https://api.textdb.online/apidb/<key>`；实测该路径可能返回空内容。
- 云2的 `value` 是完整海阔分享口令的外层 Base64，不是 Aibox ds 源，也不是 gzip 后的云1载荷。
- `base64://@名称@载荷` 的内层载荷通常是规则 JSON 的 Base64；部分工具导出的 `home_rule_v2` 使用 `Base64(encodeURIComponent(JSON))`，`hiker-import` 同时兼容两种。
- 导入阶段只做下载、解码、JSON 解析、依赖扫描和保存，绝不执行 `preRule`、`find_rule`、`pages` 或远程模块代码。

命令结果会列出 `pages` 和 `dependencies`。判断依赖是否缺失时，先把 `$.require("模块名")` 与页面的 `path` 对照：如果 `pages` 中已有同名 `path`，它是随规则内嵌的页面模块，不是外部缺失依赖；`hiker://assets/...` 则是海阔内置资源。

## 2. 先拆海阔字段，不急着写 ds 源

先从海阔规则整理这些事实：

- 站点名称：`title`
- 内容类型：`type`，常见为 `video`、`cartoon`、`read`
- 入口地址：`url`，去掉 `hiker://empty##`、`##fypage` 等海阔包装后得到真实分类页
- 搜索地址：`search_url`，把 `**` 和 `fypage` 映射到 ds 的 `searchUrl`
- 分类逻辑：`class_name/class_url` 或 `pageList` 中的动态分类页
- 详情逻辑：`detail_find_rule` 或 `pageList` 中名为 `二级`、`详情`、`ej` 的规则
- 播放逻辑：`lazyRule`、`pageList` 中名为 `lazy`、`解析` 的规则
- 验证逻辑：是否有验证码、登录、人机验证、Cookie 保存、`fetchCookie`、`OcrApi`、`verify` 等

海阔规则里的 `d.push`、滚动按钮、折叠状态、`getMyVar/putMyVar` 多数是 UI 状态，不要直接迁移。Aibox ds 源只需要稳定输出列表、详情、搜索和播放。

## 3. 字段映射原则

常见映射如下：

```text
海阔 title        -> rule.title
海阔 type/group   -> rule.类型、分享 category/groupTag
海阔 icon         -> 可选保留为注释或图片兜底，不是 ds 必填
海阔 url          -> rule.host + rule.url，或作为分类接口 referer
海阔 search_url   -> rule.searchUrl，必要时改用更稳定的 suggest/API 搜索
海阔 find_rule    -> rule.推荐 / rule.一级
海阔 detail_find_rule 或 二级页 -> rule.二级
海阔 lazyRule 或 解析页       -> rule.lazy
海阔动态分类                 -> rule.class_name/class_url/filter/filter_def
```

如果海阔 `url` 是 `hiker://empty##https://example.com/show/1.html##fypage`，真实入口是 `https://example.com/show/1.html`。`host` 取 `https://example.com`，分类页可以写成 `/show/fyclass/page/fypage.html`，也可以绕过 HTML 直接写接口。

## 4. 转换实现策略

### 列表页

优先判断海阔一级规则是否请求 JSON/API：

- 出现 `post(...)`、`fetch(... { method: 'POST' })`、`JSON.parse(...)` 时，优先复刻接口。
- 出现 `pdfa/html` 卡片选择器时，再写 HTML 抽取。
- 动态筛选不要照抄海阔按钮 UI，要整理成 ds 的 `filter` 数组。

Aibox 列表输出只需要：

```js
{
  title: '名称',
  pic_url: '封面',
  desc: '备注',
  content: '简介',
  url: '详情页或详情 id'
}
```

### 详情页

详情页要产出标准 vod 对象：

```js
{
  vod_id,
  vod_name,
  vod_pic,
  type_name,
  vod_remarks,
  vod_year,
  vod_area,
  vod_actor,
  vod_director,
  vod_content,
  vod_play_from,
  vod_play_url
}
```

海阔的线路 tab 和选集列表通常在 `pageList` 的 `二级` 规则中。将它们转换为：

```text
vod_play_from = 线路1$$$线路2
vod_play_url = 第1集$url1#第2集$url2$$$第1集$url3
```

### 搜索

不要强制照搬海阔 HTML 搜索页。很多站点的搜索页会 500、空白或需要额外状态，但 suggest 接口稳定。优先实测：

- `/index.php/ajax/suggest?mid=1&wd=**&limit=50`
- 站点自带搜索 JSON 接口
- 海阔规则中的 `search_url`

只要能映射到详情页，就可以用更稳定的接口替代原搜索页。

### 播放

播放转换优先级：

1. 播放页源码直接出现 `m3u8/mp4/flv`，直接 `parse: 0`。
2. 页面有 `player_aaaa` 或类似播放器对象，先按 `encrypt=1/2` 解码。
3. 解码后是直链，直接返回。
4. 解码后不是直链，读取播放器配置，例如 `static/js/playerconfig.js`。
5. 如果海阔 lazy 中有解析接口、AES、CryptoJS 逻辑，再按原逻辑移植。
6. 没有把握时先返回 `{ parse: 1, url }`，保证能交给外部解析。

### 漫画图片与解密

海阔漫画源经常把图片处理藏在 lazy、`imageDecrypt`、`getBytes`、`CryptoJS.AES.decrypt` 或 Java AES 代码里。转换时不要只复制章节 URL：

- 先确认章节图片是否能直接被浏览器和 App 解码。
- 如果海阔源对图片做 `AES/CBC/PKCS7Padding`，Aibox 源要实现等价的 `proxy_rule`，由代理拉二进制并解密后返回图片。
- 如果海阔源只是补 `Referer` / `User-Agent`，Aibox 源也建议用 `proxy_rule` 固化请求头，避免 App 图片组件裸请求失败。
- `lazy` 返回 `pics://` 时优先返回代理图：`pics://proxyImg1&&proxyImg2`。
- 首页、分类、搜索和详情里的封面图也可能要代理，不要只修章节页。

更完整的代理处理与匿名示例见：

```text
aibox://knowledge/comic-image-proxy-playbook
```

### 验证码和登录

如果海阔规则中有 `验证码`、`登录账号`、`fetchCookie`、`verify/index.html`、`Just a moment`、`DDoS防护`，转换时必须显式处理：

- 能用 drpy-node 内置 OCR 时，优先用 `getHtml`、`verifyCode`、`setItem(RULE_CK)`、`OcrApi`。
- API 返回 HTML 验证页时，不要直接 `JSON.parse`。
- 登录账号类规则如果没有账号来源，先保留清晰日志和空结果兜底，不伪造登录。

## 5. 通用动画站转换示意

海阔规则入口：

```text
hiker://empty##https://comic.example.com/show/1.html##fypage
```

转换结论：

- `host`: `https://comic.example.com`
- 分类：`连载新番&完结旧番&剧场版&美漫`
- 一级接口：`POST /index.php/ds_api/vod`
- 详情页：`/bangumi/{id}.html`
- 播放页：`/watch/{id}/{sid}/{nid}.html`
- 搜索接口：`/index.php/ajax/suggest?mid=1&wd=**&limit=50`
- 播放对象：`player_aaaa`
- 播放直链：实际响应明确为 `mp4` 时可直接 `parse: 0`
- 非直链兜底：读取 `/static/js/playerconfig.js`，再按海阔原 lazy 的解析接口和 AES 逻辑处理

以上仅是接口形状示意，不是可交付站点源；真实任务必须重新取证。海阔页面里的动态分类 UI 可在 API 证据支持时转换为 AIBOX 的 `filter`，不能仅按示例路径猜接口。

## 6. 推荐验收命令

转换完成后必须先做静态校验：

```powershell
node <skill-root>/scripts/aibox-skill-cli.mjs lint --code-file .\output\目标源.js
```

有条件时跑完整实测：

```powershell
node <skill-root>/scripts/aibox-skill-cli.mjs check --code-file .\output\目标源.js --level l3 --engine auto
```

需要分享给 App 时上传云剪切板：

```powershell
node <skill-root>/scripts/aibox-skill-cli.mjs share --code-file .\output\目标源.js --name 源名称 --category video --group-tag 动漫
```

## 7. 交付标准

完成海阔转 Aibox 源时，最终答复应说明：

- 海阔规则读取方式：`ruleEdit`、`--ip + --title`、完整 `home_rule/home_rule_v2`、云2短口令或裸 key
- 如果来自剪切板，给出 `hiker-import` 保存路径，并说明页面模块依赖哪些已内嵌、哪些是海阔内置资源、哪些仍需外部取得
- 真实业务域和核心接口
- 转换后的源文件路径
- `lint` 和 `check --level l3` 结果
- 如果上传了云剪切板，给出完整 `云1` 分享码
