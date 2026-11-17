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
}
/** 系统提示词：只输出 JSON。 */
export declare const PLAN_SYSTEM_PROMPT: string;
/** 组装 user 提示词。 */
export declare function buildUserPrompt(input: PromptInput): string;
