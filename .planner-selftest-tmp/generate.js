/**
 * 「一句话 → 计划树 + 每任务子导图」生成器（**两段式**）。
 *
 * 为什么拆两段：一次输出「整棵树 + 每张子导图」的 JSON 太大，模型的流会断
 * （实测：宿主默认的 Anthropic 兼容流 "stream ended without a stop reason"；
 *  另一轮是上游 90s abort）。于是拆开：
 *   - 第一段（树）：只出 plan → modules → tasks（title/acceptance/scope/deps/priority）；
 *   - 第二段（子导图）：**逐个任务**单独一次调用，只出那一张的 design（输出小，流不容易断）。
 *
 * 降级纪律：**子导图**降级（按该任务已有的验收标准与范围推导一份，并写明「自动推导」），
 * **树不降级**——宁可明确失败，也不要编一棵计划树出来（本仓原则：绝不编数据冒充模型结果）。
 *
 * 重试纪律：超时 / 响应流中断 / 上游报错都**可重试**（这类故障常常是瞬时的：模型慢、网络抖）；
 * 重试只能用**剩余预算**里的钱，绝不超支；预算烧完就停，给一句人看得懂、能动手的报错。
 *
 * 预算纪律：timeoutMs 是**整段的总预算**（树 + 全部子导图共用）。
 * 树是主产出，先给它（上限 TREE_TIMEOUT_CAP）；子导图吃剩下的，
 * 剩下的不够了就直接推导，不再去调模型（省得最后几张卡在超时上把整次拖死）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { callModel } from './llm.js';
import { DESIGN_SYSTEM_PROMPT, PLAN_SYSTEM_PROMPT, buildDesignPrompt, buildUserPrompt } from './prompt.js';
import { PlanSchema, PlannerError, RawPlanSchema, TaskDesignSchema, formatIssues, } from './schema.js';
/** 树阶段单次调用上限：树是主产出，值得多等一会儿。 */
const TREE_TIMEOUT_CAP = 180_000;
/** 树阶段重试的最小剩余预算：连这点时间都不够就别再试了，直接给可行动的报错。 */
const TREE_MIN_BUDGET = 5_000;
/** 单张子导图的调用上限。 */
const DESIGN_TIMEOUT_CAP = 120_000;
/** 剩余预算低于这个值就不再调模型，直接推导。 */
const DESIGN_MIN_BUDGET = 5_000;
/** 严格 JSON 解析：只做「BOM / 思考块 / 整段代码围栏」三种精确清理，绝不按花括号切片。 */
export function parseStrictJson(text) {
    let s = String(text ?? '').trim();
    if (s === '')
        throw new PlannerError('EMPTY_OUTPUT', '模型没有返回任何内容');
    if (s.charCodeAt(0) === 0xFEFF)
        s = s.slice(1).trim();
    s = stripThinkBlocks(s);
    s = stripWholeCodeFence(s);
    if (s === '')
        throw new PlannerError('EMPTY_OUTPUT', '模型只返回了空白或围栏，没有 JSON');
    try {
        return JSON.parse(s);
    }
    catch (e) {
        throw new PlannerError('BAD_JSON', '模型输出不是合法 JSON：' + (e instanceof Error ? e.message : String(e)));
    }
}
/** 去掉开头的 <think>/<thinking>/<reasoning> 思考块（部分模型会先吐思考内容）。 */
function stripThinkBlocks(s) {
    let out = s;
    for (let i = 0; i < 3; i++) {
        const m = /^\s*<(think|thinking|reasoning)>[\s\S]*?<\/\1>\s*/i.exec(out);
        if (m == null)
            break;
        out = out.slice(m[0].length);
    }
    return out.trim();
}
/** 去掉**整段** Markdown 代码围栏（必须首尾包住全文；不做局部切片，避免切错）。 */
function stripWholeCodeFence(s) {
    const m = /^\s*```[A-Za-z0-9_-]*\s*\r?\n([\s\S]*?)\r?\n?\s*```\s*$/.exec(s);
    if (m == null)
        return s;
    return m[1].trim();
}
/** 语义校验：deps 合法、id 唯一、无环、每 task 至少 1 条 acceptance。 */
export function validateSemantics(plan) {
    const errs = [];
    const moduleIds = new Set();
    const taskIds = new Set();
    const taskById = new Map();
    for (const m of plan.modules) {
        if (moduleIds.has(m.id))
            errs.push('模块 id 重复: ' + m.id);
        moduleIds.add(m.id);
        for (const t of m.tasks) {
            if (taskIds.has(t.id))
                errs.push('任务 id 重复: ' + t.id);
            taskIds.add(t.id);
            taskById.set(t.id, t);
        }
    }
    for (const m of plan.modules) {
        for (const t of m.tasks) {
            if (t.acceptance.length === 0)
                errs.push('任务 ' + t.id + ' 没有验收标准（acceptance 至少 1 条）');
            for (const d of t.deps) {
                if (d === t.id) {
                    errs.push('任务 ' + t.id + ' 依赖自己');
                    continue;
                }
                if (moduleIds.has(d)) {
                    errs.push('任务 ' + t.id + ' 的依赖 ' + d + ' 是模块 id，deps 只能引用任务 id');
                    continue;
                }
                if (!taskIds.has(d))
                    errs.push('任务 ' + t.id + ' 的依赖悬空: ' + d + '（不存在这个任务 id）');
            }
        }
    }
    const cyc = depCycleOf(taskById);
    if (cyc != null)
        errs.push('任务依赖成环: ' + cyc.join(' -> '));
    return errs;
}
/** 任务依赖图判环（跨模块一并算）。 */
export function depCycleOf(taskById) {
    const color = new Map();
    const stack = [];
    let cycle = null;
    const dfs = (id) => {
        if (cycle != null || color.get(id) === 2)
            return;
        color.set(id, 1);
        stack.push(id);
        for (const d of taskById.get(id)?.deps ?? []) {
            if (!taskById.has(d))
                continue;
            if (color.get(d) === 1) {
                cycle = stack.slice(stack.indexOf(d)).concat([d]);
                return;
            }
            if (!color.has(d))
                dfs(d);
            if (cycle != null)
                return;
        }
        stack.pop();
        color.set(id, 2);
    };
    for (const id of taskById.keys())
        dfs(id);
    return cycle;
}
/**
 * 把草稿（key 版）翻译成**树**（id 版，design 还没有）：
 * 统一编号 m-1.. / t-1..，deps 映射到 task id。
 */
