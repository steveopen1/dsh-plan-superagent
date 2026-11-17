import { type SourceKind, type SourcePolicyPart } from './contract.js';
/** 来源 kind id（注册名、策略段名、thread key 前缀都是它）。 */
export declare const PLANBOARD_KIND = "planboard";
/** 健康条目名。 */
export declare const PLANBOARD_HEALTH = "planboard";
/** 默认发起人 id。板上没有「人」，所以发起人是一个配置项。 */
export declare const PLANBOARD_ACTOR_DEFAULT = "planboard";
/** 子导图默认目录（相对项目根目录）。 */
export declare const PLANBOARD_DESIGNS_DIR_DEFAULT = ".plan-board/designs";
/** 准入表里的行 id。 */
export declare const PLANBOARD_ROW = "planboard";
/** 桥写板时用的 store 选项：漂移只报警报，不冻结板子（冻结由人决定）。 */
export declare const BRIDGE_STORE_OPTS: {
    blockOnDrift: boolean;
};
/** 来源配置。 */
export type PlanboardConfig = {
    /** 计划板所在项目根目录（绝对路径）。 */
    project: string;
    /** 发起人 id：写在触发器的 `actor` 上，并需要出现在策略的允许名单里。 */
    actor: string;
    /** 子导图目录（相对 project 或绝对路径）。 */
    designsDir: string;
    /** 轮询间隔（秒）。 */
    pollSeconds: number;
};
/** 默认项目目录：与板工具的默认一致（`<DSH_HOME>/dsh-plan-board/default`）。 */
export declare function defaultPlanboardProject(): string;
/** 来源配置的 schema。 */
export declare const planboardConfigSchema: import("./contract.js").SchemaLike<import("./contract.js").ShapeOut<{
    project: import("./contract.js").SchemaLike<string>;
    actor: import("./contract.js").SchemaLike<string>;
    designsDir: import("./contract.js").SchemaLike<string>;
    pollSeconds: import("./contract.js").SchemaLike<number>;
}>>;
/** 来源策略段：允许的发送者。默认与 `actor` 的默认值一致，开箱即用。 */
export declare const planboardPolicySchema: import("./contract.js").SchemaLike<import("./contract.js").ShapeOut<{
    allowed: import("./contract.js").SchemaLike<import("./contract.js").ShapeOut<{
        id: import("./contract.js").SchemaLike<string>;
        name: import("./contract.js").SchemaLike<string | undefined>;
    }>[]>;
}>>;
type PlanboardPolicy = {
    allowed: {
        id: string;
        name?: string;
    }[];
};
/** 策略段定义（引擎把它渲染成 Eval → On each Source 的表单）。 */
export declare const planboardPolicyPart: SourcePolicyPart<Record<string, unknown> & PlanboardPolicy>;
/**
 * 计划板来源 kind。
 *
 * 注册到引擎后，它出现在 Sources 设置与 Eval → On each Source 里；
 * 桥的轮询循环（`watch.ts`）用 `ctx.receive(trigger)` 把任务喂给它。
 */
export declare const planboardKind: SourceKind<PlanboardConfig>;
export {};
