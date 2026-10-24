# Aibox 源启动配置协议

## 适用范围

源需要下列任一能力时，使用 `rule.more.aibox.setup` 声明配置，不要自行设计 Flutter 页面：

- 用户选择接口地址、线路、地区、清晰度或其他选项。
- 用户保存默认筛选范围、搜索线路、搜索模式或关键词处理偏好。
- 用户填写账号、密码、Token、Cookie 或其他私密参数。
- 首次进入源前必须完成配置。
- 通过受控 WebView 登录，并把指定 Cookie 回填给源。
- 保存后调用源内动作验证账号或接口是否可用。

旧源不声明 `more.aibox.setup` 时行为不变。

## 完整示例

```javascript
var rule = {
    title: '参数源示例',
    host: 'https://api.example.com',
    url: '/list?page=fypage',
    searchUrl: '/search?wd=**&page=fypage',
    searchable: 2,
    quickSearch: 0,
    filterable: 0,

    more: {
        aibox: {
            setup: {
                version: 1,
                title: '登录与参数',
                description: '选择线路，并填写当前源所需的凭据。',
                required: true,
                trigger: 'firstUse',
                validateAction: 'aibox.setup.validate',
                registerUrl: 'https://account.example.com/register',
                registerLabel: '没有账号？打开注册页面',
                sections: [
                    {
                        key: 'account',
                        title: '账户与接口',
                        icon: 'account'
                    },
                    {
                        key: 'search',
                        title: '筛选与搜索',
                        description: '设置长期默认值；分类页本次筛选仍可覆盖这些设置。',
                        icon: 'search'
                    },
                    {
                        key: 'advanced',
                        title: '高级设置',
                        icon: 'advanced',
                        collapsible: true,
                        defaultExpanded: false
                    }
                ],
                fields: [
                    {
                        key: 'apiUrl',
                        type: 'url',
                        label: '接口地址',
                        section: 'account',
                        required: true,
                        placeholder: 'https://api.example.com',
                        fullWidth: true
                    },
                    {
                        key: 'region',
                        type: 'select',
                        label: '线路',
                        section: 'account',
                        default: 'cn',
                        options: [
                            {label: '国内', value: 'cn'},
                            {label: '海外', value: 'global'}
                        ]
                    },
                    {
                        key: 'username',
                        type: 'username',
                        label: '账号',
                        section: 'account'
                    },
                    {
                        key: 'password',
                        type: 'password',
                        label: '密码',
                        section: 'account'
                    },
                    {
                        key: 'token',
                        type: 'token',
                        label: '访问令牌',
                        section: 'account',
                        required: true
                    },
                    {
                        key: 'cookie',
                        type: 'cookie',
                        label: '登录 Cookie',
                        section: 'account'
                    },
                    {
                        key: 'searchMode',
                        type: 'radio',
                        label: '搜索方式',
                        section: 'search',
                        default: 'fuzzy',
                        options: [
                            {label: '模糊', value: 'fuzzy'},
                            {label: '精确', value: 'exact'}
                        ]
                    },
                    {
                        key: 'contentTypes',
                        type: 'multiSelect',
                        label: '搜索范围',
                        section: 'search',
                        default: ['anime'],
                        maxSelections: 2,
                        options: [
                            {label: '番剧', value: 'anime'},
                            {label: '电影', value: 'movie'},
                            {label: '小说', value: 'novel'}
                        ]
                    },
                    {
                        key: 'searchPages',
                        type: 'slider',
                        label: '最大搜索页数',
                        section: 'search',
                        default: 3,
                        min: 1,
                        max: 10,
                        step: 1
                    },
                    {
                        key: 'enhanced',
                        type: 'switch',
                        label: '启用增强接口',
                        section: 'advanced',
                        default: false
                    },
                    {
                        key: 'backupApiUrl',
                        type: 'url',
                        label: '增强接口地址',
                        section: 'advanced',
                        fullWidth: true,
                        required: true,
                        visibleWhen: {field: 'enhanced', equals: true}
                    }
                ],
                webLogin: {
                    label: '网页登录',
                    url: 'https://account.example.com/login?region=${region}',
                    allowedHosts: ['account.example.com'],
                    cookieDomains: ['account.example.com'],
                    cookieNames: ['session', 'csrf_token'],
                    requiredCookies: ['session'],
                    successUrlPatterns: ['/home', '/user/center'],
                    resultKey: 'cookie'
                }
            }
        }
    },

    预处理: async function (env) {
        const setup = env.aibox?.setup || {};
        if (setup.apiUrl) {
            rule.host = setup.apiUrl.replace(/\/+$/, '');
        }
        if (setup.cookie) {
            rule.headers = {
                ...(rule.headers || {}),
                Cookie: setup.cookie
            };
        }
        if (setup.token) {
            rule.headers = {
                ...(rule.headers || {}),
                Authorization: `Bearer ${setup.token}`
            };
        }
    },

    action: async function (action, value) {
        if (action !== 'aibox.setup.validate') {
            return {ok: false, message: '未知动作'};
        }
        const setup = JSON.parse(value || '{}');
        if (!setup.token) {
            return {ok: false, message: 'Token 不能为空'};
        }
        const response = await request(`${setup.apiUrl}/user/profile`, {
            headers: {Authorization: `Bearer ${setup.token}`}
        });
        const profile = JSON.parse(response);
        return profile?.id
            ? {ok: true}
            : {ok: false, message: '账号验证失败'};
    }
};
```

