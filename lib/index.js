import z from '@deepseek-ai/schemastery';
import { apply as applyBoard } from './board/index.js';
import { applyPlanToBoard, collectRepoContext, generatePlan } from './planner/index.js';
import { applyBridge } from './bridge/index.js';
import { registerPlanner } from './planner/index.js';
export const name = 'dsh-plan-superagent';
/**
 * 只列**一定存在**的服务。
 *
 * 'tools' 是 DSH 核心服务（@deepseek-ai/dsh-tools），任何 profile 都有，所以列它安全。
 *
 * 'orchestrator'（执行引擎 dsh-superagent 的服务）**绝不能**出现在这里：cordis 只在 inject 里
 * 的服务全部到位时才加载插件，引擎没装 → 整个插件永不激活（板与 plan_generate 一起废掉）。
 * 桥自己用嵌套 ctx.inject(['orchestrator'], cb) 挂载：引擎在就挂、不在就跳过。
 */
export const inject = ['tools'];
/**
 * 解析后的插件配置以服务形式挂在 ctx 上，供桥/规划器读取：`ctx.get('planSuperagentConfig')`。
 * （两者的导出契约分别只收 ctx / tools，收不到 config，故走 ctx 传递。）
 */
export const CONFIG_SERVICE = 'planSuperagentConfig';
export const Config = z.object({
    project: z.string().default('').description('板的 project 目录（项目根绝对路径；Windows 形如 C:\\work\\my-project，POSIX 形如 /home/me/my-project）'),
    bridgeActorId: z.string().default('planboard').description('桥向执行引擎发起工单时的 actor id；须加入该 source 的 policy.allowed，否则工单被策略拒绝（与引擎侧 planboard Source 的 actor 同名）'),
    subDesignDir: z.string().default('.plan-board/designs').description('子导图目录（相对 project；task 的子导图另存 <project>/.plan-board/designs/*.json）'),
    stateDir: z.string().default('').description('注册表目录（缺省 <DSH_HOME>/dsh-plan-board）'),
    blockOnDrift: z.boolean().default(true).description('L5 漂移阻断：git 交叉核对不匹配时拒绝发号，直到人在面板处置'),
    observeTools: z.boolean().default(true).description('L7 工具观测：记录会话内全部工具调用（不含参数）到 tool-calls.jsonl'),
    enforceScope: z.boolean().default(true).description('L7 越界拦截：write/edit 路径未命中 doing 任务 scope 时拒绝执行（面板可临时挂起）'),
});
/** 把任意异常压成一行可读文本（不把栈打进日志）。 */
function describe(error) {
    return error instanceof Error ? error.message : String(error);
}
export function apply(ctx, config = {}) {
    const cfg = {
        project: config.project ?? '',
        bridgeActorId: config.bridgeActorId ?? 'planboard',
        subDesignDir: config.subDesignDir ?? '.plan-board/designs',
        stateDir: config.stateDir ?? '',
        blockOnDrift: config.blockOnDrift ?? true,
        observeTools: config.observeTools ?? true,
        enforceScope: config.enforceScope ?? true,
    };
    const disposers = [];
    // 桥与规划器只拿到 ctx / tools，拿不到 config —— 把解析后的配置作为服务挂到 ctx 上。
    try {
        disposers.push(ctx.provide(CONFIG_SERVICE, cfg));
    }
    catch (error) {
        ctx.logger.warn('[dsh-plan-superagent] 配置服务挂载失败：%s', describe(error));
    }
    // ① 一句话规划：面板的输入框 -> 宿主模型 -> 三层任务树 + 每任务子导图 -> 全部进待批队列（人审门）。
    const plan = async ({ project, sentence }) => {
        const generated = await generatePlan({ ctx, sentence, context: collectRepoContext(project) });
        const applied = applyPlanToBoard({
            plan: generated,
            project,
            opts: { blockOnDrift: cfg.blockOnDrift },
            actor: 'human:panel',
            reason: 'plan_generate：' + generated.plan.goal,
            designDir: cfg.subDesignDir,
        });
        return {
            ok: true,
            approvalId: applied.approvalId,
            pendingApproval: applied.pendingApproval,
            boardCreated: applied.boardCreated,
            version: applied.version,
            moduleCount: applied.moduleCount,
            taskCount: applied.taskCount,
            opCount: applied.opCount,
            plan: { name: generated.plan.name, goal: generated.plan.goal },
            modules: generated.modules.map(m => ({ id: m.id, title: m.title, tasks: m.tasks.map(t => ({ id: t.id, title: t.title })) })),
            designFiles: applied.designFiles.map(d => ({ taskId: d.taskId, path: d.path, relative: d.relative })),
        };
    };
    // ② 板那半：自带嵌套 inject(['webServer','tools'])，web profile 才挂路由与板工具。
    try {
        const disposeBoard = applyBoard(ctx, {
            stateDir: cfg.stateDir,
            blockOnDrift: cfg.blockOnDrift,
            observeTools: cfg.observeTools,
            enforceScope: cfg.enforceScope,
        }, { plan });
        if (typeof disposeBoard === 'function')
            disposers.push(disposeBoard);
    }
    catch (error) {
        ctx.logger.error('[dsh-plan-superagent] 板加载失败（面板与板工具不可用）：%s', describe(error));
    }
    // ② 桥：执行引擎是可选依赖。引擎的 'orchestrator' 服务不存在时**不能抛**——
    //    兜住并 warn，板与规划器照常工作（引擎缺失 = 桥静默禁用，见 README「已知限制」）。
    try {
        applyBridge(ctx);
    }
    catch (error) {
        ctx.logger.warn('[dsh-plan-superagent] 未检测到执行引擎，桥未启用：%s', describe(error));
    }
    // ③ 规划器：向 tools 服务注册 plan_generate 工具。
    try {
        const disposePlanner = registerPlanner(ctx.tools, ctx);
        if (typeof disposePlanner === 'function')
            disposers.push(disposePlanner);
    }
    catch (error) {
        ctx.logger.warn('[dsh-plan-superagent] 规划器注册失败，plan_generate 不可用：%s', describe(error));
    }
    return () => {
        for (const dispose of disposers) {
            try {
                dispose();
            }
            catch { /* 卸载幂等 */ }
        }
    };
}
//# sourceMappingURL=index.js.map