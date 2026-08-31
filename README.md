# ApeMind Computer

多租户 dsh（[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)）托管服务。
一个容器内运行一个 host-agent 和 N 个 dsh 实例（每租户一个，绑定回环端口），对外提供：

- **公网网关（:8080）**：短票换会话 cookie，之后按 cookie 把 HTTP/WebSocket 流量反代到
  该租户的 dsh；转发前把 `Host` 重写为回环地址并剥掉 `Origin`/`sec-fetch-*`，dsh 的
  回环信任门禁天然放行，dsh 本身零改动、零登录。
- **控制 API（:9090）**：实例生命周期（ensure/status/delete）与容量健康，仅供内网
  控制面调用。完整架构与契约见 [docs/architecture.md](docs/architecture.md)。

控制面（如 ApeMind）与本服务共享签票密钥与控制令牌。默认在控制口自动配对
交换后各自落盘，人不搬运密钥；环境变量预共享保留为兼容模式，见
[docs/pairing.md](docs/pairing.md)。
租户标识对本服务不透明；票据、会话与控制 API 见
[docs/architecture.md](docs/architecture.md) 第 5、6 节，跨语言测试向量在
[tests/vectors/](tests/vectors/)。

## 目录

```
host-agent/   Node 服务（TypeScript，零运行时依赖，esbuild 打成单文件）
  src/        gateway / control / supervisor / ticket / config
  test/       node:test 单元与集成测试（内置 fake dsh）
docs/         架构（architecture.md）、生命周期（lifecycle.md）、配对与认证（pairing.md）
tests/vectors 票据 golden vectors（Python 生成，双端测试共用）
deploy/       Kubernetes Helm chart（独立发布，不绑 ApeMind 主 chart）
Dockerfile    运行镜像（node:22-bookworm-slim + 锁版本 dsh + host-agent）
```

## 开发

```bash
cd host-agent
npm install
npm run typecheck
npm test
npm run build        # 产出 dist/host-agent.mjs
```

本地起一个最小实例（需要全局安装 dsh，或用 COMPUTER_DSH_COMMAND 指向任意兼容命令）：

```bash
COMPUTER_TICKET_SECRET=dev-secret \
COMPUTER_CONTROL_TOKEN=dev-token \
COMPUTER_PUBLIC_ORIGIN=http://127.0.0.1:8080 \
COMPUTER_DATA_DIR=/tmp/computer-data \
node dist/host-agent.mjs
```

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `COMPUTER_TICKET_SECRET` | 必填 | 与控制面共享的签票密钥 |
| `COMPUTER_CONTROL_TOKEN` | 必填 | 控制 API 的 Bearer 令牌 |
| `COMPUTER_PUBLIC_ORIGIN` | 必填 | 网关对外 Origin，用于跨站校验与 cookie Secure |
| `COMPUTER_MAIN_URL` | `https://apemind.ai` | 无会话/无实例时跳回的主站 |
| `COMPUTER_DATA_DIR` | `/data` | 租户工作区根目录（持久卷） |
| `COMPUTER_GATEWAY_PORT` / `COMPUTER_CONTROL_PORT` | `8080` / `9090` | 监听端口 |
| `COMPUTER_PORT_BASE` | `31000` | dsh 回环端口起点 |
| `COMPUTER_MAX_INSTANCES` | `200` | 实例容量上限 |
| `COMPUTER_IDLE_TIMEOUT_SEC` | `1800` | 闲置自动停进程（工作区保留，触达即唤醒） |
| `COMPUTER_SESSION_TTL_SEC` | `43200` | 会话 cookie 有效期 |
| `COMPUTER_DSH_COMMAND` | `dsh {patch} --profile web --no-open --port {port}` | 实例启动命令模板；`{patch}` 在存在托管配置时展开为 `--patch <文件>` |
| `COMPUTER_UID_BASE` | `0`（关闭） | 每实例独立 uid 的起始值，开启需容器内 root |
| `COMPUTER_LOOPBACK_ISOLATION` | 关闭 | 按 uid 装回环 iptables 规则，防租户串访，需 NET_ADMIN |

## 镜像

镜像只在 GitHub Actions 构建（推 tag `v*.*.*` 触发），不在本地构建。dsh 版本在
Dockerfile 的 `DSH_VERSION` 中锁定，升级 dsh 一律走新镜像 tag 加回归验证。

## Kubernetes

独立 Helm chart 在 `deploy/`。控制面只需要把 `COMPUTER_HOST_URL` 指到 chart 打出的
`:9090` Service，并使用同一对 `ticketSecret` / `controlToken`。

```bash
helm upgrade --install computer-host ./deploy \
  --namespace apemind \
  --set publicOrigin=https://computer.example.com \
  --set ticketSecret="$COMPUTER_TICKET_SECRET" \
  --set controlToken="$COMPUTER_CONTROL_TOKEN"
```

从 ApeMind 主 chart 的 `computerHost` 块迁出时：先给现有 PVC 打上
`helm.sh/resource-policy=keep`，关掉主 chart 的 `computerHost.enabled`，再用
`values-adopt.example.yaml` 里的 `fullnameOverride` 与 `selectorLabels` 做
`helm upgrade --install --take-ownership`，保住磁盘和工作区。Deployment 的
selector 不能改，必须和现网一致。

## 安全边界

- 网关只信两样东西：共享密钥签出的票据/会话，以及回环上的 dsh。
- 同容器多租户共享内核；开启 `COMPUTER_UID_BASE` 与 `COMPUTER_LOOPBACK_ISOLATION`
  后可做到文件互不可读、回环端口互不可达，但恶意租户逃逸风险不为零，
  更强隔离需要按租户拆 Pod/microVM。
- 结构化 JSON 日志不落票据、cookie、API key 与对话内容；dsh 自身输出写到
  各租户 `~/.apemind/dsh.log`。
