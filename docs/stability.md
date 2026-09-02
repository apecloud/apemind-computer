# host-agent 稳定性：谁救谁、救完会不会雪崩

[architecture.md](architecture.md) 回答「两边怎么分工、控制 API 有哪些」。
[lifecycle.md](lifecycle.md) 回答「实例怎么启停、闲置怎么回收」。
[host-settings.md](host-settings.md) 回答「运营旋钮认哪份文件」。

本文放大其中一层：**进程挂了谁来拉起来**。稳定的目标是可恢复、租户之间不互相踩、冷启动不把机器打满。磁盘在 PVC 上，计算按需在。

## 1. 会挂的三样东西

| 挂掉的是谁 | 用户看见什么 | 磁盘上的 HOME |
| --- | --- | --- |
| 某一台 dsh | 这一户的页面断，别人不受影响 | 还在 |
| host-agent | 网关和控制口一起停，所有户都打不开 | 还在 |
| 整只容器 / 节点 | 同上，直到编排把容器拉回来 | PVC 还在 |

「该不该开着」只有 host-agent 知道：用户有没有点停止、是不是闲置回收、有没有合法会话来唤醒、环境变量和端口怎么注入。systemd、supervisord、K8s 探针都不懂这些。

## 2. 结论：三层各管各的

1. **某一台 dsh 崩了**：host-agent 按产品语义救。还该开着就退避重启；连崩太多次就放弃，等下次打开。
2. **host-agent 自己崩了**：交给容器外的 Docker / Kubernetes 整容器重启。镜像里不要再套一层自动重启。
3. **操作系统 / 内核**：管收尸和炸裂半径。不负责「这台 dsh 现在该不该在」。

## 3. host-agent 怎么救 dsh

以 [lifecycle.md](lifecycle.md) §2 状态机为准，这里只写稳定性口径。

- 当时是 `running`，并且 `desired` 仍是 `running`（没人点停止、也不是宿主自己在关进程）：按 `min(500ms × 2^n, 30s)` 退避再拉起来。
- 连续崩溃超过 5 次：标 `error`，不再自动重启。下一次 ensure / 网关唤醒会清掉失败计数再试。
- 用户点停止、闲置回收、启动过程中就退出：不走这条自动重启。
- host-agent 进程自己起来时：扫 `/data/users/*/meta.json` 恢复登记，**不主动拉起任何 dsh**。`desired=running` 的实例等第一个带合法 cookie 的请求再唤醒。冷启动和闲置回收是同一条原则，避免容器一醒就把所有人同时拉起来。

这些语义写在 `host-agent/src/supervisor.ts`。不要再请另一个进程管理器同时管同一批 dsh。

## 4. host-agent 自己：镜像内重启还是交给编排

### 4.1 选项

| 做法 | 谁来救 host-agent | 容器还在不在 |
| --- | --- | --- |
| A. 镜像里套循环 / supervisord / systemd，node 挂了就在同一容器里再起 | 镜像内 | 容器一直活着 |
| B. `ENTRYPOINT` 只跑 `tini -- node ...`，进程退出则容器退出，由 Docker / K8s 起一只新容器 | 编排 | 旧容器死、新容器生 |

### 4.2 为什么选 B

镜像里已经是 `tini -- node /opt/host-agent/main.mjs`。compose 用 `restart: unless-stopped`，Kubernetes Deployment 默认 `restartPolicy: Always`，chart 策略是 `Recreate`（单副本 + PVC）。进程一退，kubelet / Docker 会起新容器，cgroup 把旧容器里的 dsh 一起清掉。

选 B 的原因：

- **父死子必须死。** host-agent 是唯一知道端口、会话、注入环境的人。它死了，旧 dsh 继续占着端口和 HOME，新 host-agent 再 spawn，就会出现两套进程抢同一户。镜像内重启会让「容器还活着、里面的 node 换了」变成常态，孤儿问题立刻变成真的。整容器重启反而干净：旧 cgroup 清空，新进程从 PVC 登记开始，按流量再唤醒。
- **崩溃要看得见。** 编排重启会计数、打事件；镜像内循环会把崩溃藏成「容器一直 Ready」。
- **不要两个管家。** K8s 已经在管这只容器。容器里再放 supervisord / systemd，存活探针和重启策略会对不上。
- **本产品接受网关短暂停。** HOME 在 PVC 上，会话靠下次打开唤醒。host-agent 重启不是要零中断保活所有 dsh。

本地 Docker 和集群用同一条原则：重启策略写在 compose / Helm 上，不写进镜像入口脚本。

### 4.3 探针怎么配

- **进程退出**：编排必救。不依赖探针。
- **就绪**：chart 已有网关 `GET /__healthz`。没就绪就不要把流量打进来。
- **存活（可选）**：只判断 host-agent 死锁，不要去问某一台 dsh 在不在。闲置睡着是正常态。现在没有存活探针也可以，进程崩溃靠退出码。

## 5. 操作系统能帮什么

容器里是完整的 Linux，该用的是隔离和收尸，不是再请一个通用 supervisor。

已经在用：

- `tini` 作 PID 1：收僵尸；主进程退出时把剩余孩子带走。
- 可选 per-user uid、HOME 0700、回环 iptables（见 [architecture.md](architecture.md) §9）。

该补、且只补炸裂半径的：

1. **进程组 + 父死子死。** 停 / 崩 / 容器退出时，dsh 以及它拉起的工具进程一起走，不留半套。`PR_SET_PDEATHSIG` 防的是「node 单独死了、容器还在」这种缝；编排整容器杀掉时 cgroup 本来就会清。
2. **每实例 memory.max（和可选 pids.max）。** 一个租户把内存吃光，不该把 host-agent 和别人一起 OOM。内核先掐，再走 §3 的崩溃重启。
3. **启动失败也给一两次退避。** 现在主要覆盖「已经 running 之后崩了」。

不要做：

- 容器里跑 systemd / supervisord 管 dsh 或 host-agent
- 每台 dsh 一只容器（要改整套密度和 PVC 模型，不进本期）
- dsh 给宿主打心跳来保活（闲置判定认网关流量，见 [lifecycle.md](lifecycle.md) §3.4）

## 6. 对照表

| 事件 | 谁动手 | 结果 |
| --- | --- | --- |
| dsh 自己退出，desired=running | host-agent | 退避重启；超限则 error |
| 用户停止 / 闲置回收 | host-agent | 停进程，不重启；唤醒靠下次打开或带会话的请求 |
| host-agent 进程退出 | Docker / K8s | 新容器；不群起 dsh |
| 节点没了 | 编排 + PVC | 盘还在，有人打开再拉起 |
| 一个租户内存爆了 | 内核 cgroup（落地后） | 只杀这一户，再走崩溃重启 |

## 7. 不解决什么

- 不把 host-agent 做成多副本高可用（单副本 + PVC + Recreate 是当前部署事实）。
- 不保证 host-agent 重启期间网关零中断。
- 不在本文落地进程组 / cgroup 代码；口径先定，实现另开。
- 不讨论把 dsh 拆成 per-user Pod / microVM。

## 读完后能回答的问题

- dsh 崩了谁救？host-agent 自己崩了谁救？
- 为什么镜像里不要再套一层自动重启？
- host-agent 冷启动为什么不把所有 desired=running 的实例拉起来？
- 内核在这套模型里管什么、不管什么？
