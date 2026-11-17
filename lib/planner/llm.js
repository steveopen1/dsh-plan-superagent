/**
 * 宿主模型调用封装。
 *
 * 姿势照抄 mind-canvas/src/llm.js（research/mindmap.md 踩坑点 5）：
 *   ctx.get('agentDefaultModel')?.currentSelection?.()  → { provider, model }
 *   ctx.get('llm').prepareCall({ provider, model, maxTokens }, signal) → call.stream(...)
 * 不读环境变量里的 API key（宿主已经配好 provider/model）；
 * 没有可用模型时**明确报错**，绝不编数据冒充模型结果。
 *
 * 与 mind-canvas 的差别：这里不做 extractJson 暴力切片（正文带花括号会切错），
 * JSON 解析在 generate.ts 里用严格 JSON.parse + zod 校验完成。
 */
import { randomUUID } from 'node:crypto';
import { PlannerError } from './schema.js';
/** 插件在会话之外调模型，自己带一个会话标识。 */
export const PLANNER_SESSION_ID = 'dsh-plan-superagent-' + randomUUID();
/** 取宿主当前默认模型；取不到就是 null（上层必须显式报错，不许编数据）。 */
export function currentSelection(ctx) {
    try {
        const host = ctx;
        const service = host.get('agentDefaultModel');
        const selection = service?.currentSelection?.();
        if (selection == null)
            return null;
        const provider = typeof selection.provider === 'string' ? selection.provider : '';
        const model = typeof selection.model === 'string' ? selection.model : '';
        if (provider === '' || model === '')
            return null;
        return { provider, model };
    }
    catch {
        return null;
    }
}
/** 调一次模型，返回完整文本。 */
export async function callModel(ctx, req) {
    const selection = currentSelection(ctx);
    if (selection == null) {
        throw new PlannerError('NO_MODEL', '没有可用模型：先在设置里选一个助手模型（不编数据，生成失败）');
    }
    const host = ctx;
    const llm = host.get('llm');
    if (llm == null || typeof llm.prepareCall !== 'function') {
        throw new PlannerError('NO_LLM', '宿主 llm 服务不可用：ctx.get("llm") 没拿到可用的 prepareCall');
    }
    // 超时与取消：外部 signal + 内部超时合成一个 signal 交给 prepareCall/stream。
    const controller = new AbortController();
    let timedOut = false;
    const external = req.signal;
    const onExternalAbort = () => { controller.abort(external?.reason); };
    if (external != null) {
        if (external.aborted)
            controller.abort(external.reason);
        else
            external.addEventListener('abort', onExternalAbort, { once: true });
    }
    const timeoutMs = Number(req.timeoutMs ?? 0);
    const timer = timeoutMs > 0
        ? setTimeout(() => { timedOut = true; controller.abort(new Error('模型调用超时')); }, timeoutMs)
        : null;
    try {
        const call = await llm.prepareCall({ provider: selection.provider, model: selection.model, maxTokens: req.maxTokens ?? 12_000 }, controller.signal);
        let text = '';
        const stream = call.stream({
            ...(call.config ?? {}),
            system: req.system,
            messages: [{ role: 'user', content: [{ type: 'text', text: req.user }], source: { kind: 'dsh-plan-superagent' } }],
            sessionId: req.sessionId ?? PLANNER_SESSION_ID,
            signal: controller.signal,
        });
        for await (const chunk of stream) {
            if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
                text += chunk.text;
            }
            else if (chunk.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) {
                throw new PlannerError('MODEL_ERROR', chunk.reason?.failure?.message ?? '模型调用失败');
            }
        }
        if (timedOut)
            throw new PlannerError('MODEL_TIMEOUT', '模型调用超时（' + String(timeoutMs) + 'ms）');
        if (external?.aborted === true)
            throw new PlannerError('ABORTED', '模型调用已取消');
        return text;
    }
    catch (e) {
        if (e instanceof PlannerError)
            throw e;
        if (timedOut)
            throw new PlannerError('MODEL_TIMEOUT', '模型调用超时（' + String(timeoutMs) + 'ms）');
        throw new PlannerError('MODEL_ERROR', e instanceof Error ? e.message : String(e));
    }
    finally {
        if (timer != null)
            clearTimeout(timer);
        if (external != null)
            external.removeEventListener('abort', onExternalAbort);
    }
}
//# sourceMappingURL=llm.js.map