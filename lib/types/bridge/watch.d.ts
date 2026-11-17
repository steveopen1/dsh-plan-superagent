import { type Board, type BoardNode } from '../board/schema.js';
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
    /** 收单（结果写回板）的时刻；用来判断人是不是在收单之后又动过这个任务。 */
    settledAt?: string;
    /** 触发器所在 thread 的完整 key；用来在工单已经结束时找回工单 id。 */
    threadKey?: string;
    /** 本次尝试结束的时刻（工单终结或派发丢失时记下）；用来判断人是否已重新启用该任务。 */
    endedAt?: string;
}
/** 桥私有的 KV 键（引擎的 KV 归它自己，外部来源插件自己声明键）。 */
export declare const KV_DISPATCHED: import("./contract.js").Key<Record<string, DispatchRecord>>;
export declare const KV_SETTLED: import("./contract.js").Key<string[]>;
/** reconcile 台账：任务 id → 第一次发现「板上有它、引擎里没工单」的时刻（epoch ms）。 */
export declare const KV_RECONCILE: import("./contract.js").Key<Record<string, number>>;
/**
 * reconcile 的宽限期：板上的 ready 任务在引擎里找不到在途工单，且持续这么久才报。
 * 刚派发时工单还没落库是正常的，不给宽限期会天天误报。
 */
export declare const RECONCILE_GRACE_MS: number;
/** 轮询循环的选项。 */
export interface WatchOptions {
    /** 配置缺省时的轮询间隔（秒）。 */
    defaultPollSeconds?: number;
    /** The board registry's directory (where the panel records the projects it opened). */
    stateDir?: string;
}
/** 桥写板用的 actor 标记（写进事件流，审计可追）。 */
export declare const BRIDGE_ACTOR = "superagent:bridge";
/**
 * 轮询循环的入口。`ctx.ready` 之前不读板；来源被关掉时只报 paused。
 * 连续三次失败才报 error（一次网络/文件抖动不该叫醒人）。
 */
export declare function watchPlanboard(ctx: SourceContext, signal: AbortSignal, options?: WatchOptions): Promise<void>;
/** 把一轮的统计压成一行（健康条目展示用）。 */
export declare function describePoll(result: PollResult): string;
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
    /** 板上处于 doing 的任务数（L1 锁被占着时 > 0）。 */
    locked: number;
    /** 板上有就绪任务、引擎里却找不到在途工单，且已过宽限期的任务数。 */
    unmatched: number;
}
/**
 * 板上正在做的任务（板的发号语义 L1：同一时刻只允许一个 doing）。
 * 判定口径与板自己的 `plan_next` 完全一致，否则两个门对「当前任务」的说法会分叉。
 */
export declare function doingTasks(board: Board): BoardNode[];
/**
 * Mark attempts whose ticket never showed up as finished.
 *
 * The ticket is created asynchronously after the Trigger is evaluated; when the evaluation filtered
 * the Trigger (policy) or the router never accepted it, no ticket ever appears and the task would stay
 * `doing` forever. After the grace period the attempt is closed, so a human can re-arm the task.
 *
 * @returns the ids of the attempts that were closed.
 */
export declare function expireStaleAttempts(board: Board, dispatched: Record<string, DispatchRecord>, now?: number): string[];
/**
 * The project the bridge works on: the source setting, else the project the panel opened last.
 *
 * The panel and the bridge must not disagree about which project they are on, so an empty
 * setting means "follow the panel" — the panel records every project it opens in the board
 * registry, and the most recent one is the one the person is looking at.
 */
export declare function resolveProject(config: PlanboardConfig, stateDir?: string): string;
export declare function pollPlanboard(ctx: SourceContext, config: PlanboardConfig, signal: AbortSignal, options?: WatchOptions): Promise<PollResult>;
/**
 * reconcile：板上有 ready 任务，引擎里却没有对应的在途工单。
 *
 * 这是「派发没生效」的信号（派单抛错、策略不放行、板与引擎看的是不同的任务……）。
 * 有在途工单、或锁被占着（等 L1 锁是正常的）都不算异常，重新计时。
 */
export declare function reconcileUnmatched(board: Board, dispatched: Record<string, DispatchRecord>, ready: BoardNode[], seen: Record<string, number>, now: number): number;
/**
 * 工单结束后的证据清单：工单号与结局、worker 的报告摘要（测试/CI/PR 链接通常在里面）、
 * 执行目录。摘要按行拆开，板面（ROADMAP 镜像）一行一条，读起来像人写的。
 */
export declare function evidenceOf(ticket: Ticket): string[];
