import { CONFIG_SERVICE } from '../planner/index.js';
import { PLANBOARD_HEALTH, planboardKind } from './source.js';
import { watchPlanboard } from './watch.js';
/**
 * 把计划板桥接到引擎上。
 *
 * @param ctx 宿主上下文（cordis Context）。
 */
export function applyBridge(ctx) {
    // The board's registry directory (where the panel records the projects it opened).
    const config = ctx.get(CONFIG_SERVICE);
    ctx.inject(['orchestrator'], (hostCtx) => {
        const host = hostCtx;
        const orchestrator = host.orchestrator;
        if (orchestrator == null)
            return;
        // ① 注册来源 kind（register 返回注销器；引擎重启或插件卸载时自动注销）。
        hostCtx.effect(() => orchestrator.sources.register(planboardKind), 'planboard: source kind');
        // ② 起轮询循环：读板 → 派单 → 收单 → 回写证据。
        const source = orchestrator.context(planboardKind);
        const controller = new AbortController();
        const running = watchPlanboard(source, controller.signal, { stateDir: config?.stateDir }).catch((error) => {
            // DSH 会在未处理的 rejection 上结束进程，所以逃出循环的失败必须变成健康状态。
            try {
                source.report(PLANBOARD_HEALTH, { state: 'error', detail: String(error) });
            }
            catch { /* 健康条目可能已经随卸载注销 */ }
        });
        hostCtx.effect(() => async () => { controller.abort(); await running; }, 'planboard: watch loop');
    });
}
export { planboardKind, PLANBOARD_HEALTH, PLANBOARD_KIND, PLANBOARD_ACTOR_DEFAULT } from './source.js';
export { planboardBrief, planboardTrigger, planboardTriggerId, planboardThreadId, designFilePaths, readDesignSummary, summarizeDesign } from './trigger.js';
export { pollPlanboard, watchPlanboard, evidenceOf, KV_DISPATCHED, KV_SETTLED } from './watch.js';
//# sourceMappingURL=index.js.map