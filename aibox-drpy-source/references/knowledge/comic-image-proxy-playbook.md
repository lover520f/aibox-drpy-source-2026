# 漫画图片代理与解密经验

## 适用场景

写漫画源时，如果首页、分类、搜索、详情封面或章节图片出现以下症状，先按本文排查：

- App 里列表有标题但封面不显示。
- `lazy` 能返回 `pics://`，但阅读器图片空白、乱码或解码失败。
- 浏览器直接打开图片需要特定 `Referer` / `User-Agent`。
- 图片接口返回 `image/*`，但文件头不是 `JPEG/PNG/WEBP/GIF/AVIF/SVG`。
- 海阔源里有 `imageDecrypt`、`AES/CBC/PKCS7Padding`、`CryptoJS.AES.decrypt`、`getBytes` 或二进制代理逻辑。

这类问题通常不是选择器问题，而是图片链路问题：CDN 防盗链、二进制加密、切片重排、接口返回包装层，或 App 端无法带上站点要求的请求头。

如果症状是「目录正常，但正文条带错位 / 上下错层」，优先阅读 [App API + 切片复盘](comic-app-api-scramble-retrospective.md)：那是禁漫天堂落地中验证过的 scramble + 真机解码库选型经验。

## 核心策略

1. 先把图片链路拆成封面和章节两类，分别验证裸请求、带头请求和真机组件最终请求。
2. `rule.headers` 或源侧 `request` 成功，不等于 Flutter 普通卡片会继承这些请求头；封面仍失败时必须改写 `pic_url` / `vod_pic` 为本地代理地址。
3. 章节阅读器会消费 `lazy.header`；章节直连加头已经稳定时，只代理封面，避免额外的 Node 内存、带宽和并发开销。
4. 章节仍出现 403、加密、切片或解码失败时，再把 `pics://` 中的章节地址也接入同一个 `proxy_rule`。
5. `proxy_rule` 负责补请求头、拉二进制、校验真实文件头，并在有证据时执行解密或切片重排。
6. `check --level l3 --engine auto` 必须真实拉取推荐、分类、详情、搜索封面和首末章首尾图片，不能只检查 URL 非空。

## proxy_rule 返回格式

内置 runtime 支持 drpy-node 常见代理返回数组：

```js
[statusCode, mediaType, content, headers, toBytes]
```

常用写法：

```js
return [200, 'image/webp', base64Image, {
  'Cache-Control': 'public, max-age=3600',
}, 1];
```

含义：

- `statusCode`: HTTP 状态码。
- `mediaType`: 响应 `Content-Type`。
- `content`: 文本内容或 base64 字符串。
- `headers`: 附加响应头。
- `toBytes === 1`: 把 `content` 当 base64 解码成 Buffer 返回。
- `toBytes === 2` 且 `content` 是 http 地址时，runtime 会返回 302 跳转。

## 代理地址拼法

在规则函数里优先使用 runtime 注入的 `getProxyUrl()`：

```js
function comicProxyImageUrl(url) {
  const image = String(url || '').trim();
  if (!image) return '';
  let proxyBase = '';
  try {
    if (typeof getProxyUrl === 'function') proxyBase = getProxyUrl();
  } catch (e) {}
  try {
    if (!proxyBase && typeof this.getProxyUrl === 'function') {
      proxyBase = this.getProxyUrl();
    }
  } catch (e) {}
  if (!proxyBase) return image;
  const separator = proxyBase.includes('?') ? '&' : '?';
  return proxyBase + separator + 'kind=cover&url=' + encodeURIComponent(image);
}
```

同时兼容全局函数和 `this.getProxyUrl()`，因为不同调用阶段、便携 runtime 与原生引擎的注入位置可能不同。没有代理基址时应回退远端原图，不能生成 `&url=...` 这种无主地址。

如果站点区分模块或路径，也可以把参数放进 query，例如：

```js
return getProxyUrl() + '&type=image&url=' + encodeURIComponent(imageUrl);
```

`proxy_rule` 中读取：