## setup 顶层字段

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `version` | number | `1` | 表单协议版本。字段语义变化时递增。 |
| `title` | string | `源配置` | Flutter 配置页标题。 |
| `description` | string | 空 | 配置页简短说明。 |
| `required` | boolean | `false` | 为 `true` 时，必填字段未完成就不进入源。 |
| `trigger` | string | 按 required 推导 | `firstUse` 或 `manual`。只有 `required: true` 且为 `firstUse` 才首次自动弹出。 |
| `validateAction` | string | 空 | 保存并注入后调用的 `rule.action` 动作名。 |
| `registerUrl` | string | 空 | 可选 HTTP/HTTPS 注册地址，由系统外部浏览器打开。 |
| `registerLabel` | string | `没有账号？打开注册页面` | 注册入口文案。 |
| `sections` | array | 空 | 可选 UI 分区，最多 12 个；旧源不声明时保持单组表单。 |
| `fields` | array | 空 | 最多 32 个声明式字段。 |
| `webLogin` | object | 无 | 可选的受控 WebView 登录配置。 |

`trigger: manual` 不会自动弹窗，但用户仍可从源长按菜单的“源配置 / 登录”进入。`required: true` 时，即使选择手动触发，必填项未完成也不会请求源。

只要声明了 `webLogin`，影视、小说和漫画内容页的当前源旁、源选择列表里都会显示“登录 / 验证”按钮。快捷登录取得 Cookie 后会立即写入对应敏感字段、重新注入当前 drpy 模块并使当前内容缓存失效，不需要重启 App 或手动切换源。若还有其他必填字段未填写，Cookie 仍会保留，用户随后可在完整配置页补齐。

## fields 字段

每个字段必须有合法 `key` 和 `type`。`key` 规则为 `^[A-Za-z][A-Za-z0-9_.-]{0,63}$`，同一表单内不能重复。

| 字段 | 类型 | 说明 |
|---|---|---|
| `key` | string | 注入到 `env.aibox.setup[key]` 的键。 |
| `type` | string | `text`、`username`、`password`、`token`、`cookie`、`url`、`number`、`textarea`、`select`、`radio`、`multiSelect`、`slider`、`switch`。 |
| `label` | string | 界面标签；为空时回退到 key。 |
| `description` | string | 字段补充说明。 |
| `placeholder` | string | 文本输入占位内容。 |
| `required` | boolean | 是否必填。 |
| `sensitive` | boolean | 将普通字段升级为敏感字段。不能把 username、password、token、cookie 降级为非敏感。 |
| `backup` | boolean | 普通字段是否进入 AiBox 备份。设为 `false` 后按私密字段存储和传输。 |
| `default` | string/number/bool | 非敏感字段默认值。禁止把真实密码、Token 或 Cookie 写成默认值。 |
| `options` | array | `select`、`radio`、`multiSelect` 选项，格式 `{label, value}`，最多 100 项且 value 不能重复。 |
| `section` | string | 可选分区 key；未知分区会回到“基础设置”。 |
| `fullWidth` | boolean | 宽屏时是否跨两列；手机端所有字段始终单列。 |
| `visibleWhen` | object | 条件显示，支持 `equals`、`notEquals`、`oneOf`、`isSet`。 |
| `step` | number | `slider` 的正数步长。 |
| `maxSelections` | number | `multiSelect` 最多可选数量。 |
| `pattern` | string | 可选正则校验。 |
| `validationMessage` | string | 正则或长度校验失败提示。 |
| `minLength` / `maxLength` | number | 文本长度限制。 |
| `min` / `max` | number | 数字范围限制。 |

