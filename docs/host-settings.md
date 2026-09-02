# 宿主运营配置：磁盘权威与热更新

[architecture.md](architecture.md) 回答「两边怎么分工、控制 API 有哪些」。
[lifecycle.md](lifecycle.md) 回答「实例怎么启停、闲置怎么回收」。
[pairing.md](pairing.md) 回答「密钥存在哪、一对一怎么约束」。

本文放大其中一层：**运营中途要拧的旋钮（闲置多久停进程、会话多久过期、容量上限）
权威在哪、启动 env 还管什么、控制面怎么改、改完何时生效**。

落地后闲置回收不再只认启动时冻住的 `COMPUTER_IDLE_TIMEOUT_SEC`。ApeMind 管理页
保存时调宿主控制口，下一轮扫描即按新值回收，不必重启 computer-host。

## 1. 现状

host-agent 启动时 `loadConfig()` 把全部 `COMPUTER_*` 读进内存里的一份 `Config`，
之后不再读环境变量。闲置回收（`idleSweep`，每 60 秒）用的就是这份冻住的
`idleTimeoutSec`。

磁盘上已有的宿主级文件只有 `/data/host.json`，只存配对身份：

- `state` / `control_token` / `ticket_secret` / `main_url` / `paired_at`

`PUT /v1/runtime` 今天只能改 `main_url`。`GET /v1/runtime` 不回闲置超时。
租户侧 `/data/users/<key>/.apemind/env.json` 是打开时注入的数据面凭证，与运营旋钮无关。

因此要改 scale-to-zero 时间，现在只能改 Deployment / compose 的环境变量并重启宿主。
重启会打断所有 running 的 dsh。

## 2. 目标

- **运营旋钮的权威在宿主磁盘**，进程内存持有当前生效值。控制 API 改完立刻写盘并替换内存，不轮询文件、不 SIGHUP、不热读 `.env`。
- **环境变量只当出厂缺省和部署事实**。有文件字段就用文件，不再被同名 env 覆盖。
- **配对密钥与运营旋钮分文件**。改超时不得重写控制令牌或签票密钥。
- **ApeMind 不是超时的真源**。管理页以 `GET /v1/runtime` 展示生效值，保存时 `PUT`；`computer.host` 最多记一份上次成功下发的副本，宿主可达时以宿主为准。
- **第一期管理页只暴露闲置秒数**。同一条 runtime 接口预留会话 TTL、就绪窗口、停进程宽限、容量上限，页面先不放开。

## 3. 两层配置

| 层 | 谁改 | 何时生效 | 例子 |
| --- | --- | --- | --- |
| 部署事实 | 装机 / Helm / compose | 进程启动（改了必须重启） | 监听端口、`DATA_DIR`、对外 Origin、uid / 回环隔离、配对码、dsh 命令模板、回环端口起点 |
| 运营旋钮 | 控制面 API（ApeMind 管理页） | 写盘 + 改内存，立即或下一次扫描 | 闲置超时、会话 TTL、就绪超时、停进程宽限、实例上限 |

部署事实继续只走启动 env，理由是它们绑定 Ingress、PVC、capability 和已监听的 socket，热改会漂 cookie、拆隔离或让控制口失踪。

`COMPUTER_PUBLIC_ORIGIN` 仍是启动权威：换域名必须重启宿主，ApeMind 下次打开会从 `GET /v1/runtime` 刷新 Origin。这与 pairing.md §4 一致。

`COMPUTER_DSH_COMMAND` 与 `COMPUTER_PORT_BASE` 也留在启动 env。它们只影响下一台 spawn，现网几乎不拧；放进热改接口会让「正在跑的实例」和「新实例」用两套命令，第一期不做。

## 4. 磁盘

数据根仍是 `COMPUTER_DATA_DIR`（默认 `/data`）：

```
/data/host.json        0600   配对身份（pairing.md §4）
/data/settings.json    0600   运营旋钮（本文）
/data/users/<key>/     …      租户 HOME（lifecycle.md §1）
```

`settings.json` 只出现已写出过的字段。文件不存在等于「全部旋钮走 env / 代码默认」。空对象 `{}` 与文件不存在同义。

示例（字段均可缺省）：

```json
{
  "idle_timeout_sec": 1800,
  "session_ttl_sec": 7200,
  "ready_timeout_sec": 90,
  "stop_grace_sec": 10,
  "max_instances": 200
}
```

写盘规则与 `host.json` 相同：先写同目录临时文件（`0600`），再 `rename` 覆盖。禁止把令牌、签票密钥、`main_url` 写进这份文件。

损坏或非法 JSON：启动时打 error 日志，整份文件当作不存在，回退 env / 默认；不阻断宿主启动，也不自动改写坏文件（避免运维手改被覆盖）。控制 API 下一次成功 `PUT` 会写出一份合法文件。

