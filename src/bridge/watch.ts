/**
 * 轮询循环：读板 → 派单 → 收单 → 回写证据。
 *
 * 纪律：
 * - **幂等**：同一个 task 的同一次尝试只有一个 Trigger id，重复读板只会拿到 `duplicate`；
 *   已经派出去且工单还没结束的任务不再派第二次。
 * - **回写走板自己的门**：所有落板都走 `PlanStore.mutate()`（乐观锁 + `lintBoard()` + 事件流），
 *   绝不直接改 JSON；`status='done'` 时证据必填（L3 证据门由 lint 兜住）。
 * - **失败不循环**：工单不是成功结束时，任务落到 `blocked`（等人处置），不会自动重派。
 * - **单向同步**：引擎→板只有「结果回写」一条路径，板→引擎只有「派发 ready 任务」一个动作。
 *   详见 ARCHITECTURE.md（谁写哪个字段的唯一来源清单）。
 * - **单发号（L1）**：同一块同一时刻只派一个任务。引擎的 maxWorkers 管的是执行并发，
 *   管不了「板上同时有几个 doing」——那是 L1/L4/L7 的判定基准，基准分裂了三个门就都失真。
 */
import { setTimeout as delay } from 'node:timers/promises'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BoardError, readyTasks, transitionOk, type Board, type BoardNode } from '../board/schema.js'
import { PlanStore } from '../board/store.js'
import { health, record, type ReceiveResult, type SourceContext, type Ticket } from './contract.js'
import { BRIDGE_STORE_OPTS, PLANBOARD_HEALTH, PLANBOARD_KIND, defaultPlanboardProject, type PlanboardConfig } from './source.js'
import { designFilePaths, planboardTrigger, readDesignSummary } from './trigger.js'

/** 一个任务的一次派单尝试。 */
export interface DispatchRecord {
  /** 第几次尝试（0 = 首次）；重试时 Trigger id 变化，工单才能重建。 */
  attempt: number
  /** 本次尝试的 Trigger id。 */
  triggerId: string
  /** 对应的工单 id（引擎评估完成后才有）。 */
  ticketId?: string
  /** 收单（结果写回板）的时刻；用来判断人是不是在收单之后又动过这个任务。 */
  settledAt?: string
  /** 触发器所在 thread 的完整 key；用来在工单已经结束时找回工单 id。 */
  threadKey?: string
  /** 本次尝试结束的时刻（工单终结或派发丢失时记下）；用来判断人是否已重新启用该任务。 */
  endedAt?: string
}

/** 桥私有的 KV 键（引擎的 KV 归它自己，外部来源插件自己声明键）。 */
export const KV_DISPATCHED = record<Record<string, DispatchRecord>>('planboard-bridge:dispatched')
export const KV_SETTLED = record<string[]>('planboard-bridge:settled')
/** reconcile 台账：任务 id → 第一次发现「板上有它、引擎里没工单」的时刻（epoch ms）。 */
export const KV_RECONCILE = record<Record<string, number>>('planboard-bridge:reconcile')

/** 派单记录与已收单记录的上限（防止 KV 无限增长）。 */
const MAX_DISPATCH = 200
const MAX_SETTLED = 400
/** 派出去多久还没有工单，就当这次尝试作废（避免任务永远卡在 doing）。 */
const STALE_ATTEMPT_MS = 10 * 60 * 1000
/**
 * reconcile 的宽限期：板上的 ready 任务在引擎里找不到在途工单，且持续这么久才报。
 * 刚派发时工单还没落库是正常的，不给宽限期会天天误报。
 */
export const RECONCILE_GRACE_MS = 90 * 1000

/** 轮询循环的选项。 */
export interface WatchOptions {
  /** 配置缺省时的轮询间隔（秒）。 */
  defaultPollSeconds?: number
  /** The board registry's directory (where the panel records the projects it opened). */
  stateDir?: string
}

/** 桥写板用的 actor 标记（写进事件流，审计可追）。 */
export const BRIDGE_ACTOR = 'superagent:bridge'

/**
 * 轮询循环的入口。`ctx.ready` 之前不读板；来源被关掉时只报 paused。
 * 连续三次失败才报 error（一次网络/文件抖动不该叫醒人）。
 */
