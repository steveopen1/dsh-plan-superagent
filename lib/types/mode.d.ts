/**
 * 计划板模式：按会话记住「开发类需求是否先走计划板」。
 *
 * 开关在原生对话框旁（客户端），状态放在服务端：会话重建、插件重启都不丢。
 * 切换时把一条指令注入那个会话，agent 由此知道「先把需求变成板上的计划树，人批准后再动手」——
 * 这样输入面只有一个（原生对话框），计划板只是计划的落地面。
 */
import type { Context } from '@deepseek-ai/cordis';
import { type ContextFormed } from '@deepseek-ai/dsh-llm';
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        'dsh-plan-superagent': {
            kind: 'dsh-plan-superagent';
        } & ContextFormed;
    }
}
/** 计划板模式：'plan' = 开发类需求先走计划板；'direct' = 按常规处理。 */
export type PlanMode = 'plan' | 'direct';
export interface ModeRecord {
    mode: PlanMode;
    at: string;
}
/** 模式状态：按会话 id 记在板的注册表目录旁（重启不丢）。 */
export declare class ModeStore {
    private readonly dir;
    constructor(dir: string);
    private file;
    all(): Record<string, ModeRecord>;
    get(sessionId: string): ModeRecord | undefined;
    set(sessionId: string, mode: PlanMode): ModeRecord;
}
/** 切换模式时注入会话的指令。 */
export declare function modeDirective(mode: PlanMode, project: string): string;
/**
 * 把模式指令注入会话。
 *
 * 用 inject（进历史、不唤醒 agent）：下一轮它就在上下文里；若 agent 正在跑，这一轮不会被打断。
 */
export declare function announceMode(ctx: Context, sessionId: string, mode: PlanMode, project: string): Promise<boolean>;
