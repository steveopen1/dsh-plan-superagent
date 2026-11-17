# dsh-plan-superagent

**One plugin that turns one sentence into a task tree, turns every card into a ticket, and lets superagent implement it and write the evidence back.**

> **English summary**
>
> `dsh-plan-superagent` bundles a plan board, a dispatch bridge, and a planner into **one** DSH plugin:
>
> - **Plan board** (vendored from [hoyyang/dsh-plan-board](https://github.com/hoyyang/dsh-plan-board) v0.2.2, BSD-3-Clause) — a mind-map style task tree with a human approval gate, an evidence gate, a single-issue lock, git drift detection, and scope enforcement.
> - **Bridge** — polls the board, turns every `ready` task into a superagent ticket, and writes the PR/CI evidence back onto the node.
> - **Planner** — registers the `plan_generate` tool: one sentence becomes a module/task tree.
>
> The execution engine ([dsh-superagent](https://github.com/steveopen1/dsh-superagent), MIT) is an **optional** dependency: without it the board and the planner keep working and the bridge stays disabled.

**把「一句话 → 任务树/思维导图 → 每张卡自动变成工单 → superagent 实现并回写证据」做成一个插件。**

计划 → 模块 → 任务三层展开，改图必须过「人审门」才生效，任务完成必须附证据；板上每张就绪的卡自动变成 superagent 的一张工单，worker 改完代码开 PR、跑 CI，证据再自动写回板上，节点转 done。

---

## 安装

```sh
dsh plugin --profile web add github:steveopen1/dsh-superagent
```

执行引擎作为 **git 依赖**自动装（`dependencies` 里是 `github:steveopen1/dsh-superagent`），不需要你另外装。

重启 `dsh web`：会话头部右侧（「⋯ 更多操作」左边）出现 **PlanBoard** 按钮即成功。点它打开面板，填项目根**绝对路径**即可。

> **引擎仓的要求**：`dsh-superagent` 仓必须把 `lib/` 提交进仓，这样安装时免构建、不需要本机有 TypeScript 工具链。

### 引擎是可选的

不想用默认引擎、或已经在跑自己的 superagent：

1. 先把引擎装进你的 profile：

   ```sh
   dsh plugin --profile web add github:steveopen1/dsh-superagent
   ```

2. 把本包的依赖从 git 版本改成你手上那份（本地 checkout 用 `link:`，registry 版本用版本号）：

   ```jsonc
   // package.json
   "dependencies": {
     "dsh-superagent": "link:../dsh-superagent-win"   // 或 "dsh-superagent": "0.1.0"
   }
   ```

3. 引擎没装 / 没起时，**桥静默禁用**：板、面板、`plan_generate` 照常工作，日志里会出现一行
   `[dsh-plan-superagent] 未检测到执行引擎，桥未启用`。

### 卸载

```sh
dsh plugin --profile web remove dsh-plan-superagent
```

卸载**不会**删除你项目里的 `.plan-board/` 数据。

---

## 配置

配置分两个地方：**本插件的配置**（DSH 设置页）和**引擎的配置**（superagent 面板）。桥在派单时读的是**引擎侧**那份。

### 1. 本插件的配置（DSH 设置页里 `dsh-plan-superagent` 这一项）

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `project` | `''` | 板的 project 目录（项目根**绝对路径**）。Windows 形如 `C:\work\my-project`，POSIX 形如 `/home/me/my-project`。 |
| `bridgeActorId` | `planboard` | 桥向引擎发起工单时的 actor id。**必须**出现在引擎侧该 source 的允许名单里，否则工单被策略拒绝。 |
| `subDesignDir` | `.plan-board/designs` | 子导图目录（相对 `project`）。task 的子导图存 `<project>/.plan-board/designs/*.json`。 |
| `stateDir` | `''` | 板注册表目录，缺省 `<DSH_HOME>/dsh-plan-board`。 |
| `blockOnDrift` | `true` | L5 漂移阻断：git 交叉核对不匹配时拒绝发号，直到人在面板处置。 |
| `observeTools` | `true` | L7 工具观测：把会话内的工具调用记到 `tool-calls.jsonl`。 |
| `enforceScope` | `true` | L7 越界拦截：`write`/`edit` 路径未命中 doing 任务 scope 时拒绝执行。 |

> 板的 project 目录还有另外两个入口，功能上等价，按需选一个：
> - **PlanBoard 面板**顶部的输入框（存在浏览器 `localStorage` 的 `planboard.project`）——面板读写板时用它；
> - **引擎侧** `Sources → 计划板` 的 `project` 字段——桥派单时用它。

### 2. 引擎的配置（superagent 面板）

打开 DSH 侧栏的 **Superagent** 入口，按下面四块填。

**① Sources（来源）**

- **GitHub**：`repository` = `owner/name`（要动的那个仓库），`cli` = agent 用的 GitHub CLI 路径（建议单独一个只签了这一个账号的 gh，例如 `/home/me/.local/bin/gh-agent`；Windows 填 `C:\...\gh.exe`）。
- **计划板**（本包注册的来源，kind = `planboard`）：
  - `project` = 板所在项目根的**绝对路径**（含 `.plan-board/plan.board.json` 那个目录）。
  - `actor` = 发起人 id，**默认 `planboard`**，要与本插件的 `bridgeActorId` 对齐。
  - `designsDir` = 子导图目录，**默认 `.plan-board/designs`**。
  - `pollSeconds` = 轮询间隔，**默认 15 秒**。

**② Eval / Policy（准入）——把桥的 actor 加进该 source 的 allowed**

在 `On each Source` 里找到「计划板」这一行，`allowed` 名单里要有：

| id | name |
| --- | --- |
| `planboard` | 计划板 |

名单里没有人时，任何请求都变不成工单（引擎的硬规则）。名单默认就带 `planboard`，但如果你改过 `bridgeActorId`，这里要跟着改。

**③ Execution（执行器）**

> **`proxy`（可选，但网络不稳时必填）**：这台机器上到 GitHub 的链路时好时坏，探针/轮询/worker 的 git 都会因此失败。
> 填一个本地 HTTP 代理地址（如 `http://127.0.0.1:7897`）即可让**全部出站流量**（GitHub 轮询、agent CLI、worker 的 git 与 gh）走它；
> 留空则直连。**先测哪个通再填**——代理本身也可能是断的那一条。

| 字段 | 建议值 | 说明 |
| --- | --- | --- |
| `directory` | 仓库本地 clone 的绝对路径 | 每个工单在这里开一个 worktree。 |
| `prepare` | 见引擎文档的示例 | 建 worktree 的命令（带 `$DSH_SUPERAGENT_TICKET` 之类的占位符）。 |
| `maxWorkers` | **1（第一版强烈建议）** | 并行工单数上限。 |
| `model` | 按需 | worker 用的模型。 |

> **为什么第一版建议 `maxWorkers = 1`**：
> 板有一条 L1 硬锁——**同时只允许一个 doing 任务**（`plan_next` 在已有进行中任务时直接拒绝发号）。
> 而桥会把**每个**就绪任务都变成一张工单（这是有意的：工单并发由引擎的 `maxWorkers` 管），
> 于是板上会出现多个 doing 任务。这和 L1 锁、漂移核对（L4）、以及 L7 越界拦截的判定基准
> （"当前 doing 任务"）直接冲突。
> 先把 `maxWorkers` 设成 **1**：工单照派，但在引擎里**排队一个个跑**，同一时刻只有一个工单在动，
> 板的 doing 状态才不会分裂。链路跑通、L1/L3/L4/L5/L7 都符合预期之后，再往上调。

**④ 引擎自身的插件配置**

引擎的 `stateDir` 是必填的**绝对路径**（数据库、锁、worker shim、git 配置、默认的工单目录都在这儿）。

---

## 面板：唯一的工作台

会话头部右侧（「⋯ 更多操作」左边）有一个 **PlanBoard** 按钮，点开是右侧停靠面板。
面板就是这套系统的主界面：**说需求、看导图、改提案、批准、看着它自动派单**，不用来回切聊天框。

### 顶部第一行：当前项目

`当前项目：<路径>（点此切换）` 右边是最近打开过的项目（点标签即切）。
也可以直接手填项目根绝对路径（Windows 形如 `C:\Users\me\project`）。

**面板选的项目就是桥派单的项目**——来源配置里的 `project` 留空时，桥自动跟随面板最近打开的项目
（板注册表 `projects.json` 里 `at` 最新的那个）。所以**两处配置不需要对齐**，面板说了算。

### 输入：只有一个面 —— 原生对话框

面板**不接管输入**。要提需求就在原生对话框里说，旁边有一个 **计划板模式**开关（输入框左侧）：

| 开关 | 含义 |
| --- | --- |
| **直改**（默认） | 按常规处理：直接分析、直接改代码。 |
| **计划板：开** | 开发类需求一律**先走计划板**：agent 会先调用 `plan_generate` 生成「计划 → 模块 → 任务」三层结构与每个任务的功能实现子导图，连同验收标准与改动范围提交待批；**人批准后**再按板上就绪的任务逐个动手。 |

- 切换会**把一条指令注入当前会话**（agent 下一轮就能读到），所以不用重复交代。
- 模式**按会话记在服务端**（`modes.json`）：会话重建、插件重启都不丢；切换不影响其它会话。
- 面板顶部的「当前项目：<路径>（点此切换）」决定板和桥用哪个项目 —— **面板选的项目就是桥派单的项目**，来源配置里 `project` 留空时桥自动跟随面板最近打开的那个。

### 脚本/自动化也能用一句话规划

`POST /_dsh/dsh-plan-board/plan`，体 `{ project, sentence }` → 生成并进待批队列，返回 `{ ok, approvalId, modules, taskCount, ... }`。面板不再调用它，留给脚本用。

### 待批提案卡：可以逐条改，再批准

每条 op 摊开成一行可编辑的条目：

| op | 能改什么 |
| --- | --- |
| `init_board` | 计划名、目标 |
| `add_node` | 标题、验收标准（每行一条）、scope（每行一条）、优先级、依赖（多选） |
| `update_node` | 它带的那些字段（备注是子导图指针，改坏了会静默失效，界面有标签提示） |
| `remove_node` / `set_deps` | 照原样列出 |

- op 的 **id 与类型是只读**（改了会打断父子引用）。
- 每行有「删除此条」= 这条 op 不执行（删掉某个 `add_node` 就是不创建那个节点/模块）。
- 「重置为原提案」= 放弃你的修改。
- 「确认生效」：**没改过**就按原提案生效；**改过**就带着你改过的 ops 一起提交（服务端会校验每一项都出自原提案）。
- 成环时按钮禁用并提示「⛔ 依赖会成环：a → b → a」；删掉模块而留下它的任务时提示「父模块不在板子/提案里」。
- 「驳回」= 整条提案丢掉。

### 批准之后

- 板上就位了，**ready 的任务会被桥自动变成工单**（一次尝试一个工单；失败 → 节点 `blocked` + 失败证据 → 人把任务改回 `ready` 就重开下一轮）。
- worker 干完 → PR → 桥把证据（工单结局 / worker 报告 / PR 链接 / 执行目录）回写到节点，节点变 `done`。
- 面板里可以直接改**已落板**的节点：点节点开编辑卡（标题/备注/验收/scope/优先级/依赖）、拖拽挪位置、拖连线改依赖、＋子任务 / 删除节点；改动先进草稿态，点「保存更改」才生效。
- **任务状态与证据不能在面板直改**（必须走 `task_update` 的 L3 证据门），这是有意的。

---

## 架构

```
   一句话
     │
     │  plan_generate（规划器 src/planner）
     ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  板  dsh-plan-board（vendored，src/board）                     │
  │  .plan-board/plan.board.json = 机器权威（乐观锁 + SHA-256）    │
  │                                                              │
  │   L1 单发号锁 ─ L2 人审门 ─ L3 证据门 ─ L4/L5 git 漂移 ─ L7 拦截│
  └──────────────────────────────────────────────────────────────┘
     │                    ▲                        │
     │ 改图进待批队列      │ 人点头才生效            │
     ├────────────────────┤                        │
     │                    └────────────┐           │
     │                                 │           │
     │  pollSeconds 轮询 ready 任务      │           │
     ▼                                 │           │
  ┌──────────────────────────────┐     │           │
  │  桥  src/bridge               │     │           │
  │  嵌套 inject(['orchestrator'])│     │           │
  │  policy.allowed 校验 actor    │     │           │
  └──────────────────────────────┘     │           │
     │                                 │           │
     ▼  触发器（actor = planboard）     │           │
  ┌──────────────────────────────┐     │           │
  │  superagent router           │     │           │
  │  准入 → 评估 → 编排           │     │           │
  └──────────────────────────────┘     │           │
     │  工单（Ticket）                │           │
     ▼                                 │           │
  ┌──────────────────────────────┐     │           │
  │  worker 会话                  │     │           │
  │  checkout → 改代码 → PR → CI  │     │           │
  └──────────────────────────────┘     │           │
     │  PR 链接 / CI 结果 = 证据        │           │
     ▼                                 │           │
  ┌────────────────────────────────────┴───────────┴───────────┐
  │  回写证据：task_update → done（L3 证据门放行）                │
  └──────────────────────────────────────────────────────────────┘
```

**一个插件，三半**：

```
src/index.ts            合并入口：装板 → 装桥 → 装规划器，任一环坏了不影响另外两环
 ├── src/board/**       板（vendored 自 hoyyang/dsh-plan-board v0.2.2，BSD-3-Clause）
 ├── src/bridge/**      桥：板 → 引擎的派单与回写
 ├── src/planner/**     规划器：注册 plan_generate
 └── src/client/**      浏览器面板（vendored 同上）
```

---

## Agent 工具（6 个）

| 工具 | 来源 | 作用 |
| --- | --- | --- |
| `plan_generate` | 规划器 | 一句话 → 模块/任务树（每个 task 的子导图写 `<project>/.plan-board/designs/*.json`）。 |
| `plan_map` | 板 | 读图：模块/任务树 + 依赖 + 拓扑序号 + 站位 + 漂移块 + 待批改动。 |
| `plan_edit` | 板 | 改图：结构变更进**待批队列**，人在面板点头才生效（L2 人审门）。 |
| `plan_next` | 板 | 发号：**唯一**下一个可做任务，当场标记 doing（L1 单发号硬锁）。 |
| `task_update` | 板 | 流转：`planned/ready → doing → done/blocked`；done 必须附证据（L3 证据门）。 |
| `plan_link` | 板 | 对账：经 `ai-memory` 与 `~/.ai` 项目记忆双向同步（push/pull）。 |

## 防跑偏七层（随板一起 vendored）

| 层 | 机制 | 默认 |
| --- | --- | --- |
| L1 | **单发号硬锁**：同时只允许一个 doing | 开 |
| L2 | **改图人审门**：`plan_edit` 结构变更进待批队列 | 开 |
| L3 | **证据门**：done 不带证据 → `EVIDENCE_REQUIRED` | 开 |
| L4 | **git 交叉核对**：doing 期间的 commit 若不落在任务 `scope` 内 → 漂移告警 | 开 |
| L5 | **漂移阻断**：存在未处置漂移时拒绝发号 | 开 |
| L6 | LLM 仲裁 + watchdog | 未排期 |
| L7 | **工具观测 + 越界拦截**：`write`/`edit` 路径未命中 doing 任务 scope → 当场 deny | 开 |

---

## 许可与归属

| 部分 | 许可 | 归属 |
| --- | --- | --- |
| 本包（`src/index.ts`、`src/bridge/**`、`src/planner/**`、构建脚本等） | **MIT** | 见 `LICENSE` |
| `src/board/**`、`src/client/**`（vendored） | **BSD-3-Clause** | [hoyyang/dsh-plan-board](https://github.com/hoyyang/dsh-plan-board) v0.2.2 — 见 `NOTICE.md` / `NOTICE-plan-board.md` |
| `dsh-superagent`（依赖，未 vendored） | **MIT** | [steveopen1/dsh-superagent](https://github.com/steveopen1/dsh-superagent)（Windows fork，原型为 deepseek-ai/dsh-superagent-prototype） |

完整归属见 **[NOTICE.md](NOTICE.md)**。

---

## 已知限制

- **板只有两层**：`module → task`。再往下拆的**子导图不占第三层**，另存成
  `<project>/.plan-board/designs/*.json`，由 `designsDir` 指向。面板里看不到子导图，只有文件。
- **L1 单发号锁 vs superagent 并行**：桥把每个就绪任务都变成工单（工单并发由引擎的 `maxWorkers` 管），
  于是板上可能同时有多个 doing 任务，与 L1 硬锁、L4 漂移核对、L7 越界拦截的「当前 doing 任务」判定基准相抵触。
  **第一版请把 `maxWorkers` 设成 1**（见「配置」一节）：工单照派，但在引擎里排队一个个跑。
- **引擎缺失时桥静默禁用**：引擎的 `orchestrator` 服务不存在时，桥的嵌套 `ctx.inject` 永不触发，
  桥不注册、不报错、不影响板和 `plan_generate`；插件入口只在桥**抛错**时打一条
  `未检测到执行引擎，桥未启用` 的 warn。表现为「板照常用，但没有工单产生」。
- **Windows 路径已修**：上游 plan-board 的绝对路径判定只认 POSIX 的 `/`，在 Windows 上等于永不成立。
  本包已修（服务端 `src/board/pathutil.ts`、客户端的 `ABS_PATH_RE`），Windows 绝对路径可用。
- **板只有一个项目**：单项目单板，不做多人协作 / 权限 / 通知，也不替代 issue tracker。
  （面板可以切换项目，但一次只有一个项目是当前板；桥跟随面板最近打开的那个。）
- **状态流转不在面板直改**：必须走 `task_update` 的证据门。
- **提案的编辑范围**：人可以改提案的内容、可以删掉某条 op，但**不能新增**原提案里没有的 op
  （服务端校验每一项都出自原提案）；要加任务请在批准后用面板的编辑能力。
- **模式开关是插件自己的**：它只改 agent 的工作方式（先出计划还是直接动手），不改宿主的任何设置；
  宿主自己的原生计划模式与此无关。

---

## 开发

```sh
# 装依赖（Windows 用 pwsh / PowerShell）
npm install            # 或 pnpm install

# Windows 构建：src/** → lib/**，src/client → lib/client.js
pwsh -File scripts/build.ps1

# 只编类型、跳过面板
pwsh -File scripts/build.ps1 -SkipClient

# 类型检查（不产出）
node_modules\.bin\tsc.cmd -p tsconfig.json --noEmit
```

`scripts/build.ps1` 是 plan-board `scripts/build.sh` 的 Windows 版：**不依赖 bash、不依赖 DSH 源码 checkout**，
只用包内 `node_modules`（`typescript`、`tsdown`、`@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-tools`）。
任何一步失败都会打印原因并**非零退出**。

> **`lib/` 必须一起提交。**
> 别人从 GitHub 安装时直接用你提交好的 `lib/`，免本地构建——不提交 `lib/` 等于装完不能用。

改完源码请跑一次构建并把 `lib/` 一起提交。

---

## License

MIT — 见 [LICENSE](LICENSE)；vendored 部分见 [NOTICE.md](NOTICE.md)。