export function buildPlan(raw) {
    const errors = [];
    const keyToId = new Map();
    const moduleKeys = new Set();
    let taskSeq = 0;
    const modules = [];
    for (const m of raw.modules) {
        if (moduleKeys.has(m.key))
            errors.push('模块 key 重复: ' + m.key);
        moduleKeys.add(m.key);
        const tasks = [];
        for (const t of m.tasks) {
            taskSeq += 1;
            const tid = 't-' + String(taskSeq);
            if (keyToId.has(t.key))
                errors.push('任务 key 重复: ' + t.key + '（key 必须全局唯一）');
            keyToId.set(t.key, tid);
            tasks.push({
                id: tid,
                title: t.title,
                acceptance: t.acceptance,
                scope: t.scope,
                deps: [],
                priority: t.priority,
                // 模型顺手给了导图就留着（第二段会跳过它）；没给就等第二段补。
                design: t.design,
            });
        }
        modules.push({ id: 'm-' + String(modules.length + 1), title: m.title, tasks });
    }
    let mi = 0;
    for (const m of raw.modules) {
        const target = modules[mi];
        mi += 1;
        let ti = 0;
        for (const t of m.tasks) {
            const tt = target.tasks[ti];
            ti += 1;
            const deps = [];
            for (const d of t.deps) {
                if (moduleKeys.has(d) && !keyToId.has(d)) {
                    errors.push('任务 ' + tt.id + ' 的依赖 ' + d + ' 指向模块 key，deps 只能引用任务 key');
                    continue;
                }
                const mapped = keyToId.get(d);
                if (mapped == null) {
                    errors.push('任务 ' + tt.id + ' 的依赖悬空: ' + d + '（不存在这个任务 key）');
                    continue;
                }
                deps.push(mapped);
            }
            tt.deps = deps;
        }
    }
    const plan = { plan: raw.plan, modules };
    errors.push(...validateSemantics(plan));
    return { plan, errors };
}
/** 收集目标仓库的可选上下文（失败不阻断，退化成「无上下文」）。 */
export function collectRepoContext(project) {
    try {
        if (project === '' || !existsSync(project)) {
            return '（目标仓库路径不存在：' + project + '；仅按一句话规划）';
        }
        const parts = [];
        const pkgFile = join(project, 'package.json');
        if (existsSync(pkgFile)) {
            try {
                const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
                const name = typeof pkg.name === 'string' ? pkg.name : '';
                const desc = typeof pkg.description === 'string' ? pkg.description : '';
                const head = [name, desc].filter((x) => x !== '').join(' — ');
                if (head !== '')
                    parts.push('package.json：' + head);
            }
            catch { /* package.json 坏掉就当没有 */ }
        }
        const entries = readdirSync(project, { withFileTypes: true })
            .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules')
            .map((e) => (e.isDirectory() ? e.name + '/' : e.name))
            .slice(0, 40);
        if (entries.length > 0)
            parts.push('顶层条目：' + entries.join(', '));
        const readme = ['README.md', 'readme.md', 'README.MD', 'README.rst']
            .map((n) => join(project, n))
            .find((p) => existsSync(p));
        if (readme != null) {
            const text = readFileSync(readme, 'utf8').replace(/\s+/g, ' ').trim().slice(0, 800);
            if (text !== '')
                parts.push('README 摘要：' + text);
        }
        if (parts.length === 0)
            return '（目标仓库是空的或不可读：' + project + '；仅按一句话规划）';
        return parts.join('\n');
    }
    catch {
        return '（目标仓库上下文读取失败：' + project + '；仅按一句话规划）';
    }
}
/**
 * 生成计划：先出树（模型 → 严格解析 → schema 校验 → 语义校验 → 回灌错误重试），
 * 再逐任务补子导图（单张失败只降级），最后过一遍最终 schema。
 * 树失败不降级：抛 PlannerError（code=MODEL_OUTPUT_INVALID），且报错要人能行动。
 */