export async function watchPlanboard(ctx: SourceContext, signal: AbortSignal, options: WatchOptions = {}): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) {
    ctx.report(PLANBOARD_HEALTH, health('paused', 'setupPending'))
    return
  }
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<PlanboardConfig>(PLANBOARD_KIND)
    if (!config) {
      ctx.report(PLANBOARD_HEALTH, health('paused', 'sourceOff'))
    } else {
      try {
        const result = await pollPlanboard(ctx, config, signal, options)
        failures = 0
        ctx.report(PLANBOARD_HEALTH, { state: 'ready', detail: describePoll(result), at: new Date().toISOString() })
      } catch (error) {
        if (error instanceof BoardError && error.code === 'PLAN_NOT_FOUND') {
          // 项目里还没起板：不是故障。
          failures = 0
          ctx.report(PLANBOARD_HEALTH, { state: 'paused', detail: '项目里还没有计划板: ' + resolveProject(config, options.stateDir) })
        } else {
          failures += 1
          if (!signal.aborted && failures >= 3) {
            ctx.report(PLANBOARD_HEALTH, health('error', 'pollFailures', { count: String(failures), error: String(error) }))
          }
        }
      }
    }
    const seconds = config?.pollSeconds ?? options.defaultPollSeconds ?? 15
    await delay(seconds * 1000, undefined, { signal }).catch(() => {})
  }
}

/** 把一轮的统计压成一行（健康条目展示用）。 */
export function describePoll(result: PollResult): string {
  const parts = [`${result.ready} ready`, `${result.dispatched} dispatched`]
  if (result.locked > 0) parts.push(`${result.locked} doing（L1 单发号锁住）`)
  if (result.settled > 0) parts.push(`${result.settled} settled`)
  if (result.filtered > 0) parts.push(`${result.filtered} filtered`)
  if (result.failed > 0) parts.push(`${result.failed} failed`)
  if (result.pending > 0) parts.push(`${result.pending} awaiting ticket (check the policy allowed list)`)
  if (result.unmatched > 0) parts.push(`板上有 ${result.unmatched} 个 ready 任务但引擎里没有对应工单，可能派发失败`)
  return parts.join(' · ')
}

/** 一轮轮询的统计。 */
export interface PollResult {
  /** 板上的就绪任务数。 */
  ready: number
  /** 本轮新派出的工单数。 */
  dispatched: number
  /** 本轮回写了证据的任务数。 */
  settled: number
  /** 被引擎按范围过滤掉的触发器数。 */
  filtered: number
  /** 已派单但还没有工单的任务数（多半是策略没放行发起人，或评估还在排队）。 */
  pending: number
  /** 派单失败（引擎抛错）的任务数。 */
  failed: number
  /** 板上处于 doing 的任务数（L1 锁被占着时 > 0）。 */
  locked: number
  /** 板上有就绪任务、引擎里却找不到在途工单，且已过宽限期的任务数。 */
  unmatched: number
}

/**
 * 板上正在做的任务（板的发号语义 L1：同一时刻只允许一个 doing）。
 * 判定口径与板自己的 `plan_next` 完全一致，否则两个门对「当前任务」的说法会分叉。
 */
export function doingTasks(board: Board): BoardNode[] {
  return board.nodes.filter(node => node.type === 'task' && node.status === 'doing')
}

/**
 * Mark attempts whose ticket never showed up as finished.
 *
 * The ticket is created asynchronously after the Trigger is evaluated; when the evaluation filtered
 * the Trigger (policy) or the router never accepted it, no ticket ever appears and the task would stay
 * `doing` forever. After the grace period the attempt is closed, so a human can re-arm the task.
 *
 * @returns the ids of the attempts that were closed.
 */
export function expireStaleAttempts(board: Board, dispatched: Record<string, DispatchRecord>, now = Date.now()): string[] {
  const expired: string[] = []
  for (const [taskId, entry] of Object.entries(dispatched)) {
    if (entry.ticketId != null || entry.endedAt != null) continue
    const task = board.nodes.find(node => node.id === taskId)
    if (task == null) continue
    const started = task.startedAt != null ? Date.parse(task.startedAt) : NaN
    if (!Number.isFinite(started)) continue
    if (now - started < STALE_ATTEMPT_MS) continue
    entry.endedAt = new Date(now).toISOString()
    expired.push(taskId)
  }
  return expired
}

