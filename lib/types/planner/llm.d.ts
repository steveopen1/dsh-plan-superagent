/** 插件在会话之外调模型，自己带一个会话标识。 */
export declare const PLANNER_SESSION_ID: string;
export interface LlmSelection {
    provider: string;
    model: string;
}
export interface LlmChunk {
    type?: string;
    text?: string;
    reason?: {
        kind?: string;
        failure?: {
            message?: string;
        };
    };
}
export interface LlmCall {
    config?: Record<string, unknown>;
    stream(payload: Record<string, unknown>): AsyncIterable<LlmChunk>;
}
export interface LlmService {
    prepareCall(options: {
        provider: string;
        model: string;
        maxTokens?: number;
    }, signal?: AbortSignal): Promise<LlmCall>;
}
/** 宿主上下文的最小心脏契约（cordis Context 兼容：ctx.get('llm') / ctx.get('agentDefaultModel')）。 */
export interface PlannerContext {
    get(key: string): unknown;
}
export interface CallModelRequest {
    system: string;
    user: string;
    signal?: AbortSignal;
    /** 单次调用超时（毫秒）；0 = 不限时。 */
    timeoutMs?: number;
    maxTokens?: number;
    sessionId?: string;
}
/** 取宿主当前默认模型；取不到就是 null（上层必须显式报错，不许编数据）。 */
export declare function currentSelection(ctx: unknown): LlmSelection | null;
/** 调一次模型，返回完整文本。 */
export declare function callModel(ctx: unknown, req: CallModelRequest): Promise<string>;
