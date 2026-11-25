/**
 * 把生成结果写进板（走 plan_edit 的 op 语义 + L2 人审门）。
 *
 * 人审门（照 src/board/tools.ts 的分流规则实现，不绕门）：
 *   - 结构性变更（init_board / add_node / 指向 note 的 update_node）**全部进待批队列**，
 *     人在面板点「批准」后由 routes.ts 的 /approve 用同一批 ops 一次性 applyEditOps；
 *   - 板子结构在批准前**一个节点都不会长出来**；
 *   - 与 plan_edit 一致：目标项目还没有板子时，先 ensure 出空板（只写 plan 名/目标），
 *     再把 init_board + add_node 一起送审。
 *
 * 子导图：板只有两层（module → task），task 里不能再挂子任务，
 * 所以每个 task 的 design 另存为 <project>/.plan-board/designs/<taskId>.json，
 * 并在 task 的 note 里写指针（design-graph: .plan-board/designs/<taskId>.json）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PlanStore } from '../board/store.js';
import { DERIVED_MARKER } from './schema.js';
import { PlannerError } from './schema.js';
/** note 里的指针前缀（消费方据此定位子导图文件）。 */
export const DESIGN_POINTER_PREFIX = 'design-graph: ';
/** 子导图目录（相对项目根，'/' 分隔）。 */
export const DESIGN_DIR = '.plan-board/designs';
/** 把相对目录（'/' 分隔）转成绝对路径（Windows 友好，不手拼分隔符）。 */
export function designDirAbs(project, designDir) {
    const parts = designDir.split('/').filter((p) => p !== '' && p !== '.');
    return join(project, ...parts);
}
/** 子导图相对路径（写进 task.note 的指针）。 */
export function designRelativePath(taskId, designDir = DESIGN_DIR) {
    return designDir + '/' + taskId + '.json';
}
/** 子导图绝对路径。 */
export function designPath(project, taskId, designDir = DESIGN_DIR) {
    return join(designDirAbs(project, designDir), taskId + '.json');
}
/**
 * 编号避让：板上已有 m-3 / t-7 时，新计划从 m-4 / t-8 接着编，
 * 避免送审的 add_node 在批准那一刻撞 DUP_ID（approve 是一次性 applyEditOps，撞了整批失败）。
 */
export function remapIds(plan, existing) {
    const moduleOffset = maxIndex(existing, /^m-(\d+)$/);
    const taskOffset = maxIndex(existing, /^t-(\d+)$/);
    const idMap = new Map();
    plan.modules.forEach((m, i) => { idMap.set(m.id, 'm-' + String(moduleOffset + i + 1)); });
    let seq = 0;
    for (const m of plan.modules) {
        for (const t of m.tasks) {
            seq += 1;
            idMap.set(t.id, 't-' + String(taskOffset + seq));
        }
    }
    const modules = plan.modules.map((m, i) => ({
        id: idMap.get(m.id),
        title: m.title,
        tasks: m.tasks.map((t) => ({
            ...t,
            id: idMap.get(t.id),
            deps: t.deps.map((d) => idMap.get(d) ?? d),
        })),
    }));
    return { plan: { plan: plan.plan, modules }, idMap };
}
function maxIndex(existing, re) {
    let max = 0;
    for (const id of existing) {
        const m = re.exec(id);
        if (m == null)
            continue;
        const n = Number(m[1]);
        if (Number.isFinite(n) && n > max)
            max = n;
    }
    return max;
}
/** 组装送审的 ops：init_board（仅新板）→ 每个 module 的 add_node → 每个 task 的 add_node → note 指针 update_node。 */
export function buildOps(plan, includeInit, designDir = DESIGN_DIR) {
    const ops = [];
    if (includeInit) {
        ops.push({ op: 'init_board', name: plan.plan.name, goal: plan.plan.goal });
    }
    for (const m of plan.modules) {
        ops.push({
            op: 'add_node',
            node: { id: m.id, type: 'module', title: m.title, parent: null, priority: 3 },
        });
        for (const t of m.tasks) {
            ops.push({
                op: 'add_node',
                node: {
                    id: t.id,
                    type: 'task',
                    title: t.title,
                    parent: m.id,
                    deps: t.deps,
                    priority: t.priority ?? 3,
                    acceptance: t.acceptance,
                    scope: t.scope,
                },
            });
        }
    }
    // note 指针：add_node 之后节点才存在，所以 update_node 必须排在同一批 ops 的最后，
    // 由人批准时一次性按序 applyEditOps（先建节点再写 note）。
    for (const m of plan.modules) {
        for (const t of m.tasks) {
            ops.push({
                op: 'update_node',
                id: t.id,
                fields: { note: DESIGN_POINTER_PREFIX + designRelativePath(t.id, designDir) },
            });
        }
    }
    return ops;
}
/** 落盘子导图（原子写：tmp → rename）。 */
export function writeDesigns(project, plan, designDir = DESIGN_DIR) {
    const dir = designDirAbs(project, designDir);
    mkdirSync(dir, { recursive: true });
    const out = [];
    const now = new Date().toISOString();
    for (const m of plan.modules) {
        for (const t of m.tasks) {
            const file = join(dir, t.id + '.json');
            const payload = {
                taskId: t.id,
                taskTitle: t.title,
                moduleId: m.id,
                moduleTitle: m.title,
                plan: plan.plan,
                generatedAt: now,
                // source：这张导图是模型写的还是推导的？——/plan 返回体靠它如实汇报，
                // 不能让人以为拿到的 8 张全是模型写的（静默降级过一次，教训）。
                source: t.design.summary.startsWith(DERIVED_MARKER) ? 'derived' : 'model',
                design: t.design,
            };
            const tmp = file + '.tmp';
            writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
            renameSync(tmp, file);
            out.push({ taskId: t.id, path: file, relative: designRelativePath(t.id, designDir) });
        }
    }
    return out;
}
/**
 * 写板：结构变更进待批队列等人审（板结构在批准前不变）。
 * 返回待批项 id 与子导图落盘清单。
 */