/**
 * The project the bridge works on: the source setting, else the project the panel opened last.
 *
 * The panel and the bridge must not disagree about which project they are on, so an empty
 * setting means "follow the panel" — the panel records every project it opens in the board
 * registry, and the most recent one is the one the person is looking at.
 */
export function resolveProject(config: PlanboardConfig, stateDir?: string): string {
  if (config.project !== '') return config.project
  if (stateDir == null || stateDir === '') return defaultPlanboardProject()
  try {
    const file = join(stateDir, 'projects.json')
    if (!existsSync(file)) return defaultPlanboardProject()
    const all = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { name?: string; at?: string }>
    let best = ''
    let bestAt = ''
    for (const [project, entry] of Object.entries(all)) {
      const at = entry?.at ?? ''
      if (project !== '' && at > bestAt) { best = project; bestAt = at }
    }
    return best !== '' ? best : defaultPlanboardProject()
  } catch {
    return defaultPlanboardProject()
  }
}

export async function pollPlanboard(ctx: SourceContext, config: PlanboardConfig, signal: AbortSignal, options: WatchOptions = {}): Promise<PollResult> {
  const project = resolveProject(config, options.stateDir)
  const store = PlanStore.open(project, BRIDGE_STORE_OPTS)
  const board = store.board
  const dispatched = { ...(ctx.state.get(KV_DISPATCHED) ?? {}) }
  const settled = new Set(ctx.state.get(KV_SETTLED) ?? [])
  const reconcileSeen = { ...(ctx.state.get(KV_RECONCILE) ?? {}) }

  // ① 先把「工单已经建出来」这件事记住（评估是异步的，触发器入库时工单可能还不存在）。
  refreshTicketIds(ctx, dispatched)

  // ② 收单：工单终态 → 把证据写回板上。
  const settledCount = settleFinished(ctx, project, dispatched, settled)
  // A dispatch whose ticket never showed up (the Trigger was filtered, the router never accepted it)
  // would keep the task `doing` forever: after a grace period the attempt is closed and the task is
  // released, so it neither sticks in `doing` nor holds the single-issue lock forever.
  const expired = expireStaleAttempts(board, dispatched)
  for (const taskId of expired) releaseStaleTask(project, taskId, new Date().toISOString())

  // ③ 派单：板的发号语义（L1 单发号硬锁）——同一块同一时刻只派一个。
  //    用**收单之后**的板：收单会把结束的任务写成 blocked，而这一轮开始时读到的快照还是
  //    ready —— 用旧快照会把刚结算的任务再派出去一次，节点就永远收不干净。
  const current = PlanStore.open(project, BRIDGE_STORE_OPTS).board
  const doing = doingTasks(current)
  const ready = readyTasks(current)
  const candidates = doing.length === 0 ? ready.filter(task => shouldDispatch(task, dispatched)) : []
  let dispatchedCount = 0
  let filtered = 0
  let failed = 0
  // 只派一个：派出去的任务立刻变成 doing，L1 锁随之被占住，下一个任务等这一轮收卷后再派。
  for (const task of candidates.slice(0, 1)) {
    if (signal.aborted) throw new Error('The plan board source stopped during the dispatch')
    const attempt = attemptFor(task, dispatched)
    const trigger = triggerFor(current, project, config, task, attempt)
    let result: ReceiveResult
    try {
      result = await ctx.receive(trigger)
    } catch {
      // 单个任务派不出去不该拖垮整轮：跳过它，下一轮再试（Trigger id 稳定，不会重复建单）。
      failed += 1
      continue
    }
    if (result === 'filtered') filtered += 1
    else dispatchedCount += 1
    // 记住这次尝试：同一 task 不会再建第二张单（除非人把它重新放回就绪态）。
    dispatched[task.id] = { attempt, triggerId: trigger.id, threadKey: trigger.channel?.thread }
    describeThread(ctx, trigger, task)
    // 板面状态：派出去就算「进行中」（与 plan_next 的 task_issued 同义）。
    markDoing(project, task.id, trigger.id)
  }
  refreshTicketIds(ctx, dispatched)

  // ④ reconcile：板上有 ready 任务，引擎里却没有对应的在途工单。
  //    宽限期之内不算异常（刚派发时工单还没落库）。
  //    看的是**派完之后的板**：刚派出去的任务已经 doing，锁被占着，
  //    剩下的 ready 任务在排队等锁——那是正常状态，不该被算成异常。
  const after = PlanStore.open(project, BRIDGE_STORE_OPTS).board
  const unmatched = reconcileUnmatched(after, dispatched, readyTasks(after), reconcileSeen, Date.now())

  ctx.state.set(KV_DISPATCHED, bounded(dispatched, MAX_DISPATCH))
  ctx.state.set(KV_SETTLED, [...settled].slice(-MAX_SETTLED))
  ctx.state.set(KV_RECONCILE, bounded(reconcileSeen, MAX_DISPATCH))
  // 已派单却还没有工单：策略没放行发起人，或评估还在排队——都值得让人看见。
  const pending = Object.values(dispatched).filter(entry => entry.ticketId == null && entry.settledAt == null).length
  return { ready: ready.length, dispatched: dispatchedCount, settled: settledCount, filtered, failed, pending, locked: doingTasks(after).length, unmatched }
}

