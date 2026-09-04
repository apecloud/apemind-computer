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
docs/         架构（architecture.md）、生命周期（lifecycle.md）、稳定性（stability.md）、配对与认证（pairing.md）、宿主运营配置（host-settings.md）、ApeMind 能力结合（apemind-integration.md）、LTS（lts.md）
scripts/      运营脚本（密度压测 density.py）
tests/vectors 票据 golden vectors（Python 生成，双端测试共用）
tests/density 密度脚本的前缀与停条件单测
deploy/       Kubernetes Helm chart（独立发布，不绑 ApeMind 主 chart）
Dockerfile    运行镜像（node:22-bookworm-slim + 锁版本 dsh + apemind CLI + host-agent）
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
| `COMPUTER_DSH_COMMAND` | `dsh {patch} --profile web --no-open --port {port}` | 实例启动命令模板；`{patch}` 在存在托管配置时展开为 `--patch <文件>` |
| `COMPUTER_UID_BASE` | `0`（关闭） | 每实例独立 uid 的起始值，开启需容器内 root |
| `COMPUTER_LOOPBACK_ISOLATION` | 关闭 | 按 uid 装回环 iptables 规则，防租户串访，需 NET_ADMIN |

闲置回收、会话 cookie 寿命、就绪窗口、停进程宽限和实例容量在 `/data/settings.json`（完整五键），出厂文件见镜像内 `/usr/local/share/apemind-computer/settings.json`。配对后用 `GET/PUT /v1/runtime` 的 `settings` 热更新。详见 [docs/host-settings.md](docs/host-settings.md)。

## 密度压测

`scripts/density.py` 打控制面 `PUT /v1/instances/{key}`，按批次拉起真实 dsh。
只接受以 `density` 开头的前缀，退出默认停掉并删除本次建的键。令牌从
`COMPUTER_CONTROL_TOKEN` 或 `--token-file` 读，不进日志。

```bash
# 本地（先 port-forward 控制口 :9090）
COMPUTER_CONTROL_TOKEN=dev-token python3 scripts/density.py \
  --url http://127.0.0.1:9090 --count 20 --batch 10

python3 tests/density/test_density.py
python3 scripts/density.py --cleanup-only --url http://127.0.0.1:9090
```

不要对生产控制面跑。容器内存顶、cgroup 是否降级、闲置回收仍按
[docs/stability.md](docs/stability.md) 生效；本脚本不测网关数据面。

## 镜像

镜像只在 GitHub Actions 构建（推 tag `v*.*.*` 触发），不在本地构建。dsh 版本在
Dockerfile 的 `DSH_VERSION` 中锁定；`pnpm` 由 `corepack` 按 `PNPM_VERSION` 钉死并
放到 PATH（`dsh plugin` 需要它）；官方 IM 插件 `@xmanrui/dsh-im` 和定时任务插件
`@michengai/dsh-automation` 按 `DSH_IM_VERSION` / `DSH_AUTOMATION_VERSION`
预装进 `/opt/dsh-seed/.dsh`，host-agent 拉起实例时写入租户 web profile；
`apemind` CLI 同样构建时锁版本 + sha256，装到 `/usr/local/bin/apemind`
（运行期零下载）。升级 dsh、pnpm、默认插件或 CLI 一律走新镜像 tag 加回归验证。
租户 HOME 与 CLI 身份注入见 [docs/lifecycle.md](docs/lifecycle.md) §1。

当前发布 tag 是 `v0.2.13`。离线机先在联网环境导出镜像再 `docker load`：

```bash
docker pull apecloud/apemind-computer:v0.2.13
docker save apecloud/apemind-computer:v0.2.13 -o apemind-computer-v0.2.13.tar
docker load -i apemind-computer-v0.2.13.tar
```

Compose 样例见 `compose.example.yml`。ApeMind 离线交付把本组件放在
`deploy/components/computer`，不进入核心默认安装。LTS 分支与发版规则见
[docs/lts.md](docs/lts.md)。

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
