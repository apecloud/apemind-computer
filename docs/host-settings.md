# 宿主运营配置：一份完整文件，热更新

[architecture.md](architecture.md) 回答「两边怎么分工、控制 API 有哪些」。
[lifecycle.md](lifecycle.md) 回答「实例怎么启停、闲置怎么回收」。
[pairing.md](pairing.md) 回答「密钥存在哪、一对一怎么约束」。
[stability.md](stability.md) §6 回答「每户内存限额以后怎么进同一份文件」。

本文放大其中一层：**运营旋钮只认一份磁盘文件，文件必须带齐全部字段，
打开就能看见生效值。** 不再为这些旋钮保留环境变量，也不再允许「字段缺席
再回退 env」。镜像自带出厂文件；Helm / compose 删掉对应 env。

## 1. 现状

host-agent 启动时 `loadConfig()` 把全部 `COMPUTER_*` 读进内存，之后不再读。
闲置回收用的是冻住的 `idleTimeoutSec`。磁盘只有 `/data/host.json`（配对身份）。
`PUT /v1/runtime` 只能改 `main_url`。

要改 scale-to-zero，只能改 Deployment env 并重启宿主，所有 running 的 dsh 会被打断。

两套来源（env + 可选文件、字段可缺）看起来像两份真源，打开文件还不敢确定缺的键
到底是默认还是忘了写。本方案去掉这套叠加。

## 2. 目标

- **运营旋钮只有一份权威：`/data/settings.json`。** 五个字段必须同时在，数值就是生效值。看文件等于看配置，和看一份 values YAML 一样。
- **镜像带出厂完整文件。** 数据卷上还没有这份文件时，启动从镜像拷一份过去，不读 env 拼默认。
- **删掉这五个旋钮的环境变量。** Helm / compose 同步删；装机定制走文件或配对后的控制 API，不走 env。
- **控制 API 改完写盘并替换内存**，不轮询、不 SIGHUP、不热读 `.env`。
- **配对密钥仍在 `host.json`，不和旋钮混写。**
- **ApeMind 不是回收判定的真源。** 管理页 GET/PUT runtime；`computer.host` 最多记上次下发副本。
- **第一期管理页只暴露闲置秒数。** 其余字段接口里一起带齐，页面先不放开。

## 3. 两层配置

| 层 | 载体 | 谁改 | 何时生效 |
| --- | --- | --- | --- |
| 部署事实 | 启动 env | 装机 / Helm / compose | 必须重启进程 |
| 运营旋钮 | `/data/settings.json`（完整） | 控制 API；首次由镜像出厂文件生成 | 写盘即换内存，见 §6.3 |

部署事实仍走 env：监听端口、`COMPUTER_DATA_DIR`、`COMPUTER_PUBLIC_ORIGIN`、
`COMPUTER_UID_BASE` / 回环隔离、`COMPUTER_PAIR_CODE`、`COMPUTER_DSH_COMMAND`、
`COMPUTER_PORT_BASE`、预共享密钥兼容垫。它们绑着 socket、PVC、Ingress 和 capability。

**删除、落地后代码与模板都不再认识的 env：**

- `COMPUTER_IDLE_TIMEOUT_SEC`
- `COMPUTER_SESSION_TTL_SEC`
- `COMPUTER_READY_TIMEOUT_SEC`
- `COMPUTER_STOP_GRACE_SEC`
- `COMPUTER_MAX_INSTANCES`

`main_url` 继续走 `host.json`（已配对）或 `COMPUTER_MAIN_URL`（兼容模式），不进 `settings.json`。

## 4. 出厂文件与数据卷

镜像内固定路径（只读）：

```
/usr/local/share/apemind-computer/settings.json
```

内容永远完整，与代码默认一致：

```json
{
  "idle_timeout_sec": 1800,
  "session_ttl_sec": 7200,
  "ready_timeout_sec": 90,
  "stop_grace_sec": 10,
  "max_instances": 200
}
```

数据根 `COMPUTER_DATA_DIR`（默认 `/data`）是 PVC，会盖住镜像里的 `/data`，所以出厂文件不能只放在 `/data` 里。

```
/data/host.json        0600   配对身份（pairing.md §4）
/data/settings.json    0600   运营旋钮，五个字段必须齐
/data/users/<key>/     …      租户 HOME
```

