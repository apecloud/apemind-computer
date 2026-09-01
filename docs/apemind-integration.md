# dsh 与 ApeMind 的能力结合方案（数据面 / 控制面）

托管 dsh 已经绑定了 ApeMind 身份，但 dsh 里的 agent 目前只够得到 ApeMind 的一小部分能力。
本文定义「绑定用户的全部能力」如何交付给 dsh 里的 agent：产品口径、通道选型、
权限边界、两仓分工与落地顺序。

## 现状

每台托管 dsh 进程绑定一个 ApeMind 数据面用户：个人实例绑定用户本人，组织实例绑定
该组织的服务用户（固定角色 `deepseek-harness`）。凭证是控制面注入的托管 API key
（`APEMIND_API_KEY`），随实例 env 落盘（0600 + uid 隔离），进程重启自动生效。

在这个身份之上，目前已经打通三条线：

- **MCP 工具**：官方 `dsh-mcp-client` 插件指向 ApeMind 的 MCP 端点，带 Bearer key。
  内置工具全部是知识读面：列集合/文档、读文档与分块、知识检索、图谱查询、网页读取等。
- **模型网关**：`llm-pi-ai` 上投影一个 `apemind` provider，`baseURL` 指 ApeMind 的
  OpenAI 兼容网关，模型列表是绑定用户当时可用的 chat 模型。
- **实例控制**：ApeMind 控制面负责 open/stop/状态与会话撤销，dsh 与宿主对此无感知。

没打通的是其余全部：agent 无法建知识库、上传文档、管理 Bot 与对话、查组织成员、
接受邀请、调用管理面。它也不知道自己是谁——没有任何引导告诉它「你以哪个身份、
在哪个工作区、能做什么」。用户要么在聊天里贴 key 教 agent 用 curl，要么放弃。

## 目标与体验口径

- **开箱即知身份**：打开 Computer，agent 无需任何配置就知道自己绑定的身份、默认
  组织上下文和可用通道；`apemind whoami` 直接可用。
- **能力全覆盖**：绑定用户在 ApeMind 能做的事，agent 原则上都能做。覆盖面由
  OpenAPI 决定，不为 dsh 单独发明接口。
- **权限即角色**：能力边界完全由绑定用户的角色与 key scope 决定，dsh 侧不再造
  第二套权限模型。组织实例放宽能力 = 调整服务身份的角色权限，一处生效。
- **零 dsh 改动**：继续沿用官方机制（`--patch` 配置叠加、MCP 客户端插件、
  `llm-pi-ai` provider、`dsh-agent-instructions` 指令加载），不 fork、不写 plugin。

## 方案总览：一个身份，三条通道，一份引导

| 层 | 载体 | 定位 | 状态 |
| --- | --- | --- | --- |
| 模型 | `llm-pi-ai` 投影 | 工作区 chat 模型即选即用 | 已上线 |
| 交互工具 | MCP（`dsh-mcp-client`） | 高频、结构化、以读为主的知识操作 | 已上线，按场景扩 |
| 全能力 | **apemind CLI（bash 工具驱动）** | 写操作、批量作业、长尾管理，覆盖 OpenAPI | 本方案主体 |
| 引导 | `$DSH_HOME/AGENTS.md` + `apemind skills` | 让 agent 知道自己是谁、有什么、怎么用 | 本方案主体 |

四层共用同一个凭证 `APEMIND_API_KEY`，同一个归因身份（个人本人 / 组织服务用户）。

### 为什么是 CLI，不是 dsh plugin

dsh 是 agent harness，模型自带 bash 工具。一个在 `PATH` 里、凭证已就位的单二进制
CLI，对 agent 就是「原生能力」——不占上下文预算（不像 MCP 工具 schema 常驻）、
天然支持批量与文件上传下载、覆盖面随 OpenAPI 演进而无需 dsh 侧发版。

自定义 dsh plugin 则相反：dsh 处于 developer preview，plugin API 随版本漂移，
每次升级锁定版本都要回归；能力面要一个个做成 plugin UI 才有价值，维护成本随
覆盖面线性增长。托管形态从第一天就坚持「零 plugin 代码」，本方案维持这个决策。
将来若确需 dsh 界面级集成（例如侧栏里的知识库选择器），再单独评估。

