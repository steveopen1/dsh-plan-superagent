/**
 * 「一句话 → 计划树」生成器。
 *
 * 流程：调模型 → 严格 JSON.parse（**不做 extractJson 暴力切片**）→ zod 真 schema 校验
 *      → 语义校验（deps 不悬空/不自依赖/不成环、id 全局唯一、每 task 至少 1 条 acceptance）
 *      → 不合格就把错误清单回灌给模型重试（最多 3 次）→ 仍不合格就抛具名错误。
 *
 * id 由本模块统一产出：module `m-1..`、task `t-1..`（跨模块全局唯一）；
 * 模型只给草稿 key，deps 在这里翻译成最终 task id。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { callModel } from './llm.js';
import { PLAN_SYSTEM_PROMPT, buildUserPrompt } from './prompt.js';
import { PlannerError, RawPlanSchema, formatIssues, } from './schema.js';
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
/** 把草稿（key 版）翻译成最终计划（id 版）：统一编号 m-1.. / t-1..，deps 映射到 task id。 */
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
 * 生成计划：模型 → 严格解析 → schema 校验 → 语义校验 →（不合格则回灌错误重试）。
 * 全部失败时抛 PlannerError（code=MODEL_OUTPUT_INVALID），不返回半成品。
 */
export async function generatePlan(opts) {
    const sentence = String(opts.sentence ?? '').trim();
    if (sentence === '')
        throw new PlannerError('EMPTY_SENTENCE', '一句话不能为空');
    const maxAttempts = Math.max(1, Math.min(5, Math.floor(Number(opts.maxAttempts ?? 3))));
    const timeoutMs = Number(opts.timeoutMs ?? 90_000);
    const maxTokens = Number(opts.maxTokens ?? 12_000);
    let feedback = '';
    let lastProblem = '';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const user = buildUserPrompt({ sentence, context: opts.context, feedback });
        const text = await callModel(opts.ctx, {
            system: PLAN_SYSTEM_PROMPT,
            user,
            signal: opts.signal,
            timeoutMs,
            maxTokens,
        });
        let raw;
        try {
            raw = parseStrictJson(text);
        }
        catch (e) {
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
            lastProblem = '第 ' + String(attempt) + ' 次输出不符合结构要求：\n- ' + issues.join('\n- ');
            feedback = [
                lastProblem,
                '请严格按下面规定的字段名重新输出（一个字段不多、一个不少，层级只能是 plan → modules → tasks）：',
            ].join('\n');
            continue;
        }
        const built = buildPlan(parsed.data);
        if (built.errors.length > 0) {
            lastProblem = '第 ' + String(attempt) + ' 次输出的依赖关系有问题：\n- ' + built.errors.join('\n- ');
            feedback = [
                lastProblem,
                '请修正 key 与 deps 后重新输出：deps 只能引用同一个 JSON 里出现过的任务 key，不能自依赖、不能成环。',
            ].join('\n');
            continue;
        }
        return built.plan;
    }
    throw new PlannerError('MODEL_OUTPUT_INVALID', '模型在 ' + String(maxAttempts) + ' 次尝试内都没给出合法计划。最后一次问题：\n' + lastProblem);
}
//# sourceMappingURL=generate.js.map