/**
 * reconcile：板上有 ready 任务，引擎里却没有对应的在途工单。
 *
 * 这是「派发没生效」的信号（派单抛错、策略不放行、板与引擎看的是不同的任务……）。
 * 有在途工单、或锁被占着（等 L1 锁是正常的）都不算异常，重新计时。
 */
export function reconcileUnmatched(
  board: Board,
  dispatched: Record<string, DispatchRecord>,
  ready: BoardNode[],
  seen: Record<string, number>,
  now: number,
): number {
  const inFlight = new Set(Object.entries(dispatched).filter(([, entry]) => entry.endedAt == null).map(([id]) => id))
  const locked = doingTasks(board).length > 0
  let count = 0
  for (const task of ready) {
    if (inFlight.has(task.id) || locked) {
      delete seen[task.id]
      continue
    }
    const first = seen[task.id] ?? now
    seen[task.id] = first
    if (now - first >= RECONCILE_GRACE_MS) count += 1
  }
  return count
}

/**
 * 本轮派单该用第几次尝试：首次为 0；上一轮尝试已经结束、且人又把任务放回就绪态时 +1
 * （Trigger id 随之变化，否则引擎会判定 duplicate 而建不出新工单）。
 */
function attemptFor(task: BoardNode, dispatched: Record<string, DispatchRecord>): number {
  const entry = dispatched[task.id]
  if (entry == null) return 0
  return entry.endedAt == null ? entry.attempt : entry.attempt + 1
}

/**
 * 任务是否该在本轮派单。
 *
 * 只有**人**重新启用任务（收单之后又动过它）才重开一轮。比较基准必须是「桥收单的时刻」
 * 而不是「工单结束的时刻」——用错了就形成 引擎→板→引擎 的回环：桥把工单结果写回板
 * （updatedAt 变了），板又变回可派，桥再派一次，永远停不下来。
 */
function shouldDispatch(task: BoardNode, dispatched: Record<string, DispatchRecord>): boolean {
  const entry = dispatched[task.id]
  if (entry == null) return true
  if (entry.settledAt != null) return task.updatedAt > entry.settledAt
  if (entry.endedAt != null) return task.updatedAt > entry.endedAt
  return false // 还在飞
}

/** 造触发器：简报 + 子导图指针。 */
function triggerFor(board: Board, project: string, config: PlanboardConfig, task: BoardNode, attempt: number) {
  const design = designFilePaths(project, config.designsDir, task.id)
  const summary = readDesignSummary(design.absolute)
  return planboardTrigger({
    project,
    task,
    boardVersion: board.version,
    planName: board.plan.name,
    goal: board.plan.goal,
    design,
    ...summary === undefined ? {} : { summary },
    actor: config.actor,
    attempt,
  })
}

/** 把线程的展示信息补上（面板上能看出是哪个板任务）。 */
function describeThread(ctx: SourceContext, trigger: { threads: { source: string; id: string }[]; meta: Record<string, unknown> }, task: BoardNode): void {
  const ref = trigger.threads[0]
  if (ref == null) return
  const key = `${ref.source}:${ref.id}`
  try {
    ctx.threads.describe(key, {
      label: task.title,
      facts: {
        task: { label: { zh: '计划板任务', en: 'Plan board task' }, value: task.id },
        status: { label: { zh: '状态', en: 'Status' }, value: task.status },
      },
    })
  } catch {
    // 线程还不存在（触发器被过滤）时忽略：描述只是展示信息。
  }
}

