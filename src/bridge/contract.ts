/**
 * dsh-superagent 契约的**本地结构化副本**（Source 插件侧最小可用集）。
 *
 * ## ⚠ 这是一份**临时**副本，不是设计
 *
 * 上游一旦把 Source 插件契约抽成公开的契约包（计划 **t-1**），本文件**整体删除**，
 * 改成直接 import 上游的契约类型即可。在那之前它只是「引擎的类型面对外拿不到」的权宜之计：
 * 宁可显式抄一份、能逐字对照，也不要让整个包拖着一个发不了版的引擎当类型依赖。
 *
 * 所以抄的时候只抄**桥真正用到的那些形状**（BRIDGE_READS 那张清单就是桥读到的字段面，
 * 引擎升版时最该盯的就是那几处字段名；计划 **t-2** 的契约守卫测试照这张清单写），
 * 抄不到的、抄了也用不上的，宁可留空也不要凭印象补。
 *
 * ## 为什么不能直接 import dsh-superagent 的类型
 *
 * `dsh-superagent` 是 `private: true` 的未发布包：它不在任何 npm registry 上，也没有
 * 公开的类型入口。本包把它当作**运行时的对端**（通过 cordis 的 `orchestrator` 服务拿到
 * `sources.register(kind)` 与 `context(kind)`），而不是编译期的依赖：
 *
 * 1. `npm install` 拿不到它 → 写进 `dependencies` 也无法稳定安装；
 * 2. 即便从 git 装上，`private` 包的类型入口也不保证与本包锁定的版本一致；
 * 3. 桥只用到 Source 插件契约的一小块（kind / host / trigger / ticket / health），
 *    为它把整个引擎拖成类型依赖，收益远小于版本漂移的代价。
 *
 * 所以这里复制一份**结构化类型**：形状对齐引擎的 `src/sources/kind.ts`、
 * `src/sources/host.ts`、`src/sources/registry.ts`、`src/core/model.ts`、`src/kv.ts`。
 * 运行时只用到少数字段（`schema.parse` / `schema.safeParse`、`receive`、`report`、
 * `tickets`、`triggers`、`threads`），因此副本里的 `schema` 用一个 **zod 兼容的最小子集**
 * （`parse` / `safeParse`）表达——引擎侧对 kind 的 schema 只调用这两个方法
 * （见 `SourceRegistry.validate` / `resolve` / `validatePolicy` 与 `settings-history.ts`）。
 *
 * ## ⚠ 引擎升版时要同步这份副本
 *
 * 升级 dsh-superagent 后，请对照它的 `src/sources/kind.ts`（SourceKind 字段集）、
 * `src/sources/host.ts`（SourceContext 成员）、`src/core/model.ts`（Trigger / Ticket 形状）、
 * `src/kv.ts`（Key / family）与 `src/sources/host.ts` 的 `HEALTH_TEXT`（health code 字面量）
 * 复核本文件。**字段名变了不会报错**，只会被引擎静默忽略（例如 health code 写错 →
 * 面板不翻译；meta 键名写错 → 评估上下文读不到），所以升级后必须逐项对照。
 */
import { createHash } from 'node:crypto'

/** 文本在两种界面语言里的说法。 */
export interface Localized { zh: string; en: string }

/** `advanced` 把少改的字段折到卡片的高级区。 */
interface FieldBase { key: string; label: Localized; hint?: Localized; advanced?: true }
/**
 * 配置字段规格：`rows` 编辑以首列为主键的记录列表，`choose` 从已解析的来源标签里挑，
 * `fact` 展示 `facts` 里的只读值。形状对齐引擎 `src/sources/kind.ts` 的 `FieldSpec`。
 */
export type FieldSpec =
  | FieldBase & { type: 'switch' }
  | FieldBase & { type: 'select'; options: { value: string; label: Localized }[] }
  | FieldBase & { type: 'number'; min: number; max: number }
  | FieldBase & { type: 'text'; pattern?: string; readonly?: boolean; choose?: Localized }
  | FieldBase & { type: 'fact'; settings?: 'deployment' }
  | FieldBase & { type: 'rows'; columns: ({ key: string; label: Localized; type: 'text'; pattern?: string; optional?: boolean; choose?: Localized; refresh?: Localized } | { key: string; label: Localized; type: 'select'; options: { value: string; label: Localized }[] })[] }

