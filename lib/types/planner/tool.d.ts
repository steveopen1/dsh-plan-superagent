import type { EventBroadcast, StoreOpts } from '../board/store.js';
export declare const PLAN_GENERATE_TOOL = "plan_generate";
/** 宿主挂配置的服务名（src/index.ts 用 ctx.provide 挂上）。 */
export declare const CONFIG_SERVICE = "planSuperagentConfig";
/** 宿主配置（从 ctx.get('planSuperagentConfig') 读到的字段子集）。 */
export interface PlannerHostConfig {
    /** 工具参数缺 project 时用的默认项目目录（绝对路径）。 */
    project?: string;
    /** 板注册表目录。 */
    stateDir?: string;
    /** L5 漂移阻断。 */
    blockOnDrift?: boolean;
    /** 子导图目录（相对 project）。 */
    subDesignDir?: string;
}
export interface PlannerToolOptions {
    /** 工具参数缺 project 时用的默认项目目录。 */
    defaultProject?: string;
    /** 子导图目录（相对 project），缺省 '.plan-board/designs'。 */
    designDir?: string;
    /** 板事件广播（面板实时流）。 */
    onEvent?: EventBroadcast;
}
/** 默认注册表目录（与板那半一致：<DSH_HOME>/dsh-plan-board）。 */
export declare function defaultStateDir(): string;
/**
 * project 解析：必须是绝对路径；
 * 缺省顺序 = 工具参数 project → 宿主配置的 project → <stateDir>/default。
 */
/**
 * The project the panel last opened, from the board registry.
 *
 * The panel, the bridge and the planner must all work on the same project, so they read the
 * same registry: the person picks it once, in the panel.
 */
export declare function latestProject(stateDir: string): string;
export declare function resolveProject(p: unknown, stateDir: string, defaultProject?: string): string;
/** 从宿主配置服务里读配置（读不到就退化成空配置，不抛）。 */
export declare function readHostConfig(ctx: unknown): PlannerHostConfig;
/** 显式装配：注册 plan_generate，返回注销函数。 */
export declare function registerPlannerTools(tools: {
    register(tool: unknown): (() => void) | void;
}, ctx: unknown, stateDir: string, opts: StoreOpts, options?: PlannerToolOptions): () => void;
/**
 * 入口（src/index.ts 调用）：registerPlanner(ctx.tools)。
 * 宿主 ctx 从 tools 服务反查，配置从 ctx.get('planSuperagentConfig') 读；
 * 拿不到 ctx 时工具仍可注册，但调模型会明确报 NO_MODEL（不编数据）。
 */
export declare function registerPlanner(tools: unknown, hostCtx?: unknown, config?: PlannerHostConfig): () => void;