/** 在未结束的工单里找我们派出去的那些，记下工单 id。 */
function refreshTicketIds(ctx: SourceContext, dispatched: Record<string, DispatchRecord>): void {
  let open: Ticket[]
  try { open = ctx.tickets.open() } catch { open = [] }
  for (const ticket of open) {
    const trigger = ctx.triggers.get(ticket.origin.triggerId)
    const taskId = trigger?.meta?.taskId
    if (typeof taskId !== 'string') continue
    const entry = dispatched[taskId]
    if (entry == null || entry.triggerId !== ticket.origin.triggerId) continue
    if (entry.ticketId !== ticket.id) entry.ticketId = ticket.id
  }
  // Find our ticket through the thread's subscriptions, not through tickets.open():
  //   - a ticket that already ended (failed fast, stopped, merged) is no longer open, and
  //   - the engine may attach a new attempt to the ticket it already has instead of opening
  //     a second one, so the ticket's origin trigger is the previous attempt's.
  // Only this task's tickets sit on this thread, so a subscription is enough to identify ours.
  for (const entry of Object.values(dispatched)) {
    if (entry.ticketId != null || entry.threadKey == null) continue
    let thread: { subscriptions?: string[] } | undefined
    try { thread = ctx.threads.get(entry.threadKey) } catch { thread = undefined }
    for (const id of thread?.subscriptions ?? []) {
      let ticket: Ticket | undefined
      try { ticket = ctx.tickets.get(id) } catch { ticket = undefined }
      if (ticket == null) continue
      entry.ticketId = id
      break
    }
  }
}

/**
 * 收单：工单结束 → 回写证据 + 落状态。
 * 成功（completed/merged）→ `done`（证据必填）；其余（closed/dropped/stopped）→ `blocked`，
 * 等人处置，避免「失败即重派」的无限循环。
 */
function settleFinished(ctx: SourceContext, project: string, dispatched: Record<string, DispatchRecord>, settled: Set<string>): number {
  let count = 0
  for (const [taskId, entry] of Object.entries(dispatched)) {
    if (entry.ticketId == null || settled.has(entry.ticketId)) continue
    let ticket: Ticket | undefined
    try { ticket = ctx.tickets.get(entry.ticketId) } catch { continue }
    if (ticket == null) continue
    const report = ticket.assignments.at(-1)?.report
    // A failed worker leaves the ticket without `ended` (a person may retry it), so the attempt is
    // over as soon as the last report says `failed`.
    const failed = report?.state === 'failed'
    if (ticket.ended == null && !failed) continue
    const evidence = evidenceOf(ticket)
    const now = new Date().toISOString()
    // 这一轮尝试已经结束（工单终结）：记下时刻，人重新启用任务即可重开一轮。
    if (entry.endedAt == null) entry.endedAt = ticket.ended?.at ?? report?.at ?? now
    if (settled.has(entry.ticketId)) continue
    try {
      writeBack(project, taskId, ticket, evidence, now)
    } catch (error) {
      // 落板失败（板坏了 / 校验门拦截）：不记已收单，下一轮再试。
      continue
    }
    settled.add(entry.ticketId)
    // 收单时刻 = 写回板的时刻：人之后动这个任务才算「重新启用」，桥自己写回不算。
    entry.settledAt = now
    count += 1
  }
  return count
}

/**
 * 回写证据（走板自己的门：`PlanStore.mutate()` → `lintBoard()` → 事件流 → 落盘 + ROADMAP 镜像）。
 * 绝不直接改 JSON：证据门（done 必须有证据）与状态机都由 lint 兜住。
 */
