import { type SourceContext, type Ticket } from './contract.js';
import { type PlanboardConfig } from './source.js';
/** 一个任务的一次派单尝试。 */
export interface DispatchRecord {
    /** 第几次尝试（0 = 首次）；重试时 Trigger id 变化，工单才能重建。 */
    attempt: number;
    /** 本次尝试的 Trigger id。 */
    triggerId: string;
    /** 对应的工单 id（引擎评估完成后才有）。 */
    ticketId?: string;
    /** 收单（回写）时刻；用来判断人是不是在收单之后又动过这个任务。 */
    settledAt?: string;
}
/** 桥私有的 KV 键（引擎的 KV 归它自己，外部来源插件自己声明键）。 */
export declare const KV_DISPATCHED: import("./contract.js").Key<Record<string, DispatchRecord>>;
export declare const KV_SETTLED: import("./contract.js").Key<string[]>;
/** 轮询循环的选项。 */
export interface WatchOptions {
    /** 配置缺省时的轮询间隔（秒）。 */
    defaultPollSeconds?: number;
}
/** 桥写板用的 actor 标记（写进事件流，审计可追）。 */
export declare const BRIDGE_ACTOR = "superagent:bridge";
/**
 * 轮询循环的入口。`ctx.ready` 之前不读板；来源被关掉时只报 paused。
 * 连续三次失败才报 error（一次网络/文件抖动不该叫醒人）。
 */
export declare function watchPlanboard(ctx: SourceContext, signal: AbortSignal, options?: WatchOptions): Promise<void>;
/** 一轮轮询的统计。 */
export interface PollResult {
    /** 板上的就绪任务数。 */
    ready: number;
    /** 本轮新派出的工单数。 */
    dispatched: number;
    /** 本轮回写了证据的任务数。 */
    settled: number;
    /** 被引擎按范围过滤掉的触发器数。 */
    filtered: number;
    /** 已派单但还没有工单的任务数（多半是策略没放行发起人，或评估还在排队）。 */
    pending: number;
    /** 派单失败（引擎抛错）的任务数。 */
    failed: number;
}
/** 跑一轮：派单 + 收单。返回本轮统计（供健康条目展示）。 */
export declare function pollPlanboard(ctx: SourceContext, config: PlanboardConfig, signal: AbortSignal): Promise<PollResult>;
/**
 * 工单结束后的证据清单：工单号与结局、worker 的报告摘要（测试/CI/PR 链接通常在里面）、
 * 执行目录。摘要按行拆开，板面（ROADMAP 镜像）一行一条，读起来像人写的。
 */
export declare function evidenceOf(ticket: Ticket): string[];
