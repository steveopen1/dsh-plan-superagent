/**
 * plan_generate 工具：一句话 → 任务树 + 每任务子导图 → 写板（结构变更等人审）。
 *
 * 装配：
 *   - registerPlanner(ctx.tools)            —— 入口（src/index.ts 用这个）
 *     宿主 ctx 从 tools 服务上取（cordis Service 自带 ctx），配置从 ctx.get('planSuperagentConfig') 读。
 *   - registerPlannerTools(tools, ctx, stateDir, opts, options) —— 显式装配（自测/嵌入用）
 *
 * 人审门在 apply.ts：结构变更只进待批队列，板结构在人批准前不变。
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { isAbsolutePath } from '../board/pathutil.js'
import type { EventBroadcast, StoreOpts } from '../board/store.js'
import { applyPlanToBoard, DESIGN_DIR } from './apply.js'
import { collectRepoContext, generatePlan } from './generate.js'
import { PlannerError } from './schema.js'

export const PLAN_GENERATE_TOOL = 'plan_generate'

/** 宿主挂配置的服务名（src/index.ts 用 ctx.provide 挂上）。 */
export const CONFIG_SERVICE = 'planSuperagentConfig'

// 本地定义 JsonValue：dsh 0.1.5 起 dsh-tools 不再 re-export 该类型（改为从 dsh-util-values 引入），
// 继续 import 会让 host tsc 门禁变红（TS2614）；本地定义等价且不受 dsh 版本漂移影响。
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
type JsonObj = Record<string, JsonValue>

type ToolCtx = { agent?: { id: string }; signal?: AbortSignal }

/** 宿主配置（从 ctx.get('planSuperagentConfig') 读到的字段子集）。 */
export interface PlannerHostConfig {
  /** 工具参数缺 project 时用的默认项目目录（绝对路径）。 */
  project?: string
  /** 板注册表目录。 */
  stateDir?: string
  /** L5 漂移阻断。 */
  blockOnDrift?: boolean
  /** 子导图目录（相对 project）。 */
  subDesignDir?: string
}

export interface PlannerToolOptions {
  /** 工具参数缺 project 时用的默认项目目录。 */
  defaultProject?: string
  /** 子导图目录（相对 project），缺省 '.plan-board/designs'。 */
  designDir?: string
  /** 板事件广播（面板实时流）。 */
  onEvent?: EventBroadcast
}

function toJson(x: unknown): JsonObj {
  return JSON.parse(JSON.stringify(x)) as JsonObj
}

function errJson(e: unknown): JsonObj {
  if (e instanceof PlannerError) return { ok: false, code: e.code, error: e.message }
  return { ok: false, code: 'TOOL_FAILED', error: e instanceof Error ? e.message : String(e) }
}

function actorOf(ctx: ToolCtx | undefined): string {
  return 'agent:' + (ctx?.agent?.id ?? 'unknown')
}

/** 默认注册表目录（与板那半一致：<DSH_HOME>/dsh-plan-board）。 */
export function defaultStateDir(): string {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(dshHome, 'dsh-plan-board')
}

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
export function latestProject(stateDir: string): string {
  try {
    const file = join(stateDir, 'projects.json')
    if (!existsSync(file)) return ''
    const all = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { at?: string }>
    let best = ''
    let bestAt = ''
    for (const [project, entry] of Object.entries(all)) {
      const at = entry?.at ?? ''
      if (project !== '' && at > bestAt) { best = project; bestAt = at }
    }
    return best
  } catch {
    return ''
  }
}

export function resolveProject(p: unknown, stateDir: string, defaultProject = ''): string {
  if (typeof p === 'string' && p.trim() !== '') {
    if (!isAbsolutePath(p)) throw new PlannerError('BAD_PROJECT', 'project 必须是项目根目录绝对路径')
    return p
  }
  if (defaultProject !== '' && isAbsolutePath(defaultProject)) return defaultProject
  const latest = latestProject(stateDir)
  if (latest !== '') return latest
  return join(stateDir, 'default')
}

/** 从宿主配置服务里读配置（读不到就退化成空配置，不抛）。 */
export function readHostConfig(ctx: unknown): PlannerHostConfig {
  try {
    const host = ctx as { get?: (key: string) => unknown }
    if (typeof host.get !== 'function') return {}
    const cfg = host.get(CONFIG_SERVICE) as Record<string, unknown> | undefined
    if (cfg == null || typeof cfg !== 'object') return {}
    const out: PlannerHostConfig = {}
    if (typeof cfg.project === 'string') out.project = cfg.project
    if (typeof cfg.stateDir === 'string') out.stateDir = cfg.stateDir
    if (typeof cfg.blockOnDrift === 'boolean') out.blockOnDrift = cfg.blockOnDrift
    if (typeof cfg.subDesignDir === 'string') out.subDesignDir = cfg.subDesignDir
    return out
  } catch {
    return {}
  }
}

