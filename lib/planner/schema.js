/**
 * 「一句话 → 任务树 + 每任务子导图」的数据契约（zod 真 schema，不是提示词里的口头约定）。
 *
 * 三层硬约束：plan（1 个）→ modules[] → tasks[]。modules 里只能有 task，task 里不许再出现子任务
 * —— 这条由 `.strict()` 兜底：模型多写一个 `subtasks` 字段，校验当场失败并进入重试，
 * 而不是被静默吞掉（research/mindmap.md 踩坑点 1/2/4：不要用 markdown 大纲解析任务树，
 * 也不要暴力切 JSON；模型 JSON 必须「真 schema 约束 + 校验 + 失败重试」）。
 *
 * id 规则：最终 id 由生成器统一产出（module `m-1..`、task `t-1..`，跨模块全局唯一）。
 * 模型只提供草稿用的 `key`（RawPlanSchema 会把模型误写的 `id` 归一成 `key`），
 * 最终 Plan 里的 id 一律由生成器分配，deps 只能引用已存在的 task id。
 */
import { z } from 'zod';
/** 规划器统一错误（带 code，便于工具层转成结构化 JSON）。 */
export class PlannerError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'PlannerError';
    }
}
/** 每个任务的「功能实现子导图」机器形态：够画图（结构化），也够执行（步骤/文件/风险/验证）。 */
export const TaskDesignSchema = z.object({
    summary: z.string().min(1),
    steps: z.array(z.string().min(1)).min(1),
    files: z.array(z.string().min(1)),
    risks: z.array(z.string().min(1)),
    tests: z.array(z.string().min(1)).min(1),
}).strict();
/** 推导导图的标记：出现在 summary 开头，表示这张不是模型写的（而是按验收标准与范围推导的）。 */
export const DERIVED_MARKER = '（自动推导';
/** 最终计划里的 task：id 由生成器统一分配（`t-1..`），deps 只引用 task id。 */
export const PlanTaskSchema = z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    acceptance: z.array(z.string().min(1)).min(1),
    scope: z.array(z.string().min(1)),
    deps: z.array(z.string().min(1)),
    priority: z.number().int().min(1).max(5).optional(),
    design: TaskDesignSchema,
}).strict();
export const PlanModuleSchema = z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    tasks: z.array(PlanTaskSchema).min(1),
}).strict();
/** 最终计划形状：plan → modules[] → tasks[]，严格三层。 */
export const PlanSchema = z.object({
    plan: z.object({
        name: z.string().min(1),
        goal: z.string().min(1),
    }).strict(),
    modules: z.array(PlanModuleSchema).min(1),
}).strict();
/**
 * 树阶段的中间形状：任务还没有 design（第二段再补）。
 *
 * 为什么单独一种形状：最终计划里每个 task 都必须带导图（PlanTaskSchema.design 必填），
 * 但树先落地、导图后补，中间态必须允许 design 缺省——否则第一段的产出根本过不了类型。
 */
export const TreeTaskSchema = z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    acceptance: z.array(z.string().min(1)).min(1),
    scope: z.array(z.string().min(1)),
    deps: z.array(z.string().min(1)),
    priority: z.number().int().min(1).max(5).optional(),
    design: TaskDesignSchema.optional(),
}).strict();
export const TreeModuleSchema = z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    tasks: z.array(TreeTaskSchema).min(1),
}).strict();
export const TreeSchema = z.object({
    plan: z.object({ name: z.string().min(1), goal: z.string().min(1) }).strict(),
    modules: z.array(TreeModuleSchema).min(1),
}).strict();
/** 草稿 key：模型侧用的临时编号（模块 m1/m2、任务 t1/t2…），全局唯一。 */
export const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
export const KeySchema = z.string().regex(KEY_PATTERN);
function isRecord(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}
/**
 * 把模型可能写的 `id` 归一成草稿用的 `key`。
 * 只做「改名」，绝不做「按花括号暴力切片」——后者会在正文里出现花括号时切错（mindmap.md 踩坑点 2）。
 */
function normalizeKey(v) {
    if (!isRecord(v))
        return v;
    const out = {};
    for (const k of Object.keys(v)) {
        if (k === 'id')
            continue;
        out[k] = v[k];
    }
    if (typeof out.key !== 'string' && typeof v.id === 'string')
        out.key = v.id;
    return out;
}
/** 模型侧 task（草稿 key 版）。 */
export const RawTaskSchema = z.preprocess(normalizeKey, z.object({
    key: KeySchema,
    title: z.string().min(1),
    acceptance: z.array(z.string().min(1)).min(1),
    scope: z.array(z.string().min(1)),
    deps: z.array(z.string().min(1)),
    priority: z.number().int().min(1).max(5).optional(),
    // 可省略：树与子导图分两次生成（一次输出整棵大树会把模型的流打断）。
    design: TaskDesignSchema.optional(),
}).strict());
/** 模型侧 module（草稿 key 版）：里面只有 tasks，没有第四层。 */
export const RawModuleSchema = z.preprocess(normalizeKey, z.object({
    key: KeySchema,
    title: z.string().min(1),
    tasks: z.array(RawTaskSchema).min(1),
}).strict());
/** 模型侧整体形状：顶层只有 plan 与 modules。 */
export const RawPlanSchema = z.object({
    plan: z.object({
        name: z.string().min(1),
        goal: z.string().min(1),
    }).strict(),
    modules: z.array(RawModuleSchema).min(1),
}).strict();
/** 把 zod 报错压成给模型看的具名清单（重试时原样回灌）。 */
export function formatIssues(err) {
    return err.issues.map((i) => {
        const p = i.path.length > 0 ? i.path.map((x) => String(x)).join('.') : '(根)';
        const hint = i.code === 'unrecognized_keys'
            ? '（出现了 schema 不允许的字段：只能用规定的字段名，不许加 subtasks/children 之类）'
            : i.code === 'invalid_type'
                ? '（字段类型不对：数组必须是字符串数组，数字必须是整数）'
                : i.code === 'too_small'
                    ? '（数组/字符串太短：必需项不能为空）'
                    : i.code === 'invalid_string' || i.code === 'invalid_string_regex' || i.code === 'invalid_format'
                        ? '（字符串格式不对：key 只能字母开头，字母数字下划线连字符）'
                        : '';
        return p + ': ' + i.message + hint;
    });
}
//# sourceMappingURL=schema.js.map