export async function generatePlan(opts) {
    const sentence = String(opts.sentence ?? '').trim();
    if (sentence === '')
        throw new PlannerError('EMPTY_SENTENCE', '一句话不能为空');
    const maxAttempts = Math.max(1, Math.min(5, Math.floor(Number(opts.maxAttempts ?? 3))));
    // 总预算：树 + 全部子导图共用。面板给 180s、内部只给 90s 本身就是不一致，故默认给到 240s。
    const totalBudget = Math.max(10_000, Number(opts.timeoutMs ?? 240_000));
    const maxTokens = Number(opts.maxTokens ?? 12_000);
    const deadline = Date.now() + totalBudget;
    let feedback = '';
    let lastProblem = '';
    // lastReason：最后一次失败的**中文分类**（超时 / 响应流中断 / JSON 不合法 / 结构不合规 …），
    // 给最终报错用——人要看的是「哪一类问题」，不是上游那句天书。
    let lastReason = '模型调用失败';
    let attemptsMade = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const remaining = deadline - Date.now();
        if (remaining < TREE_MIN_BUDGET) {
            // 预算烧完了：不再开新的一次调用（开下去就是超支 = 超时），直接给可行动的报错。
            break;
        }
        attemptsMade += 1;
        const user = buildUserPrompt({ sentence, context: opts.context, feedback, includeDesigns: false });
        let text;
        try {
            text = await callModel(opts.ctx, {
                system: PLAN_SYSTEM_PROMPT,
                user,
                signal: opts.signal,
                // 这一次只能用剩下的钱：树先拿大头（上限 180s），重试只吃剩余预算，绝不超支。
                timeoutMs: Math.max(1_000, Math.min(remaining, TREE_TIMEOUT_CAP)),
                maxTokens,
                provider: opts.provider,
                model: opts.model,
            });
        }
        catch (e) {
            // 配置类错误（没有模型、宿主没有 llm）与调用方取消不重试：重试只会再撞一遍同一个错。
            const code = e instanceof PlannerError ? e.code : 'MODEL_ERROR';
            if (code === 'NO_MODEL' || code === 'NO_LLM' || code === 'CANCELLED')
                throw e;
            // 超时 / 响应流中断 / 上游报错都重试：这类故障常常是**瞬时**的（模型慢、网络抖），
            // 再试一次常常就过了——这正是两次真实失败（90s abort、流无 stop reason）暴露的缺口。
            lastReason = treeFailureReason(code);
            // 只留中文分类，不留上游原话（例如 "This operation was aborted"）：那是天书，甩给人没用。
            lastProblem = '第 ' + String(attempt) + ' 次调用模型失败（' + lastReason + '）';
            feedback = [
                lastProblem,
                '请重试一次，并把输出尽量精简（模块 2~3 个、每个模块 1~3 个任务）。',
            ].join('\n');
            continue;
        }
        let raw;
        try {
            raw = parseStrictJson(text);
        }
        catch (e) {
            lastReason = 'JSON 不合法';
            lastProblem = '第 ' + String(attempt) + ' 次输出不是合法 JSON：' + (e instanceof Error ? e.message : String(e));
            feedback = [
                lastProblem,
                '请只输出一个 JSON 对象：不要 Markdown 代码围栏，不要 JSON 之外的任何文字。',
            ].join('\n');
            continue;
        }
        const parsed = RawPlanSchema.safeParse(raw);
        if (!parsed.success) {
            const issues = formatIssues(parsed.error);
            lastReason = '结构不合规';
            lastProblem = '第 ' + String(attempt) + ' 次输出不符合结构要求：\n- ' + issues.join('\n- ');
            feedback = [
                lastProblem,
                '请严格按下面规定的字段名重新输出（一个字段不多、一个不少，层级只能是 plan → modules → tasks）：',
            ].join('\n');
            continue;
        }
        const built = buildPlan(parsed.data);
        if (built.errors.length > 0) {
            lastReason = '依赖关系不对';
            lastProblem = '第 ' + String(attempt) + ' 次输出的依赖关系有问题：\n- ' + built.errors.join('\n- ');
            feedback = [
                lastProblem,
                '请修正 key 与 deps 后重新输出：deps 只能引用同一个 JSON 里出现过的任务 key，不能自依赖、不能成环。',
            ].join('\n');
            continue;
        }
        // 树先落地，子导图随后逐个生成：一次输出整棵大树会把模型的流打断。
        return await withDesigns(built.plan, opts, deadline);
    }
    // 树**不降级**：宁可明确失败，也不要编一棵计划树出来（本仓原则：绝不编数据冒充模型结果）。
    throw treeFailure(totalBudget, attemptsMade, lastReason, lastProblem);
}
/** 树阶段失败的中文分类（最终报错用；不把上游原话甩给人）。 */
function treeFailureReason(code) {
    if (code === 'MODEL_TIMEOUT')
        return '超时';
    if (code === 'ABORTED')
        return '响应流中断';
    if (code === 'MODEL_ERROR')
        return '模型调用失败';
    if (code === 'BAD_JSON')
        return 'JSON 不合法';
    if (code === 'EMPTY_OUTPUT')
        return '模型没有返回内容';
    return '模型调用失败';
}
/**
 * 树阶段的最终报错：要人看得懂、能动手。
 *
 * 带实际尝试次数与最后一次失败原因（超时 / 响应流中断 / JSON 不合法 / 结构不合规），
 * 再给三条下一步；不甩 "This operation was aborted" 这种天书。
 */
