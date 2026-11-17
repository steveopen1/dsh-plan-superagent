# 计划板 → superagent 桥

把计划板上「就绪」的任务变成执行引擎的工单，工单结束后把证据写回板上。
本目录是**桥**（`src/bridge/**`）：板（`src/board/**`）是权威数据，执行引擎（dsh-superagent）是执行方，
桥只做翻译、派单与回写，不拥有任何状态。

```
计划板 (plan.board.json)  ──►  桥  ──►  superagent 引擎  ──►  worker 会话
      ▲                        │                                    │
      └────── 回写证据 ◄────────┴──────── 工单结束 ◄──────────────────┘
```

## 文件

| 文件 | 职责 |
| --- | --- |
| `contract.ts` | 引擎契约的**本地结构化副本**（SourceKind / SourceContext / Trigger / Ticket / Health / KV），外加一个 zod 兼容的最小 schema 子集 |
| `trigger.ts` | 板任务 → Trigger 的翻译（稳定 id、thread、actor、简报正文、子导图摘要） |
| `source.ts` | `planboardKind`：配置 schema、面板字段、健康条目、范围、策略、回写通道、执行环境变量 |
| `watch.ts` | 轮询循环：读板 → 派单 → 收单 → 回写证据（幂等、失败不循环） |
| `index.ts` | 宿主入口 `applyBridge(ctx)`：嵌套 `ctx.inject(['orchestrator'], cb)` |

## 与引擎的接口点

桥只通过 cordis 的 **`orchestrator` 服务**接触引擎（引擎的 `SourceHost`）：

| 接口点 | 桥怎么用 |
| --- | --- |
| `orchestrator.sources.register(planboardKind)` | 注册来源 kind；返回的注销器随插件卸载执行 |
| `orchestrator.context(planboardKind)` | 拿 `SourceContext`（`receive` / `tickets` / `triggers` / `threads` / `state` / `report`） |
| `ctx.receive(trigger)` | 把触发器交给引擎；返回 `stored` / `duplicate` / `filtered` |
| `ctx.config('planboard')` | 读来源实例配置；来源关闭时为 `undefined`（桥只报 paused，不派单） |
| `ctx.tickets.open()` / `ctx.tickets.get(id)` | 找出我们派出去的任务的工单，以及工单是否已终态 |
| `ctx.triggers.get(id)` | 由工单的 `origin.triggerId` 反查任务 id |
| `ctx.threads.describe(key, …)` | 给线程补展示信息（面板上看得见是哪个板任务） |
| `ctx.state.get/set` | 桥自己的 KV：派单记录、已收单记录（键前缀 `planboard-bridge:`） |
| `ctx.report('planboard', …)` | 健康条目（`setupPending` / `sourceOff` / `pollFailures` / ready） |
| `kind.environment.variables/values` | 把 `DSH_SUPERAGENT_PLANBOARD_*` 交给 worker |
| `kind.channel.send` | 引擎把 worker 的回复送回板上（写进任务备注） |

引擎**没装**时：`ctx.inject(['orchestrator'], cb)` 永不触发 → 桥不注册、不轮询，板照常可用。

## 触发器（Trigger）策略

| 字段 | 取值 | 为什么 |
| --- | --- | --- |
| `id` | `sha256('planboard', project, taskId, 'attempt:N')` 前 32 位 | 同一 task 的同一次尝试永远同一个 id → 引擎判 `duplicate` → **重复读板不会建第二张单** |
| `source` | `planboard` | 与策略段名、thread key 前缀一致 |
| `threads[0].id` | `<project>:<taskId>` | 完整 thread key = `planboard:<project>:<taskId>`；同一任务的后续消息落同一 thread |
| `actor.id` | 来源配置里的 `actor`（默认 `planboard`） | 板上没有「人」，发起人是配置项；必须与策略的允许名单同名 |
| `human` / `addressed` | `true` / `'direct'` | 板上的条目是人的意图，而且是直接派给智能体的活 |
| `text` | 标题 + 验收 + 范围 + 备注 + **子导图指针**（相对路径 + 要点摘要） | 简报要短；设计 JSON 不塞进正文，只给路径与摘要 |
| `meta` | `taskId` / `project` / `boardVersion` / `designPath` / `designAbs` / `attempt` | 引擎与 worker 靠它对齐（回写时按 `taskId` 找回板任务） |

**重开一轮尝试**：工单结束（失败 → 任务落 `blocked`）之后，人把任务重新放回就绪态时，
桥会把 `attempt` 加一 → Trigger id 变化 → 引擎才建得出新工单。
否则同一个 id 永远是 `duplicate`，任务会永远派不出去。

## 幂等策略

1. **Trigger id 稳定**：见上表。重复读板 → `receive` 返回 `duplicate` → 不建第二张单。
2. **派单台账**：桥把 `taskId → {attempt, triggerId, ticketId, settledAt}` 记在自己的 KV 里
   （`planboard-bridge:dispatched`），重启不丢。
