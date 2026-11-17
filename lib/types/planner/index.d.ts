/**
 * 规划器（src/planner/**）对外出口。
 *
 * 职责：一句话 → 计划树（plan → modules → tasks）+ 每个 task 的功能实现子导图 → 写板（人审门）。
 *
 * 装配（src/index.ts）：registerPlanner(ctx.tools)
 *   - 宿主 cordis ctx 从 tools 服务反查（cordis Service 自带 ctx），模型从 ctx.get('llm') 走；
 *   - 宿主配置从 ctx.get('planSuperagentConfig') 读（project / stateDir / blockOnDrift / subDesignDir）。
 */
export { registerPlanner, registerPlannerTools, resolveProject, readHostConfig, defaultStateDir, PLAN_GENERATE_TOOL, CONFIG_SERVICE, } from './tool.js';
export type { PlannerHostConfig, PlannerToolOptions } from './tool.js';
export { generatePlan, collectRepoContext, parseStrictJson, validateSemantics, buildPlan, depCycleOf, } from './generate.js';
export type { GenerateOptions } from './generate.js';
export { applyPlanToBoard, buildOps, remapIds, writeDesigns, readDesign, listDesigns, designPath, designRelativePath, designDirAbs, DESIGN_DIR, DESIGN_POINTER_PREFIX, } from './apply.js';
export type { ApplyPlanOptions, ApplyPlanResult, DesignFileRef } from './apply.js';
export { PLAN_SYSTEM_PROMPT, buildUserPrompt } from './prompt.js';
export type { PromptInput } from './prompt.js';
export { callModel, currentSelection, PLANNER_SESSION_ID } from './llm.js';
export type { CallModelRequest, LlmCall, LlmChunk, LlmSelection, LlmService, PlannerContext } from './llm.js';
export * from './schema.js';