```js
proxy_rule: async function (params) {
  const imageUrl = decodeURIComponent(String(params.url || ''));
  // 拉图、解密、返回图片字节
}
```

## 先区分封面和章节请求链路

Aibox 当前 Flutter 客户端的两类图片请求不是同一条链：

| 场景 | 客户端路径 | DS 请求头行为 |
|---|---|---|
| 推荐、分类、搜索、详情封面 | 普通卡片 `CachedNetworkImage` | 不可靠继承源的 `rule.headers`，通常按 `pic_url` / `vod_pic` 裸请求 |
| 漫画章节图片 | `playData.headers` -> `CachedNetworkImage.httpHeaders` | 明确消费 `lazy.header` |

仓库内证据位置：

- `lib/features/video/widgets/vod_card.dart` 的封面组件只传入 `imageUrl`，没有传入 DS 源 headers。
- `lib/features/comic/pages/comic_reader_page.dart` 会把 `playData.headers` 保存到章节 payload，并传给 `CachedNetworkImageProvider.headers` / `CachedNetworkImage.httpHeaders`。

因此会出现一个很有迷惑性的状态：

```text
源侧 request 带 headers：封面 HTTP 200
章节 lazy.header：章节图片正常
Flutter 普通卡片裸请求：封面 HTTP 403
```

这种情况不是列表选择器失效，也不是 `rule.headers` 写错。判断证据应同时满足：

1. 同一个远端封面 URL 不带头返回 `403 text/html` 或 HTML 文件头。
2. 加 `User-Agent` 或 `Referer` 后返回 `200/206 image/*`，且文件头能识别。
3. 章节图正常，但推荐、分类、详情和搜索封面同时失败。

满足以上条件时，应只把封面统一代理：

```js
pic_url: source._proxyImage(source._normalizeImage(pic))
vod_pic: source._proxyImage(source._normalizeImage(cover))
```

推荐、分类和搜索通常共享同一个卡片解析 helper，优先在统一入口改写，避免漏掉某一个阶段。详情 `vod_pic` 必须单独检查，不能因为列表封面已代理就默认详情也会继承。

## 安全的封面代理

封面代理运行在手机本地 Node 引擎上，不能把它写成任意 URL 转发器。至少执行以下约束：

1. 只允许 `http://` / `https://`。
2. 使用 `new URL()` 解析，拒绝包含用户名或密码的 URL。
3. host 必须命中站点已知图片域白名单，使用“完全相等或子域后缀”判断，不能用宽泛 `includes()`。
4. 使用 `axios` 的 `responseType: 'arraybuffer'` 拉二进制，设置合理超时和有限重定向。
5. 不信任远端 `Content-Type`，按文件头重新识别媒体类型。
6. 无法识别真实图片时返回 `502 text/plain`，不要把 403 HTML 页面按 `image/webp` 转发。
7. 成功响应可增加 `Cache-Control`，降低重复封面请求压力。

常见文件头：

| 类型 | 文件头判断 |
|---|---|
| JPEG | `FF D8 FF` |
| PNG | `89 50 4E 47` |
| WebP | `RIFF` 且第 8-11 字节为 `WEBP` |
| GIF | `GIF87a` / `GIF89a` |
| AVIF | 第 4-7 字节为 `ftyp`，brand 为 `avif` / `avis` |
| SVG | 去空白后以 `<svg` 开头，或 XML 声明后出现 `<svg`，同时排除 HTML |

防盗链错误页常以 `<!DOCTYPE html>` 开始，对应十六进制头接近 `3c21444f43545950`。即使远端状态是 200 或响应头声称 `image/*`，文件头不是图片也必须失败。

最小二进制请求模式：

```js
const response = await axios({
  method: 'GET',
  url: imageUrl,
  headers: imageHeaders,
  responseType: 'arraybuffer',
  timeout: 20000,
  maxRedirects: 3,
  validateStatus: status => status >= 200 && status < 300,
});
const buffer = Buffer.from(response.data || []);
const mediaType = detectImageMediaType(buffer);
if (!mediaType) {
  return [502, 'text/plain', 'cover proxy received a non-image response'];
}
return [200, mediaType, buffer.toString('base64'), {
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'public, max-age=86400',
}, 1];
```