`username`、`password`、`token`、`cookie`、`sensitive: true` 以及 `backup: false` 字段均使用系统安全存储，不进入普通 ZIP 备份。普通字段允许随应用设置备份和恢复。

## UI 分区、控件与联动

配置页采用手机单列、宽屏双列布局。`textarea`、`multiSelect`、选项较多的 `radio` 以及 `fullWidth: true` 字段在宽屏也会跨整行。保存按钮固定在页面底部；源作者只声明语义，不声明像素、颜色或 Flutter 组件。

`sections` 项支持：

| 字段 | 说明 |
|---|---|
| `key` | 唯一分区 key，格式与字段 key 相同。 |
| `title` | 分区标题。 |
| `description` | 可选的一句补充说明。 |
| `icon` | `account/user/login`、`search`、`play/playback`、`network/line/server`、`filter/filters`、`advanced/settings`；未知值回退为调节图标。 |
| `collapsible` | 是否可折叠。账户和必填项通常不折叠，高级设置可折叠。 |
| `defaultExpanded` | 折叠分区首次是否展开，默认 `true`。 |

控件选择要求：

- `select`：普通下拉选择，适合选项较多的线路、地区或排序。
- `radio`：互斥模式，Flutter 使用分段控件；必须提供非空 `options`。
- `multiSelect`：多个范围或标签，值注入为字符串数组；必须提供非空 `options`。
- `slider`：连续或固定步长数值，值注入为 number；使用 `min/max/step`，建议同时声明 `default`。
- `switch`：独立开关。
- 不要为了视觉效果滥用类型；接口地址仍用 `url`，固定线路仍优先用 `select`。

条件显示示例：

```javascript
{
    key: 'backupApiUrl',
    type: 'url',
    label: '备用搜索接口',
    required: true,
    fullWidth: true,
    visibleWhen: {field: 'advancedSearch', equals: true}
}
```

还可使用：

```javascript
visibleWhen: {field: 'searchMode', notEquals: 'simple'}
visibleWhen: {field: 'contentTypes', oneOf: ['anime', 'movie']}
visibleWhen: {field: 'token', isSet: true}
```

隐藏字段不会阻塞必填校验，但之前保存的值仍会保留并注入；源逻辑必须根据控制字段决定是否使用它。条件字段应引用同一表单中稳定存在的字段，避免循环依赖。

## 筛选与搜索偏好

setup 适合保存源级长期偏好：默认地区、默认排序、搜索线路、精确/模糊模式、内容范围、关键词清洗和最大搜索页数。分类页的本次筛选继续使用标准 drpy `filter/filter_def/filter_url`，搜索关键词继续使用 `this.KEY`。

```javascript
一级: async function (tid, pg, filter, extend) {
    const setup = rule.aiboxSetup || {};
    const current = extend || {};
    const area = current.area || setup.defaultArea || '';
    const sort = current.sort || setup.defaultSort || 'update';
    // 当前页面筛选 > setup 默认值 > 源内默认值
}

搜索: async function () {
    const setup = rule.aiboxSetup || {};
    let keyword = String(this.KEY || '').trim();
    if (setup.stripSeason === true) {
        keyword = keyword.replace(/第\s*\d+\s*季/g, '').trim();
    }
    const exact = setup.searchMode === 'exact';
    const scopes = Array.isArray(setup.contentTypes)
        ? setup.contentTypes
        : [];
    // 使用 keyword、exact、scopes 和 setup.searchPages 构造搜索请求。
}
```

不要把单次搜索关键词、当前页码或用户本次点击的分类筛选写回 setup。AiBox 聚合搜索页选择“参与搜索的源”属于客户端级偏好，也不应重复声明在某个源的 setup 中。

## 原生账号密码登录

不需要浏览器执行 JavaScript、Cloudflare 或滑块验证时，只在源里声明账号表单和校验动作。Aibox 的通用渲染器会按声明生成页面；Flutter 中不应增加任何站点名、域名、字段或注册链接的专用逻辑。