/** 引擎为某个来源注册的执行环境变量。 */
export interface VariableSpec { key: string; description: Localized }

/** 执行者身份（用来源自己的词汇；策略决定谁能发起工作）。 */
export interface ActorRef { source: string; id: string }
/** 线程身份；由来源决定 id 的推导规则。 */
export interface ThreadRef { source: string; id: string }
/** 线程上的只写地址；地址格式由来源自己定。 */
export interface ChannelRef { source: string; thread: string; address: Record<string, string> }

/** 一个不可变事件；`text` 与 `meta` 是**不可信数据**，不是授权。 */
export interface Trigger {
  id: string
  source: string
  /** 触发器所属的全部线程；第一个（`threads[0]`）是承载评估的主线程。 */
  threads: ThreadRef[]
  actor: ActorRef
  /** 来源声明：事件由人写的（不是机器人、CI 或本智能体）。 */
  human: boolean
  /** 来源声明：发送者确实在跟智能体说话（@ 或私聊）。 */
  addressed?: 'mention' | 'direct'
  at: string
  text: string
  channel?: ChannelRef
  url?: string
  /** 来源原生细节；核心从不解释它。 */
  meta: Record<string, unknown>
}

/** 触发器入库后的去向。 */
export type ReceiveResult = 'stored' | 'duplicate' | 'filtered'

/** 监听范围判定结果。 */
export type ScopeResult = { listened: true; observed: boolean; row?: string } | { listened: false; reason: string }

/** 出站消息（引擎 Outbox 投递）。 */
export interface OutboundMessage { id: string; channel: ChannelRef; text: string; kind: 'acknowledgement' | 'reply' | 'notice'; ticketId?: string }

/** 线程展示信息。 */
export interface ThreadFact { label?: string | Localized; value: string | Localized; problem?: true }
export interface ThreadDescription { label?: string; url?: string; facts?: Record<string, ThreadFact | null> }

/** 线程聚合。 */
export interface Thread { key: string; ref: ThreadRef; createdAt: string; lastAt?: string; subscriptions: string[]; meta: Record<string, unknown> }

/** 工单如何结束。 */
export type TicketEndBy = 'executor' | 'human'
export type TicketOutcome = 'completed' | 'merged' | 'closed' | 'dropped' | 'stopped'
/** 执行者的报告状态。 */
export type ReportState = 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped'
/** 工单与一个执行实例的绑定。 */
export interface Assignment {
  id: string
  state: 'pending' | 'running' | 'ended'
  createdAt: string
  startedAt?: string
  endedAt?: string
  endedReason?: string
  report?: { state: ReportState; summary: string; at: string }
}
/** 工单（授权过的工作项）。这里只复制桥读得到的字段。 */
export interface Ticket {
  id: string
  title: string
  ended?: { at: string; by: TicketEndBy; outcome: TicketOutcome; reason?: string }
  assignments: Assignment[]
  execution?: { name: string; directory: string; assignment: string }
  origin: { triggerId: string; triggerIds: string[] }
  mandate: { actor: ActorRef; strength: 'explicit' | 'inferred'; scope: string }
  createdAt: string
  updatedAt: string
}

/** 线程上下文消息。 */
export interface ContextMessage { id: string; from: string; at: string; text: string; bot?: true; deleted?: true; reply_to?: string; url?: string; path?: string; line?: number }
export type ContextPartName = 'thread' | 'root' | 'parent'
export interface ContextPart { messages: ContextMessage[]; next?: string | undefined; body: Record<string, unknown>; status?: string }

/** 命令执行口（桥只用到 `run`）。 */
export interface Commands { run(command: string, args?: string[]): Promise<string> }

/** 引擎的部署信息（桥不读它的字段）。 */
export type Deployment = unknown

/** 引擎的 KV 键。 */
export type Key<V> = string & { readonly __value?: V }
/** 同前缀的键族。 */
export type Family<V, A extends unknown[]> = ((...name: A) => Key<V>) & { readonly prefix: string }
/**
 * 桥真正读到的契约面（其余字段只是类型上的传递依赖）。
 *
 * 引擎升版时最该盯的就是这几处字段名：触发器的 id/text/meta/threads/actor、
 * 工单的 ended/assignments/origin/mandate、健康条目的 state/detail/code。
 * 计划 t-2 的契约守卫测试就照这张清单写。
 *
 * 与文件末尾那组常量的分工：`BRIDGE_*_FIELDS` 是**穷举**字段面（配 `Assert<Equals<keyof X, ...>>`
 * 编译期断言，引擎给类型加字段就会红）；`BRIDGE_USED_*` 是**运行时真正读到**的那几个成员。
 * 本清单是桥与引擎之间**流转**的字段面：既包含桥读回来的，也包含桥写过去的
 * （触发器的 actor/text/human/at 是桥填进去的）。
 */