## AES 解密模式

海阔规则常见写法是 `AES/CBC/PKCS7Padding`。迁移到 Aibox ds 源时，优先用 Node `crypto`；如果运行环境不提供 `require`，再用规则内已有的 `CryptoJS` 兜底。

Node 写法：

```js
function decryptImageBuffer(buffer) {
  const crypto = require('crypto');
  const key = Buffer.from('my2ecret782ecret', 'utf8');
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, key);
  return Buffer.concat([decipher.update(buffer), decipher.final()]);
}
```

判断是否需要解密：

```js
function imageKind(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png';
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return '';
}

function maybeDecryptImage(buffer) {
  if (imageKind(buffer)) return buffer;
  try {
    const decoded = decryptImageBuffer(buffer);
    return imageKind(decoded) ? decoded : buffer;
  } catch (e) {
    return buffer;
  }
}
```

不要盲目对所有图片解密。普通 JPG/WEBP 封面应原样返回；只有文件头不合法或站点规则明确加密时才尝试解密。

## 漫蛙案例记录

漫蛙海阔源的关键点：

- 章节图和部分封面走远端图片地址，但远端会返回加密二进制。
- 海阔规则里的 `imageDecrypt` 使用 `AES/CBC/PKCS7Padding`。
- key 和 iv 都是 `my2ecret782ecret`。
- Aibox 源需要实现 `proxy_rule`，由代理补 `User-Agent` / `Referer`，拉取二进制，AES 解密后返回真实 `image/webp`。
- `lazy` 章节图返回 `pics://proxyUrl1&&proxyUrl2...`。
- 首页、分类、搜索、详情里的 `pic_url` / `vod_pic` 也要走同一代理，否则列表封面可能仍然不显示。

验证通过时，L3 报告摘要应接近：

```text
首页 image=ok/webp
分类 image=ok/webp
详情 image=ok/webp
搜索 image=ok/webp
播放 parse=0 pics=217 firstImage=ok/webp
```

报告里的图片探测对象应包含：

- `status: "ok"`
- `imageKind: "webp"` 或其他合法图片类型
- `isProxy: true`
- `headHex` 以合法文件头开头，例如 `52494646...57454250` 表示 `RIFF....WEBP`

## Goda 封面 403 案例记录

2026-08-14 修复 Goda 漫画源时取得的证据：

- 封面 CDN 为 `c-nc-1.6wm.top` 一类 `*.6wm.top` 域名。
- 相同封面 URL 裸请求返回 `HTTP 403`、`Content-Type: text/html`，正文是 HTML 错误页。
- 添加移动端 `User-Agent` 或站点 `Referer` 后返回 `HTTP 200/206`，真实文件头为 WebP。
- 章节图片通过 `lazy.header` 在阅读器中正常；失败范围仅覆盖推荐、分类、详情和搜索封面。
- 根因是普通卡片请求没有可靠继承 DS 源 headers，不是网页解析或 CDN 地址拼接错误。

最终采用按阶段代理：

- `_parseCards` 统一代理推荐、分类和搜索的 `pic_url`。
- 详情单独代理 `vod_pic`。
- `lazy` 章节图片保持远端直连并返回 `imageHeaders`。
- `proxy_rule` 只接受 `kind=cover`，并把允许域限制到 Goda 已知业务/图片域。
- 代理返回前识别真实图片文件头，HTML 防盗链页返回明确的 502 错误。

当次便携 L3 的关键结果：

```text
推荐  image=ok/webp  isProxy=true
分类  image=ok/webp  isProxy=true
详情  image=ok/webp  isProxy=true
搜索  image=ok/webp  isProxy=true
首章  parse=0 pics:// first=ok/webp last=ok/webp isProxy=false
末章  parse=0 pics:// first=ok/webp last=ok/webp isProxy=false
```