function treeFailure(seconds, attempts, reason, detail) {
    const lines = [
        '模型在 ' + String(Math.round(seconds / 1000)) + ' 秒内没有给出计划树（尝试 ' + String(attempts) + ' 次，最后一次：' + reason + '）。',
        '可以：① 再点一次生成（预算会重置）；② 把需求拆小一点再试；③ 在设置里换一个更快的模型。',
    ];
    if (detail !== '')
        lines.push('最后一次的详细问题：' + detail);
    return new PlannerError('MODEL_OUTPUT_INVALID', lines.join('\n'));
}
/**
 * 逐个任务生成子导图。
 *
 * 每个任务单独一次调用：输出小、流不容易断；某一张失败只降级（按验收标准与范围推导），
 * 不让整棵计划作废——一张导图画不出来，不等于计划不对。
 */
async function withDesigns(tree, opts, deadline) {
    const context = String(opts.context ?? '');
    const wantModel = opts.designs !== false;
    for (const module of tree.modules) {
        for (const task of module.tasks) {
            if (task.design != null)
                continue;
            const left = deadline - Date.now();
            if (!wantModel || left < DESIGN_MIN_BUDGET) {
                // 预算不够（或调用方不要模型导图）：按任务自身推导，绝不编造 scope 之外的文件。
                task.design = derivedDesign(task);
                continue;
            }
            task.design = await oneDesign(tree, task, opts, context, deadline);
        }
    }
    // 最终形状要求每个任务都有导图（PlanTaskSchema.design 必填）——这里再兜一次。
    const final = PlanSchema.safeParse(tree);
    if (!final.success) {
        throw new PlannerError('MODEL_OUTPUT_INVALID', '生成的计划没能通过最终校验：\n- ' + formatIssues(final.error).join('\n- '));
    }
    return final.data;
}
/** 一个任务的子导图：两次尝试，都失败就按任务本身推导一份（并说明是推导的）。 */
async function oneDesign(tree, task, opts, context, deadline) {
    let feedback = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
        const left = deadline - Date.now();
        if (left < DESIGN_MIN_BUDGET)
            break;
        try {
            const text = await callModel(opts.ctx, {
                system: DESIGN_SYSTEM_PROMPT,
                user: buildDesignPrompt({
                    goal: tree.plan.goal,
                    title: task.title,
                    acceptance: task.acceptance,
                    scope: task.scope,
                    context,
                    feedback,
                }),
                signal: opts.signal,
                timeoutMs: Math.max(1_000, Math.min(left, DESIGN_TIMEOUT_CAP)),
                maxTokens: 2000,
                provider: opts.provider,
                model: opts.model,
            });
            const raw = parseStrictJson(text);
            const parsed = TaskDesignSchema.safeParse(raw);
            if (parsed.success)
                return parsed.data;
            feedback = '上一次输出的子导图不符合要求：\n- ' + formatIssues(parsed.error).join('\n- ');
        }
        catch (e) {
            // 调用方取消要往外抛：取消不是「这张导图画不出来」，别拿降级糊弄过去。
            if (e instanceof PlannerError && e.code === 'CANCELLED')
                throw e;
            feedback = '上一次调用失败：' + (e instanceof Error ? e.message : String(e));
        }
    }
    return derivedDesign(task);
}
/**
 * 推导出来的子导图。
 *
 * 只用任务自己已有的信息（验收标准与范围），不编造模型没有说过的东西，并写明这是推导的。
 */
export function derivedDesign(task) {
    const acceptance = task.acceptance.length > 0 ? task.acceptance : ['完成任务：' + task.title];
    return {
        summary: '（自动推导：模型这次没给出子导图，按验收标准与改动范围推导）' + task.title,
        steps: acceptance.map((a) => '完成并验证：' + a),
        // 只用任务自己的 scope：不编造范围之外的文件（编了会把 L4 漂移核对带偏）。
        files: task.scope.slice(),
        risks: [],
        tests: acceptance.slice(),
    };
}