apemind CLI 现状已经具备关键性质，**不需要重写**：Go 单二进制、零运行时依赖、
`APEMIND_BASE_URL` + `APEMIND_API_KEY` 的 Bearer 认证（env 优先、不落盘）、
覆盖 org/collection/document/search/bot/chat/turn/admin 的命令面、`--json` 输出、
内置 `apemind skills` 输出完整使用说明（自描述，agent 一条命令就能自学）。

### MCP 与 CLI 的分界

- **MCP**：模型原生工具位，留给高频、低延迟、结构化返回的读面（检索、读文档、
  图谱）。工具数量克制——每个工具 schema 都消耗每轮上下文。
- **CLI**：一切写操作（建库、上传、建 Bot）、批量作业、文件传输、长尾管理面。
- 不做 OpenAPI→MCP 自动桥：那会把几百个接口的 schema 塞进模型上下文，
  体验和成本都不可接受。

## CLI 通道落地

### 认证与身份（已就绪）

CLI 收到 `APEMIND_API_KEY` 即用 Bearer 认证，身份就是 key 的属主：个人实例是
用户本人，组织实例是服务用户。组织服务用户对 CLI 无特殊性——它就是一个有
membership 和角色的用户，`whoami`、`org list`、`collection list --org-id` 按
权限正常工作。无需为「隐藏用户」做任何 CLI 侧适配。

### 上下文缺省（CLI 小改）

组织实例里 agent 的每条命令都该默认作用于绑定组织。CLI 增加：`--org-id` 未显式
提供时读 `APEMIND_ORG_ID` 环境变量。个人实例不注入该变量，行为不变。这是唯一
影响命令语义的 CLI 改动。

其余 CLI 改动按需推进，不预铺：`doctor` 识别托管环境（检测到注入 env 时报告
绑定身份与通道健康）；`skills` 文本补充托管 dsh 场景说明；OpenAPI 长尾命令
（审计、用量等）等 agent 真实用到再加。

### 二进制分发（宿主改动）

ApeMind 服务端本身就发布 CLI 资产：匿名不可变路由
`/public/apemind-cli/releases/{version}/{asset}`，附 `checksums.txt` 与
`latest` 指针。宿主直接从**配对的主站**取二进制：

1. 配对完成或实例 ensure 时，若本地缺 CLI：`GET {main_url}/public/apemind-cli/latest`
   得版本号，下载 `apemind-linux-{arch}` 与 `checksums.txt`，校验通过后落
   `/data/apemind-cli/{version}/apemind`（0755）。
2. spawn dsh 时把该目录加进实例进程的 `PATH`。
3. 下载失败不阻塞 dsh 启动：无 CLI 时引导文件不渲染 CLI 段，agent 仍有 MCP 与模型。
4. 版本跟随主站：主站升级后 `latest` 变化，宿主在下次检查时拉新版本，旧版本目录
   保留供运行中实例用完即弃。

这个来源选择让私有化部署天然可用（资产在客户自己的服务端对象存储里，不出内网）、
CLI 与服务端版本恒匹配、computer 镜像不因 CLI 发版而重建。前提是部署发布流程把
CLI 资产随版本发布进对象存储；没发布过资产的环境表现为第 3 条的降级。

### 引导文件（宿主改动）

dsh 官方 `dsh-agent-instructions` 插件会自动加载 `$DSH_HOME/AGENTS.md`
（用户级全局指令）。宿主已经完全控制 `$DSH_HOME`（`$HOME/.dsh`），所以引导的
落点就是：**每次拉起 dsh 前，宿主按当时的 env 渲染 `$DSH_HOME/AGENTS.md`**，
与 `managed.cordis.yml` 同一口径（env 齐全才渲染整段，重启即生效）。

内容原则：短、面向模型（英文）、只写事实和入口，不复制 CLI 手册：

- 你在 ApeMind 托管的 dsh 里，绑定身份见 `apemind whoami`；
- 凭证已在环境里（只提 env 变量名，不写值）；
- 组织实例：默认组织是 `$APEMIND_ORG_ID`，CLI 命令默认作用于它；
- 三条通道一句话各自何时用（MCP 检索读面 / CLI 其余一切 / 模型选择器）；
- 完整 CLI 用法运行 `apemind skills` 获取。