这个案例说明“统一修复”不等于“所有图片都代理”。统一的是封面 URL 的生成入口和安全检查；章节已经能通过 `lazy.header` 直连时应保留直连。

## L3 真实图片检测

当前 `check --level l3 --engine auto` 对 `类型: '漫画'` 会额外执行：

- 首页首个封面探测。
- 分类首个封面探测。
- 详情首个封面探测。
- 搜索首个封面探测。
- 首章和末章 `lazy` 返回的首图、末图探测。

直连封面会使用规则 `headers`；代理封面在同一个原生引擎会话中调用 `proxy_rule`。分类和详情封面是硬门禁，推荐和搜索只有空列表才能按显式 `allowEmpty=homevod,search` 跳过，非空伪封面不会被放行。

检测逻辑会真实 `fetch` 图片，跟随跳转，并识别文件头：

- `jpeg`
- `png`
- `webp`
- `gif`
- `avif`
- `svg`

如果 HTTP 成功但不是合法图片，会给出类似诊断：

```text
image-response-not-decodable-maybe-encrypted-or-scrambled
```

这通常说明源还缺图片代理、AES 解密、切片还原或请求头补齐。

## WebP 切片（scramble）与真机解码库

部分漫画站（如禁漫 / JM 类）正文几乎全是 WebP，并按章节 ID 做纵向条带打乱：

1. `lazy` 返回的远端图即使 HTTP 200、文件头合法，**画面仍可能错位**。
2. 必须在 `proxy_rule` 中：拉二进制 → 解码 RGBA → 按官方算法重排 → 再编码返回。
3. Aibox Flutter 真机走内置 `libnode`，**不能把 sharp 当依赖**：
   - sharp 原生二进制按构建机 OS 安装；
   - Windows 开发机装到的 `win32-x64` 进不了 Android arm64；
   - jimp 默认也常读不了 WebP。
4. 真机推荐：
   - 解码：`third_party/aibox-engine` 内的 `webp-wasm`
   - 编码：`jpeg-js`（输出 JPEG 给阅读器更稳）
5. 仅改源码不够：APK 打包的 `aibox-engine.zip` 必须含上述 `node_modules`，并递增 `bundledEngineVersion` 触发重解压。

完整算法、分类筛选、AES 请求与验收清单见 [comic-app-api-scramble-retrospective.md](comic-app-api-scramble-retrospective.md)。

## 排查顺序

1. 先看 L3 报告里的 `imageProbe` / `firstImageProbe`。
2. 如果 `httpStatus` 不是 200，优先补远端请求头、Referer 或代理。
3. 如果 `contentType` 是 `image/*` 但 `imageKind` 为空，优先排查 AES 加密或切片重排。
4. 如果 `headHex` 是 HTML 开头，说明远端返回了防盗链页、验证页或错误页。
5. 如果章节首图通过但后续图片失败，再抽样章节中间页，不要默认全站都正常。
6. 如果封面通过但章节失败，重点看章节接口是否有单独的加密参数。
7. 如果章节通过但封面失败，把 `vod_pic` / `pic_url` 也接入同一 `proxy_rule`。
8. 如果源侧带头探测通过但真机卡片仍失败，检查 Flutter 卡片是否实际接收 headers，不要继续重复修改 `rule.headers`。
9. 同名源更新后本地正常、手机仍异常时，递增 `version`，删除设备上的旧源再导入，并核对云端、本地与设备源码 SHA-256，排除模块缓存和旧文件未覆盖。

## 验收命令

```powershell
node <skill-root>/scripts/aibox-skill-cli.mjs lint --code-file '.\output\manwafl[漫].js'
node <skill-root>/scripts/aibox-skill-cli.mjs check --code-file '.\output\manwafl[漫].js' --level l3 --engine auto
```

L3 通过后，如果需要给 App 导入，再上传云剪切板：

```powershell
node <skill-root>/scripts/aibox-skill-cli.mjs share --code-file '.\output\manwafl[漫].js' --name '漫蛙漫画[漫]' --category comic --group-tag 漫画
```
