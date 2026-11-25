import type { EditOp } from '../board/schema.js';
import type { EventBroadcast, StoreOpts } from '../board/store.js';
import type { Plan } from './schema.js';
/** note 里的指针前缀（消费方据此定位子导图文件）。 */
export declare const DESIGN_POINTER_PREFIX = "design-graph: ";
/** 子导图目录（相对项目根，'/' 分隔）。 */
export declare const DESIGN_DIR = ".plan-board/designs";
export interface ApplyPlanOptions {
    plan: Plan;
    /** 项目根目录绝对路径。 */
    project: string;
    /** 板存储选项（blockOnDrift 等）。 */
    opts: StoreOpts;
    /** 操作者（审计留痕）。 */
    actor: string;
    /** 送审理由（默认用计划目标）。 */
    reason?: string;
    /** 子导图目录（相对项目根），缺省 '.plan-board/designs'。 */
    designDir?: string;
    onEvent?: EventBroadcast;
}
export interface DesignFileRef {
    taskId: string;
    /** 绝对路径。 */
    path: string;
    /** 相对项目根的指针（写进 note）。 */
    relative: string;
}
/** 子导图来源统计：几张是模型写的，几张是推导的。 */
export interface DesignQuality {
    model: number;
    derived: number;
    total: number;
}
export interface ApplyPlanResult {
    ok: true;
    project: string;
    /** 待批项 id（人在面板用它批准/驳回）。 */
    approvalId: string;
    /** 恒为 true：结构变更一律待批，不直接落板。 */
    pendingApproval: true;
    /** 本次是否新建了板子文件。 */
    boardCreated: boolean;
    /** 送审后的板版本号。 */
    version: number;
    moduleCount: number;
    taskCount: number;
    /** 送审的 op 条数。 */
    opCount: number;
    reason: string;
    designFiles: DesignFileRef[];
    /** 子导图来源统计（model = 模型写的，derived = 推导的）。 */
    designQuality: DesignQuality;
}
/** 把相对目录（'/' 分隔）转成绝对路径（Windows 友好，不手拼分隔符）。 */
export declare function designDirAbs(project: string, designDir: string): string;
/** 子导图相对路径（写进 task.note 的指针）。 */
export declare function designRelativePath(taskId: string, designDir?: string): string;
/** 子导图绝对路径。 */
export declare function designPath(project: string, taskId: string, designDir?: string): string;
/**
 * 编号避让：板上已有 m-3 / t-7 时，新计划从 m-4 / t-8 接着编，
 * 避免送审的 add_node 在批准那一刻撞 DUP_ID（approve 是一次性 applyEditOps，撞了整批失败）。
 */
export declare function remapIds(plan: Plan, existing: ReadonlySet<string>): {
    plan: Plan;
    idMap: Map<string, string>;
};
/** 组装送审的 ops：init_board（仅新板）→ 每个 module 的 add_node → 每个 task 的 add_node → note 指针 update_node。 */
export declare function buildOps(plan: Plan, includeInit: boolean, designDir?: string): EditOp[];
/** 落盘子导图（原子写：tmp → rename）。 */
export declare function writeDesigns(project: string, plan: Plan, designDir?: string): DesignFileRef[];
/**
 * 写板：结构变更进待批队列等人审（板结构在批准前不变）。
 * 返回待批项 id 与子导图落盘清单。
 */
export declare function applyPlanToBoard(options: ApplyPlanOptions): ApplyPlanResult;
/** 读回某个 task 的子导图文件（消费方用；文件不存在返回 null）。 */
export declare function readDesign(project: string, taskId: string, designDir?: string): unknown;
/** 列出某项目下已有的子导图文件（调试/面板用）。 */
export declare function listDesigns(project: string, designDir?: string): string[];
