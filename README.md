# 网关 Dashboard

Node.js 24 原生 HTTP 控制面板，无运行时 npm 依赖。提供 mihomo、OxiDNS 和 Tailscale 的状态，并统一三个入口的语言与深浅主题。

| 域名 | 功能 |
|---|---|
| `board.proxy.asterwyx.top` | Dashboard |
| `mihomo.proxy.asterwyx.top` | Zashboard，使用同源 `/mihomo-api` |
| `oxidns.proxy.asterwyx.top` | OxiDNS 原生 WebUI |

Zashboard 作为独立的 `mihomo-ui` sidecar 从官方 GHCR 镜像运行；Dashboard 镜像不包含 Zashboard。网关代理 sidecar，并只在前端 HTML 的最前面加入同源偏好脚本，不包装 fetch/WebSocket，不修改上游 API。

从 Yacd 迁移后，`mihomo` 根地址会首次显示一次清理页，注销该域名的旧 Service Worker 并删除浏览器缓存。旧 Yacd 与 Zashboard 使用相同的根路径和缓存作用域；不清理时，浏览器可能在请求服务器前就返回 Yacd。Zashboard 随后继续使用自己的 PWA，清理逻辑只处理顶层 `/` 的不带 `frontend=zashboard` 的首次导航。

固定上游为 mihomo `127.0.0.1:9090`、OxiDNS `127.0.0.1:9199` 和 Tailscale Unix socket。Ingress 必须保留原始 Host。客户端无法指定任意反代目标；后端凭据仅在服务器注入。

## 本地运行与镜像

需要 Node.js 24+。Dashboard 自身无前端编译步骤；本地运行 Zashboard 时需另起静态文件服务，默认地址为 `127.0.0.1:80`。

```bash
DASHBOARD_USER=admin \
DASHBOARD_PASSWORD_FILE=/path/to/dashboard-password \
MIHOMO_SECRET_FILE=/path/to/mihomo-secret \
OXIDNS_PASSWORD_FILE=/path/to/oxidns-password \
TS_SOCKET=/var/run/tailscale/tailscaled.sock \
npm start

npm test
docker build -t proxy-gateway-dashboard .
```

密码文件默认位于 `/run/secrets/`，监听 `0.0.0.0:8080`。凭据在启动时读取，轮换后需重启。`FAKEIP_CIDR` 固定为 `198.20.0.0/16`。

Docker 镜像仅包含 Node 和 Dashboard 应用文件。CI 先运行测试，再构建 `linux/amd64` 镜像；PR 不发布镜像。更新线上版本需发布镜像，并在 Kubernetes 部署仓库固定新的 digest。Zashboard 版本在独立 sidecar 的部署清单中管理。

## 主题和语言

登录页与 Dashboard 默认选择“跟随浏览器”：语言按浏览器的语言顺序选择中文或英文，主题监听 `prefers-color-scheme`。自动检测不会保存为手动选择；手动设置后可随时重新选择“跟随浏览器”。

Dashboard 使用非敏感的 `gateway_preferences` Cookie 共享设置，范围为 `proxy.asterwyx.top`。子页面加载、恢复可见或 Dashboard 设置改变时应用偏好。可见页面每秒检查一次，后台页面在恢复时更新。认证仍使用单独的 HttpOnly 会话 Cookie。

主题变化直接更新原生主题。OxiDNS 的语言通过其原生语言按钮更新。Zashboard 在设置页可直接更新语言；实时接收 Dashboard 新设置时会保留当前路由。若有打开的对话框或正在编辑的输入框，会显示“应用 Dashboard 的语言设置”按钮，让用户完成编辑后再应用。

## API 与安全边界

- `GET /healthz`：无需认证的健康检查，不透露上游状态。
- `GET /api/overview`：聚合 mihomo、OxiDNS 与 Tailscale 的真实数据；单项失败不抹去其它结果。
- `POST /api/tailscale/prefs`：只允许 `WantRunning`、`ShieldsUp` 和空列表或固定 fake-IP 路由，转换为 EditedPrefs。
- `GET/POST /login`：标准表单登录；签发 8 小时的 HMAC 签名会话，`HttpOnly; Secure; SameSite=Strict`，三个子域共享。
- `POST /logout`：撤销当前会话并清除 Cookie。
- 自建修改接口要求同 Host 的 Origin 和 `X-Dashboard-Request: 1`。
- 上游修改检查同源 Origin 与 Fetch Metadata。POST 额外限制 JSON 或明确空请求体；PUT/PATCH/DELETE 是非简单方法，可接受原生客户端使用的内容类型。
- mihomo WebSocket 仅在 API 路径开放，并要求有效会话与同源 Origin。

原 MetaCubeXD 用 `text/plain` 发送 JSON 字符串的策略切换 PUT，旧网关因此返回 403。现在该请求保留同源校验并正常转发；成功的空 204 响应原样返回。中文策略组名称及包含斜杠的节点组名称有回归覆盖。

不提交或记录凭据。客户端 Cookie、Authorization、Origin 和 Forwarded 不转发；服务器注入 mihomo Bearer 与 OxiDNS BasicAuth，移除 URL token，并脱敏 mihomo JSON 中的 secret。容器访问 Tailscale LocalAPI 时使用 UID 0，部署应保留 drop ALL capabilities、只读根文件系统和禁止提权。

## 验证

`npm test` 使用 `node:test`，覆盖认证、CSRF、策略组切换、偏好校验、部分降级、静态前端、压缩 JSON、WebSocket，以及浏览器默认设置与跨域偏好共享。

迁移回归测试用 `node --test --test-name-pattern='legacy Yacd' test/dashboard.test.js` 单独运行；测试会绑定本地临时端口，受限沙箱中需授予监听权限。

浏览器验证使用本地 Zashboard 静态构建和本地模拟后端，不修改线上策略：

```bash
npm install --no-save --package-lock=false playwright
npx playwright install chromium
node tools/verify-browser.mjs
```

截图写入忽略的 `artifacts/`。测试检查界面实际语言与主题、切换后的节点组、刷新后的状态及手机宽度布局。
