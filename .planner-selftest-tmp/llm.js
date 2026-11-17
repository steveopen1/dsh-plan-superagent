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
 *
 * 超时为什么不能只靠 abort：provider 未必理会 abort signal —— 光发信号不等于这次调用会结束，
 * 流可能一直挂着（实测 Anthropic 兼容流会这样）。所以超时/取消必须**主动打断等待**：
 * 把「prepareCall + 读流」放进一个 promise，用 race 兜住它。
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
/**
 * 用超时与取消去打断一次等待。
 *
 * 超时到点时同时 abort 控制器（让 provider 停止生成，省 token），
 * 并**直接 reject**——不等 provider 会不会理会 abort。
 */
function raceWithLimits(work, timeoutMs, external, controller) {
    const guards = [];
    let timer = null;
    let onAbort = null;
    if (timeoutMs > 0) {
        guards.push(new Promise((_, reject) => {
            timer = setTimeout(() => {
                controller.abort(new Error('模型调用超时'));
                reject(new PlannerError('MODEL_TIMEOUT', '模型调用超时（' + String(timeoutMs) + 'ms）'));
            }, timeoutMs);
        }));
    }
    if (external != null) {
        guards.push(new Promise((_, reject) => {
            const handler = () => reject(new PlannerError('ABORTED', '模型调用已取消'));
            onAbort = handler;
            if (external.aborted)
                handler();
            else
                external.addEventListener('abort', handler, { once: true });
        }));
    }
    if (guards.length === 0)
        return work;
    return Promise.race([work, ...guards]).finally(() => {
        if (timer != null)
            clearTimeout(timer);
        if (onAbort != null && external != null)
            external.removeEventListener('abort', onAbort);
    });
}
/** 调一次模型，返回完整文本。 */
export async function callModel(ctx, req) {
    // An explicit provider/model wins over the host default: the default model's stream can break on
    // long structured output, and a caller may know a better one.
    const selection = (req.provider != null && req.model != null) ? { provider: req.provider, model: req.model } : currentSelection(ctx);
    if (selection == null) {
        throw new PlannerError('NO_MODEL', '没有可用模型：先在设置里选一个助手模型（不编数据，生成失败）');
    }
    const host = ctx;
    const llm = host.get('llm');
    if (llm == null || typeof llm.prepareCall !== 'function') {
        throw new PlannerError('NO_LLM', '宿主 llm 服务不可用：ctx.get("llm") 没拿到可用的 prepareCall');
    }
    // 取消：外部 signal 合成一个控制器信号，交给 prepareCall/stream。
    const controller = new AbortController();
    const external = req.signal;
    const onExternalAbort = () => { controller.abort(external?.reason); };
    if (external != null) {
        if (external.aborted)
            controller.abort(external.reason);
        else
            external.addEventListener('abort', onExternalAbort, { once: true });
    }
    const timeoutMs = Number(req.timeoutMs ?? 0);
    // 干活的这段单独成一个 promise，外面用 race 兜住「流挂死」。
    const work = (async () => {
        const call = await llm.prepareCall({ provider: selection.provider, model: selection.model, maxTokens: req.maxTokens ?? 12_000 }, controller.signal);
        let text = '';
        for await (const chunk of call.stream({
            ...(call.config ?? {}),
            system: req.system,
            messages: [{ role: 'user', content: [{ type: 'text', text: req.user }], source: { kind: 'dsh-plan-superagent' } }],
            sessionId: req.sessionId ?? PLANNER_SESSION_ID,
            signal: controller.signal,
        })) {
            if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
                text += chunk.text;
            }
            else if (chunk.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) {
                throw new PlannerError('MODEL_ERROR', chunk.reason?.failure?.message ?? '模型调用失败');
            }
        }
        return text;
    })();
    // race 输了之后这条流可能自己报错：先挂一个空处理器，避免未处理拒绝把进程带崩。
    work.catch(() => { });
    try {
        return await raceWithLimits(work, timeoutMs, external, controller);
    }
    catch (e) {
        if (e instanceof PlannerError)
            throw e;
        throw new PlannerError('MODEL_ERROR', e instanceof Error ? e.message : String(e));
    }
    finally {
        if (external != null)
            external.removeEventListener('abort', onExternalAbort);
    }
}