export const BRIDGE_READS = [
  'Trigger.id', 'Trigger.text', 'Trigger.meta', 'Trigger.threads', 'Trigger.actor', 'Trigger.human', 'Trigger.at',
  'Ticket.id', 'Ticket.title', 'Ticket.ended', 'Ticket.assignments', 'Ticket.origin', 'Ticket.mandate', 'Ticket.execution',
  'Health.state', 'Health.detail', 'Health.code',
] as const

/** 定义一个带类型的 KV 键（外部来源插件用这个自己声明键）。 */
export const record = <V>(key: string): Key<V> => key as Key<V>

/** 稳定内容派生 id：同样的输入永远得到同样的 id（引擎 `core/ids.ts` 的 `key()`）。 */
export function stableKey(...values: string[]): string {
  return createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 32)
}

/* ------------------------------------------------------------------ *
 * 健康条目
 * ------------------------------------------------------------------ */

/** 引擎固定的英文健康文案（`{name}` 占位）；面板按界面语言翻译 `code`。 */
export const HEALTH_TEXT = {
  setupPending: 'Waiting for the deployment check',
  sourceOff: 'Off',
  pollFailures: '{count} consecutive failed polls; last: {error}',
} as const
export type HealthCode = keyof typeof HEALTH_TEXT
export type Health = { state: 'starting' | 'ready' | 'paused' | 'error'; detail: string; at?: string; code?: HealthCode; values?: Record<string, string> }
function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole)
}
/** 按引擎的固定文案生成一条健康状态。 */
export function health(state: Health['state'], code: HealthCode, values: Record<string, string> = {}): Health {
  return { state, detail: fill(HEALTH_TEXT[code], values), code, ...Object.keys(values).length ? { values } : {} }
}

/* ------------------------------------------------------------------ *
 * zod 兼容的最小 schema 子集
 *
 * 引擎的 kind 契约写的是 `z.ZodType<C>`，但 zod 不是本包的依赖（不引入新的运行时
 * 依赖），而引擎运行时对 kind 的 schema 只调用 `parse` 与 `safeParse`
 * （`SourceRegistry.validate` / `resolve` / `validatePolicy`、`settings-history.ts`）。
 * 这里实现这两个方法，外加「填默认值 / 拒绝未知键」的行为，与 zod 的
 * `z.object({...}).strict()` + `.default()` 语义对齐。
 * ------------------------------------------------------------------ */

/** schema 校验失败。 */
export class SchemaError extends Error {
  constructor(message: string) { super(message); this.name = 'SchemaError' }
}
export type SafeParseResult<T> = { success: true; data: T } | { success: false; error: Error }
/** zod 的最小替身：引擎只需要这两个方法。 */
export interface SchemaLike<T> {
  parse(value: unknown): T
  safeParse(value: unknown): SafeParseResult<T>
}
function makeSchema<T>(parse: (value: unknown) => T): SchemaLike<T> {
  return {
    parse,
    safeParse(value: unknown): SafeParseResult<T> {
      try { return { success: true, data: parse(value) } }
      catch (error) { return { success: false, error: error instanceof Error ? error : new Error(String(error)) } }
    },
  }
}
function defaultOf<T>(value: T | (() => T) | undefined): T | undefined {
  return typeof value === 'function' ? (value as () => T)() : value
}