用户自己的工作区 `AGENTS.md` 不受影响（那是项目级文件，加载顺序由 dsh 管理）。

## 权限与治理

- **个人实例**：托管 key scope 为本人全部知识库；能力面等于用户本人。
- **组织实例**：org-pinned key，服务端把 scope 物化为该组织存活集合的 allowlist；
  角色 `deepseek-harness` 初始权限为知识库读 + 模型读/用。CLI 写操作（建库、
  上传、建 Bot）会得到 403——**这是产品旋钮而非缺陷**：放宽 = 给服务身份的角色
  加权限，审计与撤权沿用组织治理，一处生效。将来「不同权限档案的多台组织 dsh」
  = 多个服务用户各挂各的角色，实例实体模型已为此留好位置。
- **归因**：MCP、网关、CLI 三面调用全部归因到绑定身份，组织实例的操作在审计日志
  里显示为服务身份所为，与哪个成员打开无关（与现有会话语义一致）。
- **撤权**：key 吊销/轮转后三面同时 401；配合控制面的会话撤销踢掉网关会话；
  下次 open 重新注入新 key。引导文件与 CLI 均不打印 key 本体。

## 两仓分工与落地顺序

| 阶段 | 仓库 | 内容 |
| --- | --- | --- |
| P0 | aperag-enterprise | open 时注入 `APEMIND_BASE_URL`（主站公网地址）；组织实例追加 `APEMIND_ORG_ID` |
| P0 | apemind-computer | 宿主拉取/缓存 CLI 并加进实例 `PATH`；拉起前渲染 `$DSH_HOME/AGENTS.md` |
| P1 | aperag-enterprise | CLI：`--org-id` 缺省读 `APEMIND_ORG_ID`；`doctor` 托管环境诊断；`skills` 文本适配 |
| P1 | 两仓 | staging 验收脚本：whoami → collection list → upload → search → bot/chat 全链路（个人 + 组织各一遍） |
| P2 | aperag-enterprise | 组织实例能力档案（服务角色权限旋钮的产品面） |

### 环境变量契约（实例 env）

| 变量 | 状态 | 用途 |
| --- | --- | --- |
| `APEMIND_API_KEY` | 已有 | 三通道共用凭证 |
| `APEMIND_MCP_URL` | 已有 | MCP 端点 |
| `APEMIND_LLM_BASE_URL` / `APEMIND_LLM_MODELS` | 已有 | 模型网关投影 |
| `APEMIND_BASE_URL` | 新增 | CLI / OpenAPI 主站地址 |
| `APEMIND_ORG_ID` | 新增，仅组织实例 | CLI 默认组织上下文；引导文件渲染 |

宿主对这些变量保持零知识透传，仅以「是否存在」决定渲染哪些段落
（cordis patch 的 MCP 段、模型段；AGENTS.md 的 CLI 段、组织段）。

## 不解决什么

- 不写 dsh plugin，不定制 dsh UI。
- 不做组织实例的按成员归因：运行中的共享进程只有一个服务身份（现有语义）。
- 不把浏览器会话 / cookie 带进 dsh，凭证只有托管 key 一种。
- 不做 OpenAPI→MCP 自动桥接，MCP 工具逐个按场景添加。
- 不在本方案内改动组织服务角色的默认权限；放宽是 P2 的产品决策。
- 不改实例控制面（open/stop/撤销）的既有契约。

## 读完后能回答的问题

- dsh 里的 agent 怎么知道自己是谁、能做什么？——宿主渲染的 `$DSH_HOME/AGENTS.md`
  给入口，`apemind whoami` / `apemind skills` 给细节。
- 为什么选 CLI 而不是 plugin 或全量 MCP？——bash 工具零上下文成本、覆盖面随
  OpenAPI 免费演进、不绑 dsh 版本；MCP 留给高频读面。
- 组织实例里 agent 上传文档用谁的身份、受什么限制？——组织服务用户；受
  `deepseek-harness` 角色限制，初始只读，放宽是角色权限旋钮。
- CLI 二进制从哪来、拉不到会怎样？——配对主站的公开发布路由，checksums 校验，
  按版本缓存；拉不到则降级为无 CLI，dsh 照常启动。
- 想让组织 dsh 能建知识库，要改哪里？——只改服务身份角色的权限，不改 dsh、
  宿主与 CLI。