启动时保证数据卷文件完整：

1. `/data/settings.json` 不存在 → 把镜像出厂文件原样拷过去（`0600`）。
2. 存在但是合法 JSON、缺了当前版本认识的键 → 缺的键用出厂值补上，写回完整文件（镜像升级加字段时用）。
3. 存在但不是 JSON、根不是对象、或某个已有字段类型/范围非法 → 打 error 日志，**用出厂文件整份覆盖**。不带着残缺文件跑，也不静默回退到已删除的 env。
4. 多出来的未知键：启动时忽略，写回时丢掉，避免旧实验字段一直待着。

写盘与 `host.json` 相同：同目录临时文件 + `rename`。禁止往这份文件写令牌、签票密钥、`main_url`。

进程跑起来之后，内存里的旋钮与文件字节级对应（五个整数）。运维 `cat /data/settings.json` 看到的就是正在用的值。

装机时若 Helm 需要非出厂值：挂一份完整的 settings 到数据卷（或配对后 `PUT`）。不要再提供「只改某一个 env」。compose 示例同样删掉那五个环境变量。

## 5. 不再有解析叠加

没有「文件 → env → 代码」三条线。启动只做 §4 的「保证文件完整，然后读文件」。之后只被 `PUT /v1/runtime` 改。

曾用 `COMPUTER_IDLE_TIMEOUT_SEC=60` 的现网：升级后该 env 被忽略，第一次启动会写出厂 1800。若仍要 60 秒，升级后在管理页再存一次，或预先放好完整的 `/data/settings.json`。

## 6. 控制 API

不新开路径。扩 `:9090` 的 `GET/PUT /v1/runtime`。未配对 GET 仍无 Bearer，只回 `state` / `public_origin` / `version`。运营旋钮只在**已配对**的 GET 里出现。

实现以 `host-agent/src/control.ts` 为准。本文是契约。

### 6.1 `GET /v1/runtime`（已配对）

```json
{
  "state": "paired",
  "public_origin": "https://computer.example.com",
  "version": "v0.2.6",
  "main_url": "https://app.example.com",
  "paired_at": "2026-08-31T00:01:00.000Z",
  "settings": {
    "idle_timeout_sec": 1800,
    "session_ttl_sec": 7200,
    "ready_timeout_sec": 90,
    "stop_grace_sec": 10,
    "max_instances": 200
  }
}
```

`settings` 五个键必须都在，没有 `*_source`。GET 不回令牌或签票密钥。

### 6.2 `PUT /v1/runtime`

补丁：省略的字段保持文件里的值；`null` 表示该字段回到**镜像出厂值**（不是删键）。写回后文件仍然五个键齐全。

```json
{
  "main_url": "https://app.example.com",
  "settings": {
    "idle_timeout_sec": 900,
    "session_ttl_sec": null
  }
}
```

上例：闲置改成 900；会话 TTL 回到出厂 7200；其余三个不动。

- `settings` 省略：只按今天规则处理 `main_url`（旧客户端兼容）。
- `settings` 为空对象：旋钮全不动。
- 未知键：整次 400，磁盘与内存不动。
- 非 `null` 且非合法整数：整次 400。

| 字段 | 最小 | 最大 | `0` 的含义 | 出厂 |
| --- | --- | --- | --- | --- |
| `idle_timeout_sec` | 0 | 86400 | 关闭闲置回收 | 1800 |
| `session_ttl_sec` | 60 | 604800 | 不允许 | 7200 |
| `ready_timeout_sec` | 5 | 300 | 不允许 | 90 |
| `stop_grace_sec` | 1 | 120 | 不允许 | 10 |
| `max_instances` | 1 | 10000 | 不允许 | 200 |

越界 → 400，`{error: "<field> out of range"}`。

成功：写出完整 `settings.json` → 换内存 → 200，body 与 GET 相同。

预共享兼容模式：可以 PUT `settings`；`main_url` 仍 409。

### 6.3 热改何时生效

