/**
 * 桥的宿主入口：把计划板接到 superagent 上。
 *
 * ## 关键纪律：嵌套 `ctx.inject(['orchestrator'], cb)`
 *
 * 引擎（dsh-superagent）是**可选依赖**：它没装（或没启用）时，这个注入永远不触发，
 * 于是整个插件不会因为「桥接不上」而不激活——计划板照常可用（5 个工具、面板、漂移防护）。
 * 引擎装上之后，cordis 会自动跑起回调：注册 kind、起轮询循环。
 * 这与计划板本身的 `ctx.inject(['webServer','tools'], cb)` 是同一套纪律。
 *
 * 卸载即净：注入作用域被销毁时，`ctx.effect` 注册的两个 disposer 依次执行
 * ——注销 kind、停轮询循环（并 await 循环收尾）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { CONFIG_SERVICE } from '../planner/index.js'
import type { SourceHost } from './contract.js'
import { PLANBOARD_HEALTH, planboardKind } from './source.js'
import { watchPlanboard } from './watch.js'

/** 带 `orchestrator` 服务的上下文（由 dsh-superagent 提供）。 */
export type BridgeHostContext = Context & { orchestrator?: SourceHost }

/**
 * 把计划板桥接到引擎上。
 *
 * @param ctx 宿主上下文（cordis Context）。
 */
export function applyBridge(ctx: Context): void {
  // The board's registry directory (where the panel records the projects it opened).
  const config = ctx.get(CONFIG_SERVICE) as { stateDir?: string } | undefined
  ctx.inject(['orchestrator'], (hostCtx) => {
    const host = hostCtx as BridgeHostContext
    const orchestrator = host.orchestrator
    if (orchestrator == null) return

    // ① 注册来源 kind（register 返回注销器；引擎重启或插件卸载时自动注销）。
    hostCtx.effect(() => orchestrator.sources.register(planboardKind), 'planboard: source kind')

    // ② 起轮询循环：读板 → 派单 → 收单 → 回写证据。
    const source = orchestrator.context(planboardKind)
    const controller = new AbortController()
    const running = watchPlanboard(source, controller.signal, { stateDir: config?.stateDir }).catch((error: unknown) => {
      // DSH 会在未处理的 rejection 上结束进程，所以逃出循环的失败必须变成健康状态。
      try { source.report(PLANBOARD_HEALTH, { state: 'error', detail: String(error) }) }
      catch { /* 健康条目可能已经随卸载注销 */ }
    })
    hostCtx.effect(() => async () => { controller.abort(); await running }, 'planboard: watch loop')
  })
}

export { planboardKind, PLANBOARD_HEALTH, PLANBOARD_KIND, PLANBOARD_ACTOR_DEFAULT } from './source.js'
export { planboardBrief, planboardTrigger, planboardTriggerId, planboardThreadId, designFilePaths, readDesignSummary, summarizeDesign } from './trigger.js'
export { pollPlanboard, watchPlanboard, evidenceOf, KV_DISPATCHED, KV_SETTLED } from './watch.js'
export type { PlanboardConfig } from './source.js'
export type { Trigger, SourceContext, SourceKind } from './contract.js'