function writeBack(project: string, taskId: string, ticket: Ticket, evidence: string[], now: string): void {
  const store = PlanStore.open(project, BRIDGE_STORE_OPTS)
  const node = store.boardNode(taskId)
  if (node == null) return
  const success = ticket.ended?.outcome === 'completed' || ticket.ended?.outcome === 'merged'
  const target = success ? 'done' : 'blocked'
  const from = node.status
  store.mutate(BRIDGE_ACTOR, 'status_changed', { taskId, from, to: target, ticketId: ticket.id, outcome: ticket.ended?.outcome ?? null }, (b) => {
    const n = b.nodes.find(item => item.id === taskId)
    if (n == null) return
    // 证据两种结局都记（失败证据同样重要）；状态只在流转合法时改，不硬掰。
    n.evidence = [...(n.evidence ?? []), ...evidence]
    if (transitionOk(n.status, target)) n.status = target
    n.updatedAt = now
  })
  try { store.driftCheck(taskId, BRIDGE_ACTOR) } catch { /* 漂移核对失败不阻断回写 */ }
}

/**
 * 工单结束后的证据清单：工单号与结局、worker 的报告摘要（测试/CI/PR 链接通常在里面）、
 * 执行目录。摘要按行拆开，板面（ROADMAP 镜像）一行一条，读起来像人写的。
 */
export function evidenceOf(ticket: Ticket): string[] {
  const out: string[] = []
  const ended = ticket.ended
  out.push(`superagent 工单 ${ticket.id} 结束: outcome=${ended?.outcome ?? 'unknown'} by=${ended?.by ?? 'unknown'}${ended?.reason == null ? '' : ' reason=' + ended.reason}`)
  const report = ticket.assignments.at(-1)?.report
  if (report != null) {
    const lines = report.summary.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '').slice(0, 6)
    for (const line of lines) out.push('worker 报告(' + report.state + '): ' + line.slice(0, 300))
    const urls = [...new Set(report.summary.match(/https?:\/\/[^\s)"'<>]+/g) ?? [])].slice(0, 5)
    for (const url of urls) out.push('链接: ' + url)
  }
  if (ticket.execution != null) out.push('执行目录: ' + ticket.execution.directory + '（worktree ' + ticket.execution.name + '）')
  return out
}

/** 派单：把任务标成「进行中」（与 plan_next 的 task_issued 同义），失败不阻断派单。 */
function markDoing(project: string, taskId: string, triggerId: string): void {
  try {
    const store = PlanStore.open(project, BRIDGE_STORE_OPTS)
    const node = store.boardNode(taskId)
    if (node == null || node.status === 'doing') return
    if (!transitionOk(node.status, 'doing')) return
    const now = new Date().toISOString()
    store.mutate(BRIDGE_ACTOR, 'task_issued', { taskId, triggerId }, (b) => {
      const n = b.nodes.find(item => item.id === taskId)
      if (n == null) return
      n.status = 'doing'
      n.startedAt = n.startedAt ?? now
      n.updatedAt = now
    })
  } catch {
    // 板写不进去（并发冲突 / 校验门拦截）：下一轮再来；Trigger id 稳定，不会重复建单。
  }
}

/**
 * 把「派出去却始终没有工单」的任务从 doing 放回 blocked。
 *
 * 不放回去的话，L1 单发号锁会被一个根本没有工单的任务一直占着，整块板就再也不会派单。
 * 放回 blocked 而不是 planned：派发失败（多半是策略没放行发起人）不该由桥自己无限重试，
 * 人处理完（把任务放回就绪态）才重开新一轮。
 */
function releaseStaleTask(project: string, taskId: string, now: string): void {
  try {
    const store = PlanStore.open(project, BRIDGE_STORE_OPTS)
    const node = store.boardNode(taskId)
    if (node == null || node.status !== 'doing') return
    if (!transitionOk(node.status, 'blocked')) return
    store.mutate(BRIDGE_ACTOR, 'dispatch_lost', { taskId, reason: 'no_ticket' }, (b) => {
      const n = b.nodes.find(item => item.id === taskId)
      if (n == null) return
      n.status = 'blocked'
      n.note = ((n.note ?? '') + '\n派发后引擎没有生成工单（策略或评估未放行），已挂起等人处置').trim()
      n.updatedAt = now
    })
  } catch {
    // 板写不进去就下一轮再来。
  }
}

/** 限制 KV 记录条数（保留最近的一批）。 */
function bounded<T>(record: Record<string, T>, limit: number): Record<string, T> {
  const keys = Object.keys(record)
  if (keys.length <= limit) return record
  const out: Record<string, T> = {}
  for (const key of keys.slice(keys.length - limit)) out[key] = record[key]!
  return out
}