3. **未结束不重发**：任务已有工单且工单还没结束 → 本轮不再派。
4. **收单不重复**：已回写过的工单 id 记在 `planboard-bridge:settled` 里，不再回写第二次。
5. **回写幂等**：通道回写用消息 id 做标记，同一条消息不会写进备注两遍。

## 回写路径（证据门）

工单终态时，桥**走板自己的门**回写，绝不直接改 JSON：

```
PlanStore.open(project)            ← 重新读盘（板工具可能在另一个进程里改过板）
  └─ mutate('superagent:bridge', 'status_changed', …)
       ├─ 变更板数据（状态 + evidence）
       ├─ lintBoard()                ← 校验门：done 必须有证据、依赖成环、parent 缺失…
       ├─ version/digest 推进 → 原子落盘（plan.board.json）
       ├─ 事件流追加（events.jsonl）
       └─ ROADMAP.md 人读镜像重写
  └─ driftCheck()                   ← L4 git 交叉核对（只报警报，不冻结板子）
```

| 工单结局 | 板上的任务 | 证据 |
| --- | --- | --- |
| `completed` / `merged` | `done` | 工单号与结局、worker 报告摘要（测试/CI 摘要通常在这里）、报告里出现的链接（PR 链接）、执行目录 |
| `closed` / `dropped` / `stopped` | `blocked`（等人处置，**不自动重派**） | 同上（仍然记录） |

证据取自工单本身（`ticket.ended`、`ticket.assignments[last].report.summary`、`ticket.execution`），
桥不编造：拿不到就不写。`done` 没有证据会被 `lintBoard()` 拦下（变更不生效）——这正是 L3 证据门。

## 首次启用清单

1. 引擎（dsh-superagent）装好并完成 setup（否则健康条目是 `setupPending`）。
2. 在引擎的 **Sources** 里启用 `planboard` 来源，填：
   - `project`：计划板所在项目的**绝对路径**（含 `.plan-board/plan.board.json`）；
   - `actor`：发起人 id（默认 `planboard`）；
   - `designsDir`：子导图目录（默认 `.plan-board/designs`，相对 project）；
   - `pollSeconds`：轮询间隔（默认 15s）。
3. 在引擎的 **Eval → On each Source → 计划板** 的「能发起工作的发送者」里，
   加上与 `actor` **同名**的 id（表单默认已经带出 `planboard`，保存一次即可）。
   没有这一步，引擎的策略门会把触发器判成「非名单成员」，工单不会开出来。
4. 板上的任务要处于 `planned`/`ready` 且依赖已满足（`readyTasks()` 的判定）。

插件级配置（`src/index.ts` 的 `Config`）里的 `bridgeActorId` 与来源实例的 `actor` 要一致；
`project` / `subDesignDir` 同理（来源实例里的值优先，它才是引擎面板上能改的那一份）。

## 引擎升版时要同步什么

`dsh-superagent` 是 `private: true` 的未发布包，**不能作为类型依赖**，所以本目录带了一份
结构化副本（`contract.ts`）。升级引擎后必须逐项复核：

| 要复核的东西 | 在哪 | 变了会怎样 |
| --- | --- | --- |
| `SourceKind` 字段集 | 引擎 `src/sources/kind.ts` | 新字段用不上（静默） |
| `SourceContext` 成员 | 引擎 `src/sources/host.ts` | 少一个成员 → 运行时 undefined |
| `Trigger` / `Ticket` 形状 | 引擎 `src/core/model.ts` | 字段名变了 → 回写取不到证据 |
| `HEALTH_TEXT` 的 code 字面量 | 引擎 `src/sources/host.ts` | code 写错 → 面板不翻译 |
| `Key` / `family` 形态 | 引擎 `src/kv.ts` | KV 写入的键名不对 → 台账丢失 |
| kind 的 schema 用法 | 引擎 `src/sources/registry.ts` | 只用 `parse` / `safeParse`；若引擎改成别的 API，`contract.ts` 的 schema 子集要跟着改 |

## 已知限制

- **一次可发多张单**：桥把每个就绪任务都变成一张工单（不守板子交互式 `plan_next` 的 L1 单发号锁）。
  板子此时会有多个 `doing` 任务，`plan_next` 会拒绝再发号——这是有意的（工单并发由引擎的
  `maxWorkers` 管）。
- **子导图格式未固定**：`designs/<taskId>.json` 的结构由上游约定，桥只做保守的字符串抽取
  （按 `title`/`name`/`label`/`summary` 等常见键收集要点，最多 12 条）。文件缺失或解析失败时
  简报只给验收与范围，不打断派单。
- **失败不自动重派**：工单失败 → 任务落 `blocked`，等人处置，避免「失败即重派」的无限循环。
- **策略门优先**：触发器能不能开工单由引擎的策略决定；桥只保证「不重复派单」和「证据回写」。