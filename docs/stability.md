# host-agent 稳定性：谁救谁、救完会不会雪崩

[architecture.md](architecture.md) 回答「两边怎么分工、控制 API 有哪些」。
[lifecycle.md](lifecycle.md) 回答「实例怎么启停、闲置怎么回收」。
[host-settings.md](host-settings.md) 回答「运营旋钮认哪份文件」。

本文放大其中一层：**进程挂了谁来拉起来，一户把内存吃光时怎么只死这一户**。稳定的目标是可恢复、租户之间不互相踩、冷启动不把机器打满。磁盘在 PVC 上，计算按需在。

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
2. **每实例内存与进程数限额。** 口径见 §6。内核先掐这一户，再走 §3 的崩溃重启。
3. **启动失败也给一两次退避。** 现在主要覆盖「已经 running 之后崩了」。

不要做：

- 容器里跑 systemd / supervisord 管 dsh 或 host-agent
- 每台 dsh 一只容器（要改整套密度和 PVC 模型，不进本期）
- dsh 给宿主打心跳来保活（闲置判定认网关流量，见 [lifecycle.md](lifecycle.md) §3.4）

## 6. 每实例内存 / 进程数限额

同容器密度下，一户把内存吃光，内核在**容器**这一层杀进程。它不认得 host-agent，可能把网关带走，所有人一起打不开。dsh 里能跑任意 shell，这是真会遇到的邻居问题。

Helm 的 `resources.limits`（现在默认 32Gi）只包整只容器，划不开户与户。要「一户吃光只死一户」，必须在容器里面再划一刀。

### 6.1 按什么标准做

做：**防跑飞**。全宿主一份偏松的顶，挡住失控的编译、泄漏、fork 炸弹，让 §3 的退避接手。

不做：管理页里每户不同的套餐。那是计费和公平调度，会倒逼解释「为什么我编译到一半被杀」。

没有 RSS 实测之前，默认宁可松（2–4Gi）。架构里写的活跃实例 300–500MB 是健康工作集，拿来当硬顶会误杀正常使用。落地时这两个整数进 `/data/settings.json`，热更新规则跟现有五键一样，见 [host-settings.md](host-settings.md)。

### 6.2 谁来写限额

host-agent 在 spawn 前后写自己那棵 **cgroup v2** 子树。现代 Docker / Kubernetes 默认是 cgroup v2 + 私有 cgroup 命名空间，容器里的 `/sys/fs/cgroup` 就是自己的根，可以再挂孩子。

host-agent 已经是 root（setuid、可选 `NET_ADMIN`）。写自己这棵树不需要 `privileged: true`，也不要挂宿主机的 cgroup。

`ulimit`、`RLIMIT_AS`、Node `--max-old-space-size` 管不住子进程和原生分配，不能当限额。

### 6.3 怎么写

cgroup v2：一个节点一旦打开控制器，自己身上就不能再挂进程，进程必须在子节点里。host-agent 起来时先改树，再 spawn。

```
/sys/fs/cgroup                  ← 容器根（cgroupns=private）
  agent/                        ← 先把 tini + host-agent 挪进来
  dsh/<userKey>/
    memory.max
    memory.swap.max
    memory.oom.group = 1
    pids.max
    cgroup.procs                ← 这台 dsh 的 pid
```

启动：

1. 读 `/sys/fs/cgroup/cgroup.controllers`。没有 `memory`，或目录只读 → 打一条日志，按今天这样继续跑，host-agent 不要崩。
2. 建 `agent/`，把 PID 1 和自己写进 `agent/cgroup.procs`。
3. 给根写 `+memory +pids`。
4. 给 `agent/` 写 `memory.min` / `memory.low`（256–512Mi 量级），整容器挨挤时先保网关。

每次拉起一台 dsh：建 `dsh/<userKey>/`，写入限额，再把进程放进去。Node 的 `spawn` 没有 `CLONE_INTO_CGROUP`，进程先出生再入组会有几毫秒窗口。用一个小 wrapper 先进组再 `exec dsh`。停掉或删除时进程走了再 `rmdir`。

限额文件可以热改，正在跑的实例写新的 `memory.max` 立刻生效；已经用超了，内核马上杀。热改把顶改小，等于当场回收正在用的人，运营要当停机操作看。

### 6.4 写什么数

| 键 | 作用 | `0` |
| --- | --- | --- |
| `instance_memory_max_mb` | 每户 `memory.max` | 关闭这一项 |
| `instance_pids_max` | 每户 `pids.max` | 关闭这一项 |

