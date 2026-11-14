# 网关 Dashboard

Node 24 原生 HTTP 服务，无运行时 npm 依赖。中文响应式面板提供真实流量累计值、服务入口、Tailscale 节点表和有限的本地偏好管理。已初始化为独立 Git 仓库；未 commit/push。

## 域名与原版 UI

| 域名 | 功能 |
|---|---|
| `board.proxy.asterwyx.top` | 自建 Dashboard |
| `mihomo.proxy.asterwyx.top` | 原版 MetaCubeXD，根路径 `/` |
| `oxidns.proxy.asterwyx.top` | 原版 OxiDNS WebUI，根路径 `/` |

同一 Pod 中固定上游：mihomo `127.0.0.1:9090`、MetaCubeXD `127.0.0.1:9091`、OxiDNS `127.0.0.1:9199`、Tailscale Unix socket。Ingress 必须保留原始 Host，三个入口均为 HTTPS/443。Host 只选择预先定义的上游，不能指定任意 URL。

**不重构、不修改上游镜像/源码，不替换上游 HTML/JavaScript，不注入 transport wrapper。** OxiDNS API、静态资源、导航路径均原样反代。MetaCubeXD 只使用其官方支持的运行时 `config.js`，配置同源后端 `/mihomo-api`，不向浏览器暴露 mihomo secret。Dashboard 的 `/mihomo/`、`/oxidns/` 是可选跳转到对应 HTTPS 子域名的入口。

`proxy.asterwyx.top` 不属于这个 HTTP 应用，它是独立 TLS/TCP 正向代理；部署说明见上一级 README。

## 镜像

CI 在 push 到默认分支或打 `v*` 标签时构建并发布到：

```text
ghcr.io/asterwyx/proxy-gateway-dashboard:latest
ghcr.io/asterwyx/proxy-gateway-dashboard:sha-<commit>
ghcr.io/asterwyx/proxy-gateway-dashboard:<semver>
```

工作流：`.github/workflows/build.yml`（先 `npm test`，再构建 `linux/amd64` 镜像，含 SBOM 与 provenance）。本仓库不存放凭据；运行时通过 mounted Secret 读取密码文件。

## 运行与测试

```bash
DASHBOARD_USER=admin \
DASHBOARD_PASSWORD_FILE=/path/to/dashboard-password \
MIHOMO_SECRET_FILE=/path/to/mihomo-secret \
OXIDNS_PASSWORD_FILE=/path/to/oxidns-password \
TS_SOCKET=/var/run/tailscale/tailscaled.sock \
node server.js

npm test
```

默认密码文件位于 `/run/secrets/`。监听 `0.0.0.0:8080`，不直接公开此端口。凭据启动时读取，密码轮换需重启。`FAKEIP_CIDR` 只能是 `198.18.0.0/16`。

当前 Kubernetes 部署直接使用原版 `node:24-alpine` 和带哈希的源码 ConfigMap，无需构建镜像；Dockerfile 仅用于独立打包本项目，不构建任何上游派生镜像。

## API 与安全边界

- `GET /healthz`：唯一无需认证的健康检查；不透露上游状态。
- `GET /api/overview`：真实聚合 mihomo `/version`、`/connections`，OxiDNS `/api/health`、`/api/readyz` 和 Tailscale LocalAPI；单项失败不抹去其它有效数据。Tailscale 未 Running 时明确标为不可用。
- `GET /login`、`POST /login`：登录页与凭据提交；`next` 只接受站内相对路径，错误时返回登录页。
- `POST /logout`：清除会话 Cookie。
- `POST /api/tailscale/prefs`：只允许 `WantRunning`、`ShieldsUp` 布尔值及 `AdvertiseRoutes: [] | ['198.18.0.0/16']`，转换为 EditedPrefs。未知字段、AuthKey、出口节点、DNS 配置及任意网段都拒绝。
- 自建修改接口要求同 Host 的 Origin 加 `X-Dashboard-Request: 1`；UI 提交前有确认对话框。
- 上游 UI 修改不需要自定义 JS：网关检查同源 Origin、Fetch Metadata，POST/PUT/PATCH 仅接受 JSON 或显式零长度请求体；不提供跨源 CORS。
- WebSocket 仅开放 mihomo API，要求同源 Origin，并通过 HttpOnly、host-only、SameSite=Strict 的签名会话 cookie 认证（浏览器 WebSocket 不能附加自定义认证头，因此直接复用同一 Cookie）。HTTPS 入口设置 Secure。
- 面板使用独立表单登录 `/login`（字段 `username`、`password`，带标准 `autocomplete`，可被密码管理器填充），不触发浏览器 Basic 弹窗。登录成功后签发 `gateway_session`：HMAC 签名、8 小时有效，`HttpOnly; Secure; SameSite=Strict`，`Domain=proxy.asterwyx.top`，因此 `board`、`mihomo`、`oxidns` 三个子域名共享同一会话。`POST /logout` 清除 Cookie。用户名和密码使用固定长度 SHA-256 与 timingSafeEqual 比较；每 TCP 来源 IP 60 秒最多 8 次失败，成功会清除失败计数。代理后来源地址共享，生产大规模部署应在入口另加限速。
- 客户端认证、cookie、Origin、Forwarded 等不转发；服务端分别注入 mihomo Bearer 与 OxiDNS BasicAuth。mihomo URL token 丢弃，JSON 中的 secret 脱敏。OxiDNS配置使用环境变量密码引用，勿改为明文。
- 凭据不放 Git、不记录请求头/请求体。原版 UI 自身的更新检查等行为由其上游负责。
- Dashboard 使用 UID 0 访问 Tailscale LocalAPI，但容器 drop ALL capabilities、只读根文件系统、禁止提权、无 Kubernetes token，不需要 privileged。

路由开关会替换完整发布列表；重启时官方 Tailscale containerboot 会恢复部署中的 TS_ROUTES。关闭 Tailscale 或开启 ShieldsUp 会影响 **Pod 的独立节点**，不会改变宿主机 `home-0` 节点。路由批准、尾网 ACL 与客户端 DNS 设置需另行配置。

## 验证

`npm test` 包含 12 项原生 node:test 单元/集成测试，覆盖认证/签名 cookie、CSRF、EditedPrefs、部分降级、原样 UI、固定上游、官方运行时配置、压缩 JSON 和浏览器式 WebSocket 认证。

浏览器脚本在 `../tools/verify-browser.mjs`；真实数据面脚本在 `../tools/verify-data-plane.js`。截图输出到 `../artifacts/`，不属于本 Git 仓库。验证时若 Cloudflare Token 仍未填写，浏览器只在测试上下文忽略 ingress 临时证书错误，不代表正式证书已签发。
