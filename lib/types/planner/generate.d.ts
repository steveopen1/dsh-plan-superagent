import { Plan, RawPlan, TaskDesign, TreePlan } from './schema.js';
export interface GenerateOptions {
    /** 宿主上下文（cordis Context）：提供 'llm' 与 'agentDefaultModel' 两个服务。 */
    ctx: unknown;
    /** 用户那一句需求。 */
    sentence: string;
    /** 目标仓库的可选上下文。 */
    context?: string;
    signal?: AbortSignal;
    /** 整段生成的**总预算**（毫秒）：树 + 全部子导图共用；默认 420s。 */
    timeoutMs?: number;
    /** 最大尝试次数（首次 + 重试），默认 3。 */
    maxAttempts?: number;
    /** 单次生成的最大 token，默认 12000。 */
    maxTokens?: number;
    /** 可选的模型指定（provider + model）；缺省用宿主默认模型。 */
    provider?: string;
    model?: string;
    /**
     * 是否为每个任务生成子导图（默认 true）。
     * false = 不花模型调用，直接按任务已有的验收标准与范围推导一份。
     */
    designs?: boolean;
    /** 子导图并发数（默认 3）。宿主 llm 服务会排队，保守些。 */
    designConcurrency?: number;
}
/** 严格 JSON 解析：只做「BOM / 思考块 / 整段代码围栏」三种精确清理，绝不按花括号切片。 */
export declare function parseStrictJson(text: string): unknown;
/** 语义校验要看的最小结构（树与最终计划都满足，故按结构而不是按 Plan 类型收）。 */
export interface SemanticPlan {
    modules: Array<{
        id: string;
        tasks: Array<{
            id: string;
            title: string;
            acceptance: string[];
            deps: string[];
        }>;
    }>;
}
/** 语义校验：deps 合法、id 唯一、无环、每 task 至少 1 条 acceptance。 */
export declare function validateSemantics(plan: SemanticPlan): string[];
/** 任务依赖图判环（跨模块一并算）。 */
export declare function depCycleOf(taskById: Map<string, {
    id: string;
    deps: string[];
}>): string[] | null;
/**
 * 把草稿（key 版）翻译成**树**（id 版，design 还没有）：
 * 统一编号 m-1.. / t-1..，deps 映射到 task id。
 */
export declare function buildPlan(raw: RawPlan): {
    plan: TreePlan;
    errors: string[];
};
/** 收集目标仓库的可选上下文（失败不阻断，退化成「无上下文」）。 */
export declare function collectRepoContext(project: string): string;
/**
 * 生成计划：先出树（模型 → 严格解析 → schema 校验 → 语义校验 → 回灌错误重试），
 * 再逐任务补子导图（单张失败只降级），最后过一遍最终 schema。
 * 树失败不降级：抛 PlannerError（code=MODEL_OUTPUT_INVALID），且报错要人能行动。
 */
export declare function generatePlan(opts: GenerateOptions): Promise<Plan>;
/**
 * 推导出来的子导图。
 *
 * 只用任务自己已有的信息（验收标准与范围），不编造模型没有说过的东西，并写明这是推导的。
 */
export declare function derivedDesign(task: {
    title: string;
    acceptance: string[];
    scope: string[];
}): TaskDesign;