/** 字符串字段。 */
export function str(opts: { min?: number; max?: number; pattern?: RegExp; default?: string | (() => string) } = {}): SchemaLike<string> {
  return makeSchema<string>((value) => {
    if (value === undefined) {
      const fallback = defaultOf(opts.default)
      if (fallback === undefined) throw new SchemaError('expected a string')
      return fallback
    }
    if (typeof value !== 'string') throw new SchemaError('expected a string')
    if (opts.min != null && value.length < opts.min) throw new SchemaError(`expected at least ${opts.min} characters`)
    if (opts.max != null && value.length > opts.max) throw new SchemaError(`expected at most ${opts.max} characters`)
    if (opts.pattern != null && !opts.pattern.test(value)) throw new SchemaError(`does not match ${opts.pattern}`)
    return value
  })
}
/** 数字字段。 */
export function num(opts: { int?: boolean; min?: number; max?: number; default?: number | (() => number) } = {}): SchemaLike<number> {
  return makeSchema<number>((value) => {
    if (value === undefined) {
      const fallback = defaultOf(opts.default)
      if (fallback === undefined) throw new SchemaError('expected a number')
      return fallback
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new SchemaError('expected a number')
    if (opts.int === true && !Number.isInteger(value)) throw new SchemaError('expected an integer')
    if (opts.min != null && value < opts.min) throw new SchemaError(`expected at least ${opts.min}`)
    if (opts.max != null && value > opts.max) throw new SchemaError(`expected at most ${opts.max}`)
    return value
  })
}
/** 可选字段：缺省即 undefined，不报错。 */
export function opt<T>(schema: SchemaLike<T>): SchemaLike<T | undefined> {
  return makeSchema<T | undefined>((value) => value === undefined ? undefined : schema.parse(value))
}
/** 数组字段。 */
export function arr<T>(item: SchemaLike<T>, opts: { default?: T[] | (() => T[]) } = {}): SchemaLike<T[]> {
  return makeSchema<T[]>((value) => {
    if (value === undefined) {
      const fallback = defaultOf(opts.default)
      if (fallback === undefined) throw new SchemaError('expected an array')
      return fallback
    }
    if (!Array.isArray(value)) throw new SchemaError('expected an array')
    return value.map((entry, index) => {
      try { return item.parse(entry) }
      catch (error) { throw new SchemaError(`[${index}]: ${error instanceof Error ? error.message : String(error)}`) }
    })
  })
}
export type Shape = Record<string, SchemaLike<unknown>>
export type ShapeOut<S extends Shape> = { [K in keyof S]: S[K] extends SchemaLike<infer U> ? U : never }
/**
 * 对象字段。`strict`（默认）拒绝未知键；非 strict 时忽略未知键（策略部分用宽松模式，
 * 因为引擎会把整个 `policy.sources.<kind>` 段落连同别的键一起交给它校验）。
 */
export function obj<S extends Shape>(shape: S, opts: { strict?: boolean } = {}): SchemaLike<ShapeOut<S>> {
  const strict = opts.strict !== false
  return makeSchema<ShapeOut<S>>((value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new SchemaError('expected an object')
    const input = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(shape)) out[key] = shape[key]!.parse(input[key])
    if (strict) {
      const extra = Object.keys(input).filter((key) => !(key in shape))
      if (extra.length > 0) throw new SchemaError('unknown key(s): ' + extra.join(', '))
    }
    return out as ShapeOut<S>
  })
}
/** 在既有 schema 上加一条自定义校验（返回字符串即错误原因）。 */
export function refine<T>(schema: SchemaLike<T>, check: (value: T) => boolean | string): SchemaLike<T> {
  return makeSchema<T>((value) => {
    const parsed = schema.parse(value)
    const result = check(parsed)
    if (result === false) throw new SchemaError('failed the check')
    if (typeof result === 'string') throw new SchemaError(result)
    return parsed
  })
}

/* ------------------------------------------------------------------ *
 * Source 插件契约
 * ------------------------------------------------------------------ */