```javascript
var rule = {
    title: '账号源示例',
    host: 'https://example.com',
    more: {
        aibox: {
            setup: {
                version: 1,
                title: '账号登录',
                description: '部分内容需要登录后播放。',
                required: false,
                trigger: 'manual',
                registerUrl: 'https://example.com/register',
                registerLabel: '没有账号？打开注册页面',
                validateAction: 'aibox.setup.validate',
                fields: [
                    {
                        key: 'username',
                        type: 'username',
                        label: '账号',
                        placeholder: '请输入账号',
                        required: true
                    },
                    {
                        key: 'password',
                        type: 'password',
                        label: '密码',
                        placeholder: '请输入密码',
                        required: true
                    }
                ]
            }
        }
    },

    action: async function (action, value) {
        if (action !== 'aibox.setup.validate') {
            return {ok: false, message: '未知动作'};
        }
        const setup = JSON.parse(value || '{}');
        if (!setup.username || !setup.password) {
            return {ok: false, message: '请输入账号和密码'};
        }
        const cookie = await loginWithAccount(setup.username, setup.password);
        if (!cookie) {
            return {ok: false, message: '登录失败，请检查账号和密码'};
        }
        // 登录态只存在当前规则实例内存，不写 setItem/getItem。
        rule._loginCookie = cookie;
        return {ok: true};
    }
};
```

源在 `action` 中通过参数读取用户本次提交的值，其他阶段通过 `rule.aiboxSetup` 读取。登录接口返回的 Cookie 只可保留在当前规则实例内存，不得使用 `setItem/getItem` 持久化。错误信息只返回可操作提示，不回显账号、密码、Cookie 或请求体。

## Web 登录

`webLogin.resultKey` 必须指向 `fields` 中已声明的字段，通常是 `type: cookie`。

| 字段 | 说明 |
|---|---|
| `label` | 登录页标题和按钮文字。 |
| `url` | HTTP/HTTPS 登录地址，可包含 `${fieldKey}` 模板；替换值会自动进行 URL component 编码。 |
| `allowedHosts` | WebView 允许跳转的域名；自动包含初始 URL 域名，并允许已声明域名的子域。 |
| `cookieDomains` | 允许读取 Cookie 的域名，只接受 `allowedHosts` 授权范围内的域名。 |
| `cookieNames` | 只回填这些 Cookie；强烈建议明确列出。为空时收集已授权 Cookie 域内的全部 Cookie。 |
| `requiredCookies` | 点击完成前必须取得的 Cookie 名。 |
| `successUrlPatterns` | 当前 URL 匹配任一正则或文本时自动尝试完成。 |
| `resultKey` | Cookie 字符串回填字段。 |

WebView 会拦截非 HTTP/HTTPS 跳转和未授权域名。它不会向源开放任意 Cookie 查询能力。若 `cookieDomains` 需要使用父域，例如 `example.com`，必须同时把该父域加入 `allowedHosts`。页面加载完成后，AiBox 会在短时间内轮询必需 Cookie，以兼容登录脚本原地写 Cookie 而不跳转的站点。

页面停止加载后，客户端会在一个短时间窗口内检查 `requiredCookies`。因此 Cloudflare 或登录脚本即使在原 URL 写入 Cookie、没有跳转，也能自动完成。`successUrlPatterns` 命中时会立即尝试读取 Cookie；它是辅助触发条件，不能替代声明为必需的 Cookie。两项都不声明时不会自动退出，用户可点击顶部“完成”按钮手动回收当前 Cookie。

## Cloudflare / 人机验证示例

Cloudflare、滑块、行为验证或需要浏览器执行 JavaScript 的登录墙，不使用 `verifyCode` 或 OCR 硬猜。声明一个最小权限 WebView 登录入口：

```javascript
var rule = {
    类型: '影视', // 小说、漫画同样适用
    title: '需要验证的番剧源',
    host: 'https://example.com',

    more: {
        aibox: {
            setup: {
                version: 1,
                title: '登录验证',
                required: false,
                trigger: 'manual',
                fields: [
                    {
                        key: 'cookie',
                        type: 'cookie',
                        label: '登录 Cookie'
                    }
                ],
                webLogin: {
                    label: '登录 / 验证',
                    url: 'https://example.com/',
                    allowedHosts: [
                        'example.com',
                        'challenges.cloudflare.com'
                    ],
                    cookieDomains: ['example.com'],
                    cookieNames: ['cf_clearance', 'session'],
                    requiredCookies: ['cf_clearance'],
                    successUrlPatterns: ['/home', '/user', '/index'],
                    resultKey: 'cookie'
                }
            }
        }
    },

    预处理: async function (env) {
        const setup = env.aibox?.setup || {};
        if (setup.cookie) {
            rule.headers = {
                ...(rule.headers || {}),
                Cookie: setup.cookie
            };
        }
    }
};
```

写法要求：