| 字段 | 生效点 |
| --- | --- |
| `idle_timeout_sec` | 下一次 `idleSweep`（≤60s）。已在停的不回滚。`0` 之后不再因闲置新停；`desired=running` 的休眠实例仍靠流量唤醒。 |
| `session_ttl_sec` | 之后新签的 cookie。已发出的仍按其签发时的 `e`。 |
| `ready_timeout_sec` | 下一次冷启动 / 唤醒。 |
| `stop_grace_sec` | 下一次 SIGTERM 宽限。 |
| `max_instances` | 下一次要新占槽位的 `ensure`。下调不杀已有实例，只拦超员新开（507）。 |

不通知 dsh。dsh 无配置协议。

## 7. ApeMind 侧

1. 宿主内存 = `/data/settings.json`（`GET /v1/runtime.settings`）。
2. `computer.host` 可选记下上次下发，仅宿主暂时不可达时回显，**不参与回收**。

`/admin/computer` 第一期一个「闲置多久停进程」：打开拉 runtime；保存时 PUT。宿主 4xx / 不可达则保存失败，不把失败值写成 ApeMind 真源。

工作区页、侧栏、开通名单不读这些旋钮。`GET /api/v2/computer` 的轮询不续命。

## 8. 兼容与升级

- 旧数据卷没有 `settings.json`：第一次用新镜像启动，拷出厂文件，闲置 1800。与今天没改过 env 的行为相同。
- 旧数据卷只改过 env、没有文件：升级后 env 失效，回到出厂 1800，须在管理页再存，或事先放入完整 `settings.json`。
- 旧 ApeMind 只 PUT `main_url`：新宿主旋钮不动，文件保持完整。
- 新 ApeMind 打旧宿主：GET 没有 `settings` 则管理页该字段只读，提示升级宿主镜像。
- Helm chart / `compose.example.yml` / README 配置表：落地时删掉 §3 那五个 env，改指向本文和出厂文件。

## 9. 不解决什么

- 按用户 / 组织不同闲置超时。
- 热改 Origin、端口、数据目录、uid、隔离、dsh 命令、端口起点。
- 给 dsh 加心跳。
- 保留运营旋钮的 env 作为第二套缺省。
- 允许 `settings.json` 缺字段或空对象当正常状态。
- 多 host 调度（每台自己一份完整文件，1∶N 时逐台 PUT）。
- 配额、计费。
- 生产发布与现网改值。

## 10. 落地顺序

1. **本仓**：镜像加入出厂文件；启动保证 `/data/settings.json` 完整；删五个 env；扩 runtime；supervisor 读文件值；Helm / compose / README 同步删 env。单测：缺文件则拷出厂、缺键则补齐、坏文件覆盖、PUT 补丁与 `null` 回出厂、越界 400、文件始终五键、idleSweep 用新值、启动不再读已删 env。
2. **aperag-enterprise**：host client 认识 `settings`；管理页一个闲置字段；GET 无 `settings` 时降级。
3. 先发 computer-host 镜像，再发 ApeMind。

## 11. 验收

1. 空数据卷启动后 `/data/settings.json` 与镜像出厂文件五个键、值都相同。
2. 已配对 PUT `idle_timeout_sec=60`，GET 与文件都是 60，其余四键仍在；60～120 秒无流量则停进程，`desired` 仍 running，cookie 能唤醒。
3. PUT `idle_timeout_sec=0` 后不再因闲置新停。
4. PUT `idle_timeout_sec=null` 后文件该键为 1800，五个键仍齐。
5. 未知键 / 越界 → 400，文件不变。
6. 多次 PUT 后 `host.json` 令牌字节级不变。
7. 设了已删除的 `COMPUTER_IDLE_TIMEOUT_SEC=60` 再启动，生效值仍是文件里的数，不是 60。
8. 人为删掉数据卷上该文件再重启，重新出现完整出厂文件。

## 读完后能回答的问题

- 运营旋钮为什么不再用 env？缺字段为什么不允许？
- 镜像出厂文件在哪，为什么不能只放在 `/data`？
- 数据卷上没有文件、缺键、文件损坏时，启动各做什么？
- `GET/PUT /v1/runtime` 的 `settings` 长什么样，`null` 回到哪里？
- 改闲置超时最晚多久按新值回收？改会话 TTL 影不影响已发出的 cookie？
- 以前只改过 Helm 里的 `COMPUTER_IDLE_TIMEOUT_SEC`，升级后会怎样？
- ApeMind 数据库是不是回收真源？第一期页面暴露什么？
