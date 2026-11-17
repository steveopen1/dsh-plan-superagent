/**
 * plan_generate 工具：一句话 → 任务树 + 每任务子导图 → 写板（结构变更等人审）。
 *
 * 装配：
 *   - registerPlanner(ctx.tools)            —— 入口（src/index.ts 用这个）
 *     宿主 ctx 从 tools 服务上取（cordis Service 自带 ctx），配置从 ctx.get('planSuperagentConfig') 读。
 *   - registerPlannerTools(tools, ctx, stateDir, opts, options) —— 显式装配（自测/嵌入用）
 *
 * 人审门在 apply.ts：结构变更只进待批队列，板结构在人批准前不变。
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { isAbsolutePath } from '../board/pathutil.js';
import { applyPlanToBoard, DESIGN_DIR } from './apply.js';
import { collectRepoContext, generatePlan } from './generate.js';
import { PlannerError } from './schema.js';
export const PLAN_GENERATE_TOOL = 'plan_generate';
/** 宿主挂配置的服务名（src/index.ts 用 ctx.provide 挂上）。 */
export const CONFIG_SERVICE = 'planSuperagentConfig';
function toJson(x) {
    return JSON.parse(JSON.stringify(x));
}
function errJson(e) {
    if (e instanceof PlannerError)
        return { ok: false, code: e.code, error: e.message };
    return { ok: false, code: 'TOOL_FAILED', error: e instanceof Error ? e.message : String(e) };
}
function actorOf(ctx) {
    return 'agent:' + (ctx?.agent?.id ?? 'unknown');
}
/** 默认注册表目录（与板那半一致：<DSH_HOME>/dsh-plan-board）。 */
export function defaultStateDir() {
    const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
    return join(dshHome, 'dsh-plan-board');
}
/**
 * project 解析：必须是绝对路径；
 * 缺省顺序 = 工具参数 project → 宿主配置的 project → <stateDir>/default。
 */
export function resolveProject(p, stateDir, defaultProject = '') {
    if (typeof p === 'string' && p.trim() !== '') {
        if (!isAbsolutePath(p))
            throw new PlannerError('BAD_PROJECT', 'project 必须是项目根目录绝对路径');
        return p;
    }
    if (defaultProject !== '' && isAbsolutePath(defaultProject))
        return defaultProject;
    return join(stateDir, 'default');
}
/** 从宿主配置服务里读配置（读不到就退化成空配置，不抛）。 */
export function readHostConfig(ctx) {
    try {
        const host = ctx;
        if (typeof host.get !== 'function')
            return {};
        const cfg = host.get(CONFIG_SERVICE);
        if (cfg == null || typeof cfg !== 'object')
            return {};
        const out = {};
        if (typeof cfg.project === 'string')
            out.project = cfg.project;
        if (typeof cfg.stateDir === 'string')
            out.stateDir = cfg.stateDir;
        if (typeof cfg.blockOnDrift === 'boolean')
            out.blockOnDrift = cfg.blockOnDrift;
        if (typeof cfg.subDesignDir === 'string')
            out.subDesignDir = cfg.subDesignDir;
        return out;
    }
    catch {
        return {};
    }
}
/** 从 tools 服务上反查宿主 cordis ctx（cordis Service 自带 ctx 字段）。 */
function hostCtxOf(tools) {
    const t = tools;
    if (typeof t?.get === 'function')
        return tools;
    const c = t?.ctx;
    if (c != null && typeof c.get === 'function')
        return c;
    return undefined;
}
/** 显式装配：注册 plan_generate，返回注销函数。 */
export function registerPlannerTools(tools, ctx, stateDir, opts, options = {}) {
    const designDir = options.designDir ?? DESIGN_DIR;
    const defaultProject = options.defaultProject ?? '';
    const disposer = tools.register(defineTool({
        name: PLAN_GENERATE_TOOL,
        description: 'Turn one sentence into a plan board: generates a three-layer plan (plan -> modules -> tasks) plus a per-task implementation sub-graph, then proposes it to the plan board as a pending approval (structural changes require human approval in the panel before they land). Returns the pending approval id and the design-graph file paths.',
        parameters: {
            sentence: { type: 'string', required: true, description: '用户的一句话需求（中文/英文皆可），例如「给插件加一个把任务导出成 Markdown 的命令」' },
            project: { type: 'string', description: '项目根目录绝对路径。缺省 = 宿主配置的 project，再缺省 = ~/.dsh/dsh-plan-board/default' },
        },
        output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
        execute: async (args, toolCtx) => {
            try {
                const a = args;
                const sentence = String(a.sentence ?? '').trim();
                if (sentence === '')
                    throw new PlannerError('EMPTY_SENTENCE', 'sentence 不能为空：一句话规划需要具体需求');
                const project = resolveProject(a.project, stateDir, defaultProject);
                const context = collectRepoContext(project);
                const plan = await generatePlan({
                    ctx,
                    sentence,
                    context,
                    signal: toolCtx?.signal,
                });
                const applied = applyPlanToBoard({
                    plan,
                    project,
                    opts,
                    actor: actorOf(toolCtx),
                    reason: 'plan_generate：' + plan.plan.goal,
                    designDir,
                    onEvent: options.onEvent,
                });
                return toJson({
                    ok: true,
                    sentence,
                    plan: plan.plan,
                    project,
                    modules: plan.modules.map((m) => ({ id: m.id, title: m.title, tasks: m.tasks.map((t) => t.id) })),
                    taskCount: applied.taskCount,
                    moduleCount: applied.moduleCount,
                    // 人审门：结构变更只是「提议」，板结构在批准前不变。
                    approvalId: applied.approvalId,
                    pendingApproval: applied.pendingApproval,
                    boardCreated: applied.boardCreated,
                    version: applied.version,
                    opCount: applied.opCount,
                    designDir,
                    designFiles: applied.designFiles,
                    note: '结构变更已进待批队列，需人在面板批准后才会写进板；子导图已落盘到 ' + designDir + '/<taskId>.json',
                });
            }
            catch (e) {
                return errJson(e);
            }
        },
        timeoutMs: 240_000,
    }));
    return typeof disposer === 'function' ? disposer : () => { };
}
/**
 * 入口（src/index.ts 调用）：registerPlanner(ctx.tools)。
 * 宿主 ctx 从 tools 服务反查，配置从 ctx.get('planSuperagentConfig') 读；
 * 拿不到 ctx 时工具仍可注册，但调模型会明确报 NO_MODEL（不编数据）。
 */
export function registerPlanner(tools, hostCtx, config) {
    const raw = tools;
    let service = raw;
    if (typeof raw.register !== 'function') {
        const inner = raw.tools;
        if (inner != null && typeof inner.register === 'function')
            service = inner;
    }
    if (typeof service.register !== 'function') {
        throw new PlannerError('NO_TOOLS', 'tools 服务不可用：ctx.tools 没有 register 方法');
    }
    if (service == null || typeof service.register !== 'function') {
        throw new PlannerError('NO_TOOLS', 'tools 服务不可用：ctx.tools 没有 register 方法');
    }
    const ctx = hostCtx ?? hostCtxOf(service);
    const cfg = config ?? readHostConfig(ctx);
    const stateDir = cfg.stateDir != null && cfg.stateDir !== '' ? cfg.stateDir : defaultStateDir();
    const opts = { blockOnDrift: cfg.blockOnDrift !== false };
    return registerPlannerTools(service, ctx, stateDir, opts, {
        defaultProject: cfg.project ?? '',
        designDir: cfg.subDesignDir ?? DESIGN_DIR,
    });
}
//# sourceMappingURL=tool.js.map