- `allowedHosts` 是顶层跳转白名单，不是 Cookie 采集范围；只加入真实登录链路会跳转的域名。
- `cookieDomains` 是 Cookie 读取白名单；通常只写业务域或确有证据需要的登录域。
- `cookieNames` 是回收范围，应明确列出 `cf_clearance`、session 或站点真实登录 Cookie，避免收集无关 Cookie。
- `requiredCookies` 是自动完成的主要依据。只声明实际观察到的 Cookie 名，不要猜测所有 Cloudflare 站点都一定使用同一组 Cookie。
- `successUrlPatterns` 是辅助依据，适用于成功后会跳到用户中心或首页的站点；不要写过宽的 `.*`。
- 登录 Cookie 只在当前源内使用。不要复制到全局 `ENV`，也不要拼进 URL、日志、分享内容或 `extend`。

## 源内读取

模块初始化和 `预处理(env)` 中读取：

```javascript
const setup = env.aibox?.setup || {};
```

初始化后的分类、详情、搜索、播放或正文函数中读取：

```javascript
const setup = rule.aiboxSetup || {};
```

配置只注入当前源。保存新值后，AiBox 会更新配置 revision、强制重新初始化模块并刷新内容缓存，因此 `预处理` 会立即取得新值。不要把这些值复制到全局 `ENV`、源文件或 `setItem/getItem`。

## validateAction 返回协议

保存流程是“安全存储 -> 内存注入 -> validateAction -> 刷新源”。验证动作可返回对象或 JSON 字符串：

```javascript
return {ok: true};
```

失败时：

```javascript
return {ok: false, message: 'Token 已失效'};
```

验证失败时 Flutter 会恢复旧存储值，并把旧配置重新注入引擎。验证动作不要返回或拼接密码、Token、Cookie 等敏感值。

## 本机与远程 drpy-node

- 本机内置 drpy-node：配置通过回环地址 POST 注入，仅保存在 Node 进程内存。
- 远程 drpy-node：普通参数可正常注入；存在私密字段时必须使用 HTTPS。
- 首次向某个“HTTPS origin + 当前源”发送私密配置时，AiBox 会明确询问用户。
- 用户授权仅对当前远程服务器 origin 和当前源有效，不进入普通备份。
- 远程进程重启或连接地址变化后，客户端会重新注入当前配置。
- 远程节点必须包含 `aibox_setup` 协议并返回 `{ok: true, revision}`；旧节点会提示升级。

HTTPS 只能保护传输过程。远程服务器的运营者仍能在服务端进程内接触注入值，因此只应连接用户自己管理或明确可信的 drpy-node。HTTP 远程节点禁止接收任何私密配置。

## 安全红线

- 禁止把账号、密码、Token、Cookie 放入源文件、分享链接、订阅 URL、`extend`、`env.json` 或日志。
- 禁止用 `setItem/getItem` 保存敏感值；它们最终可能落入明文运行时配置。
- 禁止通过 GET query 传递敏感值；AiBox 配置协议只使用 POST body。
- 禁止在校验错误、调试输出、异常文本中回显敏感值。
- 禁止声明与登录无关的 `cookieDomains`；Flutter 会过滤越界域名，但源本身仍应遵循最小权限。
- 禁止在不受信任的远程 drpy-node 上注入凭据，即使它启用了 HTTPS。

## 验收清单

1. 不配置必填项时，首次进入会打开配置页，取消后不请求源。
2. 普通字段、单选、多选和滑杆保存、重启、备份和恢复后仍存在；多选注入数组，滑杆注入 number。
3. 账号、密码、Token、Cookie 和 `backup: false` 字段不出现在备份、URL、日志和 `env.json`。
4. 内容页和源选择列表显示登录入口；Web 登录只能访问授权域，并且只回填指定 Cookie。
5. Cloudflare 原地写入必需 Cookie 后可自动完成；保存后 `预处理(env)` 能读到新值，前台当前源自动刷新且无需重启 App。
6. validateAction 失败时旧配置仍可继续使用。
7. HTTP 远程节点拒绝私密注入；HTTPS 远程节点首次按源确认，确认后可用。
8. 远程旧引擎返回明确升级提示，不把普通首页响应误判为注入成功。
9. 分区在手机上单列、宽屏上合理双列；切换控制字段后 `visibleWhen` 项立即出现或隐藏，隐藏必填项不阻塞保存。
10. 分类本次筛选能覆盖 setup 默认值；搜索仍以 `this.KEY` 为关键词，不把临时搜索状态持久化。