单个字段类型不对或越界：该字段回退 env / 默认，其余合法字段仍生效。日志带字段名，不带文件全文。

## 5. 解析顺序

每个运营旋钮独立解析，启动时做一次，之后只被 `PUT /v1/runtime` 替换：

1. `settings.json` 里该字段是合法整数 → 用文件。
2. 否则对应 `COMPUTER_*` env 存在且合法 → 用 env。
3. 否则代码默认（与今天 `config.ts` 相同）。

**文件字段优先于同名 env。** 一旦管理页保存过闲置超时，再改 Deployment 里的 `COMPUTER_IDLE_TIMEOUT_SEC` 不会盖掉文件。要回到 env，控制面必须显式删掉该字段（见 §6），不能靠重启「忘了文件」。

部署事实（端口、Origin、隔离等）没有文件层，仍是启动 env → 代码默认。

`main_url` 继续走 `host.json`（已配对）或 `COMPUTER_MAIN_URL`（兼容模式），不进 `settings.json`。

## 6. 控制 API

不新开路径。扩现有 `:9090` 的 `GET/PUT /v1/runtime`。鉴权不变：未配对的 GET 仍无 Bearer，只回 `state` / `public_origin` / `version`；已配对的 GET/PUT 要控制令牌。运营旋钮**只在已配对**时出现在 GET 里，避免未绑定的控制口把容量和超时暴露给先到先得的探测。

实现以 `host-agent/src/control.ts` 为准。本文是契约；字段名以这里的蛇形为准。

### 6.1 `GET /v1/runtime`（已配对）

在现有 `state` / `public_origin` / `version` / `main_url` / `paired_at` 之外增加 `settings`：

```json
{
  "state": "paired",
  "public_origin": "https://computer.example.com",
  "version": "v0.2.6",
  "main_url": "https://app.example.com",
  "paired_at": "2026-08-31T00:01:00.000Z",
  "settings": {
    "idle_timeout_sec": 1800,
    "idle_timeout_sec_source": "file",
    "session_ttl_sec": 7200,
    "session_ttl_sec_source": "env",
    "ready_timeout_sec": 90,
    "ready_timeout_sec_source": "default",
    "stop_grace_sec": 10,
    "stop_grace_sec_source": "default",
    "max_instances": 200,
    "max_instances_source": "default"
  }
}
```

`*_source` 是 `file` | `env` | `default`，给管理页说明「现在这个数从哪来」，不是第二套可写字段。GET 永不回令牌或签票密钥。

未配对 GET 不增加 `settings`。

### 6.2 `PUT /v1/runtime`

补丁语义：省略的字段保持不变；要让某旋钮回到「env / 默认」解析，显式传 JSON `null`。

现有 `main_url` 规则不变：已配对必须仍是合法 http(s) URL（pairing.md）。本方案在同一 body 里允许同时带 `settings`：

```json
{
  "main_url": "https://app.example.com",
  "settings": {
    "idle_timeout_sec": 900,
    "session_ttl_sec": null
  }
}
```

`settings` 省略：只按今天的规则处理 `main_url`（兼容旧客户端）。
`settings` 为空对象：旋钮全部不变。
`settings` 含未知键：整次 PUT 400，磁盘与内存都不动。
`settings` 某字段不是 `null` 且不是合法整数：整次 PUT 400。

合法整数范围：

| 字段 | 最小 | 最大 | `0` 的含义 | 默认 |
| --- | --- | --- | --- | --- |
| `idle_timeout_sec` | 0 | 86400 | 关闭闲置回收 | 1800 |
| `session_ttl_sec` | 60 | 604800 | 不允许（至少 60） | 7200 |
| `ready_timeout_sec` | 5 | 300 | 不允许 | 90 |
| `stop_grace_sec` | 1 | 120 | 不允许 | 10 |
| `max_instances` | 1 | 10000 | 不允许 | 200 |

越界 → 400，正文 `{error: "<field> out of range"}`。

成功：合并后的 `settings.json` 只保留非 null 字段（回到 env 的键从文件删掉）→ 替换内存 → 200，body 与 GET 相同（含 `*_source`）。

预共享兼容模式（`host.json` 未配对、env 带了两把密钥）：`PUT` 可以改 `settings`（写 `settings.json`），`main_url` 仍按今天 409（`main_url is env-managed unless paired via /v1/pair`）。

### 6.3 热改何时生效