/** 从 tools 服务上反查宿主 cordis ctx（cordis Service 自带 ctx 字段）。 */
function hostCtxOf(tools: unknown): unknown {
  const t = tools as { ctx?: unknown; get?: unknown }
  if (typeof t?.get === 'function') return tools
  const c = t?.ctx
  if (c != null && typeof (c as { get?: unknown }).get === 'function') return c
  return undefined
}

/** 显式装配：注册 plan_generate，返回注销函数。 */
export function registerPlannerTools(
  tools: { register(tool: unknown): (() => void) | void },
  ctx: unknown,
  stateDir: string,
  opts: StoreOpts,
  options: PlannerToolOptions = {},
): () => void {
  const designDir = options.designDir ?? DESIGN_DIR
  const defaultProject = options.defaultProject ?? ''
  const disposer = tools.register(defineTool({
    name: PLAN_GENERATE_TOOL,
    description: 'Turn one sentence into a plan board: generates a three-layer plan (plan -> modules -> tasks) plus a per-task implementation sub-graph, then proposes it to the plan board as a pending approval (structural changes require human approval in the panel before they land). Returns the pending approval id and the design-graph file paths.',
    parameters: {
      sentence: { type: 'string', required: true, description: '用户的一句话需求（中文/英文皆可），例如「给插件加一个把任务导出成 Markdown 的命令」' },
      project: { type: 'string', description: '项目根目录绝对路径。缺省 = 宿主配置的 project，再缺省 = ~/.dsh/dsh-plan-board/default' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
    execute: async (args, toolCtx: ToolCtx) => {
      try {
        const a = args as { sentence?: unknown; project?: unknown }
        const sentence = String(a.sentence ?? '').trim()
        if (sentence === '') throw new PlannerError('EMPTY_SENTENCE', 'sentence 不能为空：一句话规划需要具体需求')
        const project = resolveProject(a.project, stateDir, defaultProject)
        const context = collectRepoContext(project)
        const plan = await generatePlan({
          ctx,
          sentence,
          context,
          signal: toolCtx?.signal,
        })
        const applied = applyPlanToBoard({
          plan,
          project,
          opts,
          actor: actorOf(toolCtx),
          reason: 'plan_generate：' + plan.plan.goal,
          designDir,
          onEvent: options.onEvent,
        })
        return toJson({
          ok: true,
          sentence,
          plan: plan.plan,
          project,
          modules: plan.modules.map((m) => ({ id: m.id, title: m.title, tasks: m.tasks.map((t) => t.id) })),
          taskCount: applied.taskCount,
          moduleCount: applied.moduleCount,
          // 人审门：结构变更只是「提议」，板结构在批准前不变。
          approvalId: applied.approvalId,
          pendingApproval: applied.pendingApproval,
          boardCreated: applied.boardCreated,
          version: applied.version,
          opCount: applied.opCount,
          designDir,
          designFiles: applied.designFiles,
          note: '结构变更已进待批队列，需人在面板批准后才会写进板；子导图已落盘到 ' + designDir + '/<taskId>.json',
        })
      } catch (e) {
        return errJson(e)
      }
    },
    timeoutMs: 240_000,
  }))
  return typeof disposer === 'function' ? disposer : () => { /* 服务不返回注销函数时无需清理 */ }
}

/**
 * 入口（src/index.ts 调用）：registerPlanner(ctx.tools)。
 * 宿主 ctx 从 tools 服务反查，配置从 ctx.get('planSuperagentConfig') 读；
 * 拿不到 ctx 时工具仍可注册，但调模型会明确报 NO_MODEL（不编数据）。
 */
export function registerPlanner(tools: unknown, hostCtx?: unknown, config?: PlannerHostConfig): () => void {
  type ToolService = { register?: (t: unknown) => (() => void) | void; get?: unknown }
  const raw = tools as ToolService & { tools?: ToolService }
  let service: ToolService = raw
  if (typeof raw.register !== 'function') {
    const inner = raw.tools
    if (inner != null && typeof inner.register === 'function') service = inner
  }
  if (typeof service.register !== 'function') {
    throw new PlannerError('NO_TOOLS', 'tools 服务不可用：ctx.tools 没有 register 方法')
  }
  if (service == null || typeof service.register !== 'function') {
    throw new PlannerError('NO_TOOLS', 'tools 服务不可用：ctx.tools 没有 register 方法')
  }
  const ctx = hostCtx ?? hostCtxOf(service)
  const cfg = config ?? readHostConfig(ctx)
  const stateDir = cfg.stateDir != null && cfg.stateDir !== '' ? cfg.stateDir : defaultStateDir()
  const opts: StoreOpts = { blockOnDrift: cfg.blockOnDrift !== false }
  return registerPlannerTools(
    service as { register(tool: unknown): (() => void) | void },
    ctx,
    stateDir,
    opts,
    {
      defaultProject: cfg.project ?? '',
      designDir: cfg.subDesignDir ?? DESIGN_DIR,
    },
  )
}


