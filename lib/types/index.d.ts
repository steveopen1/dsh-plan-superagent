/**
 * dsh-plan-superagent —— 合并入口：板（plan-board）+ 桥（superagent 派单）+ 规划器（plan_generate）。
 *
 * 一句话 → 任务树/思维导图 → 每张卡自动变成工单 → superagent 实现并回写证据，全在一个插件里闭环。
 *
 * 三半互不拖累（坏一半不影响另外两半）：
 *   - 板（src/board/**，vendored 自 hoyyang/dsh-plan-board v0.2.2，BSD-3-Clause）：
 *     自带嵌套 inject(['webServer','tools'])，只有 web profile 才挂路由与板工具。
 *   - 桥（src/bridge/**）：依赖执行引擎 dsh-superagent 提供的 'orchestrator' 服务。
 *     引擎是**可选依赖**，没装时桥静默禁用（不抛、不影响板）。
 *   - 规划器（src/planner/**）：向 tools 服务注册 plan_generate 工具。
 *
 * 生命周期：apply 依次装三半，返回统一 disposer（卸载即净：路由注销、工具注销、事件监听摘除）。
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "dsh-plan-superagent";
/**
 * 只列**一定存在**的服务。
 *
 * 'tools' 是 DSH 核心服务（@deepseek-ai/dsh-tools），任何 profile 都有，所以列它安全。
 *
 * 'orchestrator'（执行引擎 dsh-superagent 的服务）**绝不能**出现在这里：cordis 只在 inject 里
 * 的服务全部到位时才加载插件，引擎没装 → 整个插件永不激活（板与 plan_generate 一起废掉）。
 * 桥自己用嵌套 ctx.inject(['orchestrator'], cb) 挂载：引擎在就挂、不在就跳过。
 */
export declare const inject: string[];
/**
 * 解析后的插件配置以服务形式挂在 ctx 上，供桥/规划器读取：`ctx.get('planSuperagentConfig')`。
 * （两者的导出契约分别只收 ctx / tools，收不到 config，故走 ctx 传递。）
 */
export declare const CONFIG_SERVICE = "planSuperagentConfig";
export interface Config {
    /** 板的 project 目录（项目根绝对路径）。 */
    project: string;
    /** 桥向执行引擎发起工单时的 actor id。 */
    bridgeActorId: string;
    /** 子导图目录（相对 project）。 */
    subDesignDir: string;
    /** 板注册表目录。 */
    stateDir: string;
    /** L5 漂移阻断。 */
    blockOnDrift: boolean;
    /** L7 工具观测。 */
    observeTools: boolean;
    /** L7 越界拦截。 */
    enforceScope: boolean;
}
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    project: z<string, string, "defined">;
    bridgeActorId: z<string, string, "defined">;
    subDesignDir: z<string, string, "defined">;
    stateDir: z<string, string, "defined">;
    blockOnDrift: z<boolean, boolean, "defined">;
    observeTools: z<boolean, boolean, "defined">;
    enforceScope: z<boolean, boolean, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    project: z<string, string, "defined">;
    bridgeActorId: z<string, string, "defined">;
    subDesignDir: z<string, string, "defined">;
    stateDir: z<string, string, "defined">;
    blockOnDrift: z<boolean, boolean, "defined">;
    observeTools: z<boolean, boolean, "defined">;
    enforceScope: z<boolean, boolean, "defined">;
}>>, "plain">;
export declare function apply(ctx: Context, config?: Partial<Config>): () => void;
