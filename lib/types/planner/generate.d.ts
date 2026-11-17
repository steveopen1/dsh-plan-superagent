import { Plan, PlanTask, RawPlan } from './schema.js';
export interface GenerateOptions {
    /** 宿主上下文（cordis Context）：提供 'llm' 与 'agentDefaultModel' 两个服务。 */
    ctx: unknown;
    /** 用户那一句需求。 */
    sentence: string;
    /** 目标仓库的可选上下文。 */
    context?: string;
    signal?: AbortSignal;
    /** 单次模型调用超时（毫秒），默认 90s。 */
    timeoutMs?: number;
    /** 最大尝试次数（首次 + 重试），默认 3。 */
    maxAttempts?: number;
    /** 单次生成的最大 token，默认 12000。 */
    maxTokens?: number;
}
/** 严格 JSON 解析：只做「BOM / 思考块 / 整段代码围栏」三种精确清理，绝不按花括号切片。 */
export declare function parseStrictJson(text: string): unknown;
/** 语义校验：deps 合法、id 唯一、无环、每 task 至少 1 条 acceptance。 */
export declare function validateSemantics(plan: Plan): string[];
/** 任务依赖图判环（跨模块一并算）。 */
export declare function depCycleOf(taskById: Map<string, PlanTask>): string[] | null;
/** 把草稿（key 版）翻译成最终计划（id 版）：统一编号 m-1.. / t-1..，deps 映射到 task id。 */
export declare function buildPlan(raw: RawPlan): {
    plan: Plan;
    errors: string[];
};
/** 收集目标仓库的可选上下文（失败不阻断，退化成「无上下文」）。 */
export declare function collectRepoContext(project: string): string;
/**
 * 生成计划：模型 → 严格解析 → schema 校验 → 语义校验 →（不合格则回灌错误重试）。
 * 全部失败时抛 PlannerError（code=MODEL_OUTPUT_INVALID），不返回半成品。
 */
export declare function generatePlan(opts: GenerateOptions): Promise<Plan>;