一并写：

- `memory.oom.group=1`：超限时整棵树一起杀（dsh + 它拉起的工具），避免只干掉某个孙子、留下半残的会话。
- `memory.swap.max=0`：避免先换到磁盘再慢慢死。尖峰会更脆，换来的是可预期的死亡，不要整机交换抖动。

`cpu.max` 以后要再加。CPU 抢光、PVC 写满、host-agent 自己漏内存，本期都不靠这套限额。

内核一杀，进程退出，现有 `onExit` 退避重启照走。连续超限会进 `error`，等下次打开再清计数。日志必须能读出 `memory.events` 的 `oom_kill`，把「超限被杀」和「自己崩了」分开；实例状态以后最好也能区分。

`pids.max` 太小会表现为 fork 失败，不是干净的 OOM。dsh 会拉包管理器、编译器、并行工具，出厂用 512–1024，不要从 256 起。

### 6.5 超卖

| 含义 | 行不行 |
| --- | --- |
| 这一户超过自己的 `memory.max` | 不行。硬顶。 |
| 这一户用掉别人闲置腾出来的内存 | 行，而且应该行。闲置回收已经把进程停了，内存还给容器。上限只卡这一户最多用多少，闲置的户不占份额。 |
| 所有户的上限之和大于容器 32Gi | 行。50 × 2Gi 写在纸上可以是 100Gi。真同时跑满，先撞容器顶，host-agent 仍可能死。 |

单户不能突破自己的顶。能超卖的是整机容量：同时在跑的人少，纸面之和就可以大于容器。不要按 `max_instances × 每户上限` 去做预留。

保护管家靠三道：每户一个松的 `memory.max`；`agent/` 的 `memory.min` / `memory.low`；容器 limit 仍是最后一道。活跃数 × 每户顶不要长期大于容器；闲置回收已经在压活跃数。

某户合法就要用 8Gi（本地编大项目），同容器模型里只有两条路：把全宿主默认顶抬高，或把这户挪出共享池（per-user Pod）。本期两条都不走，接受「单户有顶、顶以上请停」。

### 6.6 落地时要注意

- 限额含 page cache，不只 RSS。读大文件、装依赖、编译都可能先撞顶。
- `oom.group=1` 会整段会话一起死，不是只杀掉那一条编译命令。
- cgroup v1、只读 cgroup、控制器没委托下来的节点：检测失败就降级，整容器 32Gi 仍在。
- 初始化写错（根上还留着进程就打开控制器）会让宿主起不来。失败路径必须是降级，不能是 crashloop。
- 进程组 / `PR_SET_PDEATHSIG` 管停机收尸；杀内存靠 cgroup。两边都要，职责分开。

## 7. 对照表

| 事件 | 谁动手 | 结果 |
| --- | --- | --- |
| dsh 自己退出，desired=running | host-agent | 退避重启；超限则 error |
| 用户停止 / 闲置回收 | host-agent | 停进程，不重启；唤醒靠下次打开或带会话的请求 |
| host-agent 进程退出 | Docker / K8s | 新容器；不群起 dsh |
| 节点没了 | 编排 + PVC | 盘还在，有人打开再拉起 |
| 一个租户撞上自己的 memory.max | 内核 cgroup（落地后） | 只杀这一户，再走崩溃重启 |
| 许多户一起把容器 32Gi 吃满 | 内核（容器 cgroup） | 可能带走 host-agent；每户上限挡不住这一层 |

## 8. 不解决什么

- 不把 host-agent 做成多副本高可用（单副本 + PVC + Recreate 是当前部署事实）。
- 不保证 host-agent 重启期间网关零中断。
- 不在本文落地进程组 / cgroup 代码；口径先定，实现另开。
- 不讨论把 dsh 拆成 per-user Pod / microVM。
- 不做每户不同的内存套餐，也不把容器改成 privileged。
- 不保证纸面超卖之后整容器永不 OOM。

## 读完后能回答的问题

- dsh 崩了谁救？host-agent 自己崩了谁救？
- 为什么镜像里不要再套一层自动重启？
- host-agent 冷启动为什么不把所有 desired=running 的实例拉起来？
- 内核在这套模型里管什么、不管什么？
- 每户内存限额谁来写、检测不到 cgroup 怎么办？
- 单户能不能突破自己的顶？所有户的顶加起来能不能超过容器？
