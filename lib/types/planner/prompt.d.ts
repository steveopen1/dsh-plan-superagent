/**
 * 中文结构化提示词：一句话 + 可选仓库上下文 → 严格符合 schema 的 JSON。
 *
 * 关键纪律（research/mindmap.md 踩坑点 3/6）：
 * - 层级写死三层（plan → modules → tasks），并明确「task 里不许再有子任务」；
 * - 明确「不要输出 Markdown 代码围栏」（模型的 ```json 包裹会让严格 JSON.parse 直接失败）；
 * - key 只做草稿编号（最终 m-1/t-1 由生成器统一分配），deps 只引用任务 key；
 * - 给出结构示例，降低首轮不合规率（不合规就靠重试循环兜底）。
 */
export interface PromptInput {
    /** 用户那一句需求。 */
    sentence: string;
    /** 目标仓库的可选上下文（目录结构 / package.json / README 摘要）。 */
    context?: string;
    /** 上一轮的校验错误（重试时追加，让模型自己改）。 */
    feedback?: string;
    /**
     * 是否在这一轮里就要子导图。
     *
     * 一次输出整棵树加全部子导图的 JSON 太大，模型的长流会断（实测 Anthropic 兼容流
     * 「stream ended without a stop reason」）。默认分开：先出树，再逐任务出子导图。
     */
    includeDesigns?: boolean;
}
/** 系统提示词：只输出 JSON。 */
/**
 * 系统提示词：只输出 JSON。
 *
 * 这一轮**只出树**（plan → modules → tasks）：子导图由后面逐任务的独立调用补。
 * 一次输出整棵树加全部子导图会把模型的流打断（实测 Anthropic 兼容流半路断）。
 */
export declare const PLAN_SYSTEM_PROMPT: string;
/** 组装 user 提示词。 */
export declare function buildUserPrompt(input: PromptInput): string;
/** 为单个任务写子导图时的系统提示词。 */
export declare const DESIGN_SYSTEM_PROMPT: string;
export interface DesignPromptInput {
    /** 计划目标（让子导图与整体一致）。 */
    goal: string;
    /** 任务标题。 */
    title: string;
    /** 验收标准（子导图要能把它变成可执行的步骤）。 */
    acceptance: string[];
    /** 允许改动的范围。 */
    scope: string[];
    /** 目标仓库上下文（可选）。 */
    context?: string;
    /** 上一轮子导图的错误（重试时追加，让模型自己改）。 */
    feedback?: string;
}
/** 单个任务的子导图提示词：只要五个字段的 JSON。 */
export declare function buildDesignPrompt(input: DesignPromptInput): string;