export function applyPlanToBoard(options) {
    const plan = options.plan;
    const project = options.project;
    if (project === '')
        throw new PlannerError('BAD_PROJECT', 'project 不能为空');
    const reason = options.reason ?? ('plan_generate：' + plan.plan.goal);
    const boardFile = join(project, '.plan-board', 'plan.board.json');
    const boardCreated = !existsSync(boardFile);
    // 与 plan_edit 同款：没有板子就先 ensure 一个空板（只有 plan 名/目标），节点仍要人批。
    const store = PlanStore.ensure(project, options.opts, { name: plan.plan.name, goal: plan.plan.goal }, options.onEvent);
    // 已被占用的 id：板上现有节点 + 待批队列里已经预留的。
    // 后者很关键：两次「一句话生成」都会编 m-1/t-1，若不预留，第二批在批准那一刻整批 DUP_ID 失败。
    const taken = new Set();
    for (const n of store.board.nodes)
        taken.add(n.id);
    for (const ap of store.board.pendingApprovals) {
        for (const op of ap.ops) {
            if (op.op === 'add_node')
                taken.add(op.node.id);
        }
    }
    const remapped = remapIds(plan, taken);
    const finalPlan = remapped.plan;
    const designDir = options.designDir ?? DESIGN_DIR;
    const ops = buildOps(finalPlan, boardCreated, designDir);
    // 子导图先落盘：人批准后 note 里的指针立刻可解析。
    const designFiles = writeDesigns(project, finalPlan, designDir);
    let approvalId = '';
    const now = new Date().toISOString();
    store.mutate(options.actor, 'plan_edit_proposed', { reason, ops: ops.length, source: 'plan_generate' }, (b) => {
        b.apSeq += 1;
        approvalId = 'ap-' + String(b.apSeq);
        b.pendingApprovals.push({ id: approvalId, reason, ops, by: options.actor, proposedAt: now });
    });
    let moduleCount = 0;
    let taskCount = 0;
    let modelDesigns = 0;
    let derivedDesigns = 0;
    for (const m of finalPlan.modules) {
        moduleCount += 1;
        taskCount += m.tasks.length;
        for (const t of m.tasks) {
            if (t.design.summary.startsWith(DERIVED_MARKER))
                derivedDesigns += 1;
            else
                modelDesigns += 1;
        }
    }
    return {
        ok: true,
        project,
        approvalId,
        pendingApproval: true,
        boardCreated,
        version: store.board.version,
        moduleCount,
        taskCount,
        opCount: ops.length,
        reason,
        designFiles,
        designQuality: { model: modelDesigns, derived: derivedDesigns, total: modelDesigns + derivedDesigns },
    };
}
/** 读回某个 task 的子导图文件（消费方用；文件不存在返回 null）。 */
export function readDesign(project, taskId, designDir = DESIGN_DIR) {
    const file = designPath(project, taskId, designDir);
    if (!existsSync(file))
        return null;
    try {
        if (!existsSync(designDirAbs(project, designDir)))
            return null;
        return JSON.parse(readFileSync(file, 'utf8'));
    }
    catch {
        return null;
    }
}
/** 列出某项目下已有的子导图文件（调试/面板用）。 */
export function listDesigns(project, designDir = DESIGN_DIR) {
    const dir = designDirAbs(project, designDir);
    if (!existsSync(dir))
        return [];
    try {
        return readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    }
    catch {
        return [];
    }
}
//# sourceMappingURL=apply.js.map