/** 接收范围在策略里的行视图。 */
export interface AdmissionRowView { id: string; label: Localized | string; note: Localized; cells: { listedUnaddressed: boolean; unlistedAddressed: boolean; unlistedUnaddressed: boolean } }
/** 来源自己的策略段：允许的发送者、准入表行、可选的外部名册同步。 */
export interface SourcePolicyPart<P extends Record<string, unknown>> {
  schema: SchemaLike<P>
  fields: FieldSpec[]
  explicit: Localized
  unnamed?: { person: Localized; bot: Localized }
  rows?(config: Record<string, unknown>): AdmissionRowView[]
}
/** 出站消息适配器。 */
export interface SourceChannel<C> {
  allowed?(address: Record<string, string>, config: C): boolean
  /** 按消息 id 幂等发送；目标永远收不到时返回 `'gone'`。 */
  send(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'>
  link(address: Record<string, string>, links: Record<string, unknown>): { url: string; label: Localized; triggerId?: string }
}
/** 评估用的线程上下文读取器。 */
export interface ThreadContext<C> {
  messageId(trigger: Trigger): string
  read(commands: Commands, trigger: Trigger, part: ContextPartName, cursor: string | undefined, config: C): Promise<ContextPart>
}
/** 来源插件描述符。 */
export interface SourceKind<C extends Record<string, unknown> = Record<string, unknown>> {
  kind: string
  title: Localized
  description: Localized
  facts?(deployment: Deployment): Record<string, Localized | string>
  schema: SchemaLike<C>
  fields: FieldSpec[]
  /** 本来源在 `health[...]` 下拥有的条目名。 */
  health: string[]
  scope?(input: { meta: Record<string, unknown> }, config: C): ScopeResult
  channel?: SourceChannel<C>
  threadContext?: ThreadContext<C>
  find?(query: string): { threads: string[]; terms: string[] }
  repliesTo?(trigger: Trigger): string | undefined
  policy?: SourcePolicyPart<Record<string, unknown> & { allowed: { id: string; name?: string }[] }>
  refreshLabels?(host: SourceHost, signal?: AbortSignal): Promise<Record<string, string>>
  environment?: { variables: readonly VariableSpec[]; values(input: { deployment: Deployment; config: C; trigger?: Trigger }): Record<string, string> }
}
/** 注册表（桥只用 `register`）。 */
export interface SourceRegistryLike {
  register<C extends Record<string, unknown>>(kind: SourceKind<C>): () => void
}
/** 来源上下文：引擎暴露给来源插件的能力。 */
export interface SourceContext {
  readonly deployment: Deployment
  readonly commands: Commands
  readonly ready: Promise<void>
  /** 部署检查是否已完成；未完成前来源不读数据。 */
  configured(): boolean
  /** 某来源的配置；来源关闭时为 undefined。 */
  config<C extends Record<string, unknown>>(kind: string): C | undefined
  /** 把触发器交给引擎；调用方应 await 完成后再推进读取游标。 */
  receive(trigger: Trigger): ReceiveResult | Promise<ReceiveResult>
  atomic<T>(work: () => T): T
  /** 来源私有的 KV 记录；写 undefined 即删除。 */
  state: {
    get<V>(key: Key<V>): V | undefined
    set<V>(key: Key<V>, value: V | undefined): void
    keys<V>(family: Family<V, never>): Key<V>[]
  }
  threads: {
    get(key: string): Thread | undefined
    subscribed(source: string): Thread[]
    describe(key: string, description: ThreadDescription): void
    patch(key: string, meta: Record<string, unknown>): void
  }
  tickets: {
    get(id: string): Ticket | undefined
    /** 未结束的工单，新的在前。 */
    open(): Ticket[]
    bindThread(id: string, thread: ThreadRef, own: boolean): void
    threadClosed(thread: ThreadRef, outcome: 'merged' | 'closed', at: string): void
  }
  triggers: { get(id: string): Trigger | undefined; latest(thread: string): Trigger | undefined }
  notify(message: OutboundMessage): void
  /** 报告本来源声明过的健康条目；未声明的名字会抛错。 */
  report(entry: string, health: Health): void
}
/** 引擎暴露给来源插件的服务。 */
export interface SourceHost {
  readonly sources: SourceRegistryLike
  /** 某个来源的上下文；它的 `report` 只会写该来源声明过的健康条目。 */
  context(kind: { kind: string; health: readonly string[] }): SourceContext
}

/* ------------------------------------------------------------------ *
 * 副本一致性（运行时可见的字段名）
 *
 * 为什么接口之外还要落一份运行时数据：接口只在**编译期**存在，而真正会失配的那一侧是
 * 「引擎改了字段名、桥这边还拿着旧副本」——对编译器来说两边都自洽，毫无异常；故障发生在运行时：
 * 宿主对不认识的字段是消费者 fall through，于是桥读到 undefined，面板不翻译、评估读不到、
 * 一切照旧运行，只是什么都不发生。
 *
 * 所以把「这份副本认识哪些字段」落成数据，自测（scripts/bridge-contract-selftest.mjs）拿它跟
 * 引擎的 `SOURCE_CONTRACT`（`dsh-superagent/contract`）逐项对比：引擎改名 → 对比变红 → 桥跟上。
 * ------------------------------------------------------------------ */

/** 桥这份副本认识的 Source kind 字段。 */
export const BRIDGE_SOURCE_KIND_FIELDS = [
  'kind', 'title', 'description', 'facts', 'schema', 'fields', 'health',
  'scope', 'channel', 'threadContext', 'find', 'repliesTo', 'policy', 'refreshLabels', 'environment',
] as const
/** 桥这份副本认识的 SourceContext 成员。 */
export const BRIDGE_SOURCE_CONTEXT_FIELDS = [
  'deployment', 'commands', 'ready', 'configured', 'config', 'receive', 'atomic',
  'state', 'threads', 'tickets', 'triggers', 'notify', 'report',
] as const
/** 桥这份副本认识的 Trigger 字段。 */
export const BRIDGE_TRIGGER_FIELDS = [
  'id', 'source', 'threads', 'actor', 'human', 'addressed', 'at', 'text', 'channel', 'url', 'meta',
] as const
/** 桥这份副本认识的 Ticket 字段（只抄了桥读得到的那些）。 */
export const BRIDGE_TICKET_FIELDS = [
  'id', 'title', 'ended', 'assignments', 'execution', 'origin', 'mandate', 'createdAt', 'updatedAt',
] as const
/** 桥这份副本认识的外发通道字段。 */
export const BRIDGE_CHANNEL_FIELDS = ['allowed', 'send', 'link'] as const
/** 桥这份副本认识的策略段字段。 */
export const BRIDGE_POLICY_FIELDS = ['schema', 'fields', 'explicit', 'unnamed', 'rows'] as const
/** 桥这份副本认识的线程上下文字段。 */
export const BRIDGE_THREAD_CONTEXT_FIELDS = ['messageId', 'read'] as const
/** 健康状态。 */
export const BRIDGE_HEALTH_STATES = ['starting', 'ready', 'paused', 'error'] as const
/** 桥用的健康码（引擎还有飞书专用的两个，桥用不到）。 */
export const BRIDGE_HEALTH_CODES = ['setupPending', 'sourceOff', 'pollFailures'] as const
/** 健康条目的字段。 */
export const BRIDGE_HEALTH_FIELDS = ['state', 'detail', 'at', 'code', 'values'] as const

/** 桥在运行时真正用到的 SourceContext 成员：这些名字在引擎里一改，桥就读到 undefined，而编译期看不出来。 */
export const BRIDGE_USED_CONTEXT_MEMBERS = [
  'ready', 'configured', 'report', 'config', 'state', 'receive', 'threads', 'tickets', 'triggers',
] as const
/** 桥在运行时真正读到的 Ticket 字段。 */
export const BRIDGE_USED_TICKET_FIELDS = ['id', 'ended', 'assignments', 'execution', 'origin'] as const
/** 桥在运行时真正读到的 Trigger 字段。 */
export const BRIDGE_USED_TRIGGER_FIELDS = ['id', 'threads', 'meta', 'channel'] as const

/** 两个类型是否相同（下面的断言用）。 */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
/** 断言不成立时编译失败：字段名清单与接口对不上，就是副本自己漂了。 */
type Assert<T extends true> = T
type _kind = Assert<Equals<keyof SourceKind, typeof BRIDGE_SOURCE_KIND_FIELDS[number]>>
type _context = Assert<Equals<keyof SourceContext, typeof BRIDGE_SOURCE_CONTEXT_FIELDS[number]>>
type _trigger = Assert<Equals<keyof Trigger, typeof BRIDGE_TRIGGER_FIELDS[number]>>
type _ticket = Assert<Equals<keyof Ticket, typeof BRIDGE_TICKET_FIELDS[number]>>
type _channel = Assert<Equals<keyof SourceChannel<Record<string, unknown>>, typeof BRIDGE_CHANNEL_FIELDS[number]>>
type _policy = Assert<Equals<keyof SourcePolicyPart<Record<string, unknown>>, typeof BRIDGE_POLICY_FIELDS[number]>>
type _threadContext = Assert<Equals<keyof ThreadContext<Record<string, unknown>>, typeof BRIDGE_THREAD_CONTEXT_FIELDS[number]>>
type _health = Assert<Equals<keyof Health, typeof BRIDGE_HEALTH_FIELDS[number]>>
type _healthStates = Assert<Equals<Health['state'], typeof BRIDGE_HEALTH_STATES[number]>>