| 字段 | 生效点 |
| --- | --- |
| `idle_timeout_sec` | 下一次 `idleSweep`（≤60s）。已在回收中的 stop 不回滚。设为 `0` 后不再新停；已停且 `desired=running` 的实例仍靠流量唤醒。 |
| `session_ttl_sec` | 之后新签发的 `computer_session` cookie。已发出的 cookie 仍按其签发时的 `e` 过期。 |
| `ready_timeout_sec` | 下一次冷启动 / 唤醒的就绪等待。 |
| `stop_grace_sec` | 下一次 SIGTERM 宽限。 |
| `max_instances` | 下一次 `ensure` 要新占槽位时。下调不杀已 running / 已占用 HOME 的实例；只拒绝再开超出上限的新实例（507）。 |

不扫描、不广播给 dsh。dsh 进程本身无配置协议。

## 7. ApeMind 侧

权威链：

1. 宿主内存中的生效值（`GET /v1/runtime.settings`）。
2. `/data/settings.json`（重启后恢复）。
3. ApeMind `setting` 表 `computer.host` 里可选的上次下发副本，仅供宿主暂时不可达时回显，**不参与回收判定**。

`/admin/computer` 第一期只加「闲置多久停进程」：打开页拉 runtime；保存配对 / 保存配置时把该字段放进 `PUT /v1/runtime`。宿主 4xx / 不可达则保存失败，页面保留草稿，不把失败值写成 ApeMind 真源。

工作区 Computer 页、侧栏、开通例外名单都不读这些旋钮。`GET /api/v2/computer` 的 10 秒轮询仍不续命。

ApeMind 不把超时写进租户 `env.json`，也不新开给浏览器的公开 API。

## 8. 兼容与升级

- 无 `settings.json` 的现网：行为与升级前完全一致（env → 默认，闲置 1800s）。
- 旧 ApeMind 只 PUT `main_url`：宿主忽略没有的 `settings` 键，旋钮不动。
- 新 ApeMind 打旧宿主：PUT 带 `settings` 会被旧宿主当未知 JSON 忽略或 400。ApeMind 必须先看 GET 有没有 `settings` 再决定写不写；没有则管理页该字段只读并提示升级宿主镜像。
- Helm / compose 里的 `COMPUTER_IDLE_TIMEOUT_SEC` 继续作为**从未保存过文件时**的缺省，不删。

## 9. 不解决什么

- 按用户 / 组织设置不同闲置超时。
- 热改对外 Origin、监听端口、数据目录、uid、回环隔离、dsh 命令、端口起点。
- 给 dsh 加心跳协议。
- 文件 watch / SIGHUP / 周期重读 `.env`。
- 多 host 各自一份设置的调度（每台 host 自己一份 `settings.json`，ApeMind 1∶N 时逐台 PUT）。
- 配额、计费、按 running 秒数出账。
- 生产发布与现网改值（文档合入不等于改集群）。

## 10. 落地顺序

1. **本仓**：`settings.json` 读写、解析顺序、`GET/PUT /v1/runtime` 扩展、supervisor 读可变超时；单测覆盖文件优先、坏文件回退、补丁 `null`、越界 400、idleSweep 用新值。
2. **aperag-enterprise**：host client 认识 `settings`；管理页一个闲置字段；保存走 PUT；GET 无 `settings` 时降级。
3. 发 computer-host 镜像后再发 ApeMind，避免新管理页打旧宿主。

## 11. 验收

宿主单测即可锁契约；staging 手测在镜像发出之后：

1. 无 `settings.json` 时闲置行为与升级前一致。
2. 已配对 PUT `idle_timeout_sec=60`，GET 回 60 且 `source=file`；60～120 秒内无流量的实例被停，`desired` 仍为 running，cookie 请求能唤醒。
3. PUT `idle_timeout_sec=0` 后不再因闲置停新的进程。
4. PUT `idle_timeout_sec=null` 后文件不再含该键，GET 的 source 回到 env 或 default。
5. 未知键 / 越界 → 400，文件与生效值不变。
6. `host.json` 的令牌在多次 PUT settings 后字节级不变。
7. 重启宿主后仍使用文件里的闲置值，不被 Deployment env 覆盖。

## 读完后能回答的问题

- 为什么运营旋钮不能继续只放启动 env？
- `/data/host.json` 和 `/data/settings.json` 各存什么，为什么要拆开？
- 某个旋钮的生效值按什么顺序解析？文件和 env 谁优先？
- `GET/PUT /v1/runtime` 比今天多了哪些字段，补丁和 `null` 分别是什么意思？
- 改闲置超时之后最晚多久开始按新值回收？改会话 TTL 影响不影响已经发出的 cookie？
- ApeMind 数据库里的 `computer.host` 是不是回收判定的真源？
- 第一期管理页暴露什么，接口预留了什么？
- 旧控制面打新宿主、新管理页打旧宿主，各自会怎样？
