import { MessageId, freezeMessage } from '@deepseek-ai/dsh-llm';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
/** 模式状态：按会话 id 记在板的注册表目录旁（重启不丢）。 */
export class ModeStore {
    dir;
    constructor(dir) {
        this.dir = dir;
    }
    file() {
        return join(this.dir, 'modes.json');
    }
    all() {
        try {
            if (!existsSync(this.file()))
                return {};
            return JSON.parse(readFileSync(this.file(), 'utf8'));
        }
        catch {
            return {};
        }
    }
    get(sessionId) {
        return this.all()[sessionId];
    }
    set(sessionId, mode) {
        const all = this.all();
        const record = { mode, at: new Date().toISOString() };
        all[sessionId] = record;
        try {
            mkdirSync(this.dir, { recursive: true });
            writeFileSync(this.file(), JSON.stringify(all, null, 2));
        }
        catch { /* 状态存不下去不算故障：这一轮仍然生效 */ }
        return record;
    }
}
/** 切换模式时注入会话的指令。 */
export function modeDirective(mode, project) {
    const where = project === '' ? '（尚未选择项目）' : project;
    if (mode === 'plan') {
        return [
            '【计划板模式 · 已开启】',
            '本会话的开发类需求一律先走计划板，不要直接开始改代码。',
            '请调用 plan_generate：把你理解的需求变成「计划 → 模块 → 任务」三层结构，每个任务带一份功能实现子导图（步骤/涉及文件/风险/测试），并连同验收标准与改动范围一起提交待批。',
            '人批准后，再按板上就绪的任务逐个动手。',
            '当前板所在项目：' + where,
        ].join('\n');
    }
    return [
        '【计划板模式 · 已关闭】',
        '按常规方式处理需求：可以直接分析并改代码。需要先做规划时，仍可调用 plan_generate 生成计划树。',
    ].join('\n');
}
/**
 * 把模式指令注入会话。
 *
 * 用 inject（进历史、不唤醒 agent）：下一轮它就在上下文里；若 agent 正在跑，这一轮不会被打断。
 */
export async function announceMode(ctx, sessionId, mode, project) {
    const controller = ctx.sessionController;
    if (controller == null)
        return false;
    const resolved = await controller.resolveAgent(sessionId);
    if ('error' in resolved)
        return false;
    const id = MessageId('dsh-plan-superagent:mode:' + sessionId + ':' + mode + ':' + Date.now());
    const message = freezeMessage({
        id,
        role: 'user',
        content: [{ type: 'text', text: modeDirective(mode, project) }],
        source: { kind: 'dsh-plan-superagent', form: 'notice', summary: '计划板模式' },
    });
    resolved.agent.inject(message);
    return true;
}
//# sourceMappingURL=mode.js.map