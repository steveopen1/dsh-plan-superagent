import type { BoardNode } from '../board/schema.js';
import { type Trigger } from './contract.js';
/** 来源 kind id：同时是 Trigger.source、thread key 前缀与策略段名。 */
export declare const PLANBOARD_SOURCE = "planboard";
/** 线程 id：`<project>:<taskId>`（引擎拼上来源前缀后是 `planboard:<project>:<taskId>`）。 */
export declare function planboardThreadId(project: string, taskId: string): string;
/**
 * Trigger id：sha256 前 32 位（与引擎 `core/ids.ts` 的 `key()` 同构）。
 * 带上 project 是为了多项目共存时互不撞车；同一 (project, task) 永远得到同一个 id。
 */
export declare function planboardTriggerId(project: string, taskId: string, attempt?: number): string;
/** 子导图文件的位置：绝对路径给 worker 读，相对路径进简报。 */
export declare function designFilePaths(project: string, designsDir: string, taskId: string): {
    absolute: string;
    relative: string;
};
export interface DesignSummary {
    title?: string;
    bullets: string[];
}
/**
 * 把任意形状的设计 JSON 压成「要点摘要」：按常见标题键收集短文本，限深限条。
 * 格式未固定（各人写的子导图结构可能不同），所以这里只做保守的字符串抽取，
 * 解析失败一律当作「没有摘要」，绝不抛错打断派单。
 */
export declare function summarizeDesign(raw: unknown, limit?: number): DesignSummary;
/** 读取子导图；文件不存在或不是合法 JSON 时返回 undefined（不打断派单）。 */
export declare function readDesignSummary(absolutePath: string): DesignSummary | undefined;
/** 简报需要的全部输入。 */
export interface PlanboardBriefInput {
    project: string;
    task: BoardNode;
    boardVersion: number;
    planName?: string;
    goal?: string;
    /** 子导图：绝对路径给 worker，简报里给相对路径。 */
    design: {
        absolute: string;
        relative: string;
    };
    /** 子导图摘要；文件缺失时为 undefined。 */
    summary?: DesignSummary;
}
/** 任务简报正文：标题 + 验收 + 范围 + 子导图指针（不塞整个 JSON）。 */
export declare function planboardBrief(input: PlanboardBriefInput): string;
/** 造一个 Trigger 所需的输入。 */
export interface PlanboardTriggerInput extends PlanboardBriefInput {
    /** 发起人 id（板上没有人，这个 id 来自来源配置）。 */
    actor: string;
    /** 事件时间；缺省为现在。 */
    at?: string;
    /** 第几次派单尝试（0 = 首次）；重试时 Trigger id 变化，工单才能重建。 */
    attempt?: number;
}
/**
 * 板任务 → Trigger。
 *
 * - `actor` 用配置里的发起人 id；`human: true`（板上的条目是人的意图）；
 * - `addressed: 'direct'`：这条触发器就是直接派给智能体的活，不是旁听的群消息；
 * - `meta` 带上 taskId / project / 板版本号，以及子导图路径（worker 与桥都靠它对齐）。
 */
export declare function planboardTrigger(input: PlanboardTriggerInput): Trigger;
