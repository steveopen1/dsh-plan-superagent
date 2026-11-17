/**
 * 副本一致性检查：桥抄的那份契约 vs 引擎现在承诺的契约。
 *
 * ## 为什么要有这一层
 *
 * 桥（`src/bridge/contract.ts`）把引擎的 Source 插件契约**手抄**了一份，因为引擎是未发布的
 * `private` 包，拿不到它的类型入口（见那份文件开头的说明）。手抄的代价是：引擎升版改了字段名，
 * 桥这边**不会报错**——两边各自编译都自洽，宿主对不认识的字段又是消费者 fall through，
 * 于是桥读到 undefined，面板不翻译、评估读不到、桥照样跑，只是什么都不发生。
 *
 * 这一层把「引擎承诺了什么」变成**运行时可读的数据**（引擎侧 `dsh-superagent/contract` 导出
 * `SOURCE_CONTRACT`），桥把自己的字段名也落成运行时数据，然后逐项比对：
 *
 * - 引擎要求的字段，桥必须都有（缺了 = 桥按旧副本写的那份实现在新引擎上不成立）；
 * - 桥抄的字段，引擎必须都还有（多出来的 = 引擎改了名或删了，桥还留着旧的）。
 *
 * 比对结果是一个**清单**而不是一个布尔值：人要看的是「哪一处对不上」，不是一个红绿灯。
 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  BRIDGE_CHANNEL_FIELDS, BRIDGE_HEALTH_CODES, BRIDGE_HEALTH_FIELDS, BRIDGE_HEALTH_STATES,
  BRIDGE_POLICY_FIELDS, BRIDGE_SOURCE_CONTEXT_FIELDS, BRIDGE_SOURCE_KIND_FIELDS,
  BRIDGE_THREAD_CONTEXT_FIELDS, BRIDGE_TICKET_FIELDS, BRIDGE_TRIGGER_FIELDS,
  BRIDGE_USED_CONTEXT_MEMBERS, BRIDGE_USED_TICKET_FIELDS, BRIDGE_USED_TRIGGER_FIELDS,
} from './contract.js'

/** 引擎契约里的一节：必填成员与可选成员。 */
export interface ContractSection { required: readonly string[]; optional?: readonly string[] }

/** 引擎侧契约的形状：`dsh-superagent/contract` 导出的 `SOURCE_CONTRACT`。 */
export interface EngineContract {
  version: number
  kind: ContractSection
  context: ContractSection
  trigger: ContractSection
  ticket: ContractSection
  channel: ContractSection
  policy: ContractSection
  threadContext: ContractSection
  host: ContractSection
  health: { states: readonly string[]; fields: readonly string[]; codes: readonly string[] }
}

/** 一处对不上。 */
export interface ContractMismatch { area: string; detail: string }

/** 一节里所有成员的名字。 */
function names(section: ContractSection): string[] { return [...section.required, ...(section.optional ?? [])] }
/** 需要有、却没有的名字。 */
function missing(need: readonly string[], have: readonly string[]): string[] { return need.filter(name => !have.includes(name)) }
/** 有、但对方已经没有了的名字。 */
function unknown(mine: readonly string[], theirs: readonly string[]): string[] { return mine.filter(name => !theirs.includes(name)) }

/**
 * 拿桥的副本和引擎的契约逐项比对，返回全部不一致（空数组 = 一致）。
 *
 * 比的不是「字段名完全一样」，而是**桥真正依赖的那部分**：
 * 桥只抄了工单的一部分字段、也没实现引擎所有的可选成员，所以「桥比引擎少」是正常的；
 * 不正常的是「桥依赖的字段引擎没有了」和「引擎要求的字段桥没有」。
 */
export function compareBridgeToEngine(engine: EngineContract): ContractMismatch[] {
  const out: ContractMismatch[] = []
  const push = (area: string, detail: string) => { out.push({ area, detail }) }
  const bridgeKind = [...BRIDGE_SOURCE_KIND_FIELDS]
  const engineKind = names(engine.kind)
  const gone = missing(engine.kind.required, bridgeKind)
  if (gone.length) push('kind', `引擎要求而桥没有的字段：${gone.join('、')}`)
  const stale = unknown(bridgeKind, engineKind)
  if (stale.length) push('kind', `桥还留着引擎已经没有的字段：${stale.join('、')}`)

  const engineContext = names(engine.context)
  const goneContext = missing(BRIDGE_USED_CONTEXT_MEMBERS, engineContext)
  if (goneContext.length) push('context', `桥用到的、引擎已经没有的成员：${goneContext.join('、')}`)
  const staleContext = unknown(BRIDGE_SOURCE_CONTEXT_FIELDS, engineContext)
  if (staleContext.length) push('context', `桥抄的、引擎已经没有的成员：${staleContext.join('、')}`)

  const engineTrigger = names(engine.trigger)
  const goneTrigger = missing(engine.trigger.required, BRIDGE_TRIGGER_FIELDS)
  if (goneTrigger.length) push('trigger', `引擎要求而桥没有的字段：${goneTrigger.join('、')}`)
  const staleTrigger = unknown(BRIDGE_TRIGGER_FIELDS, engineTrigger)
  if (staleTrigger.length) push('trigger', `桥还留着引擎已经没有的字段：${staleTrigger.join('、')}`)
  const usedTrigger = missing(BRIDGE_USED_TRIGGER_FIELDS, engineTrigger)
  if (usedTrigger.length) push('trigger', `桥用到的、引擎已经没有的字段：${usedTrigger.join('、')}`)

  const engineTicket = names(engine.ticket)
  const goneTicket = missing(BRIDGE_USED_TICKET_FIELDS, engineTicket)
  if (goneTicket.length) push('ticket', `桥读到的、引擎已经没有的字段：${goneTicket.join('、')}`)
  const staleTicket = unknown(BRIDGE_TICKET_FIELDS, engineTicket)
  if (staleTicket.length) push('ticket', `桥抄的、引擎已经没有的字段：${staleTicket.join('、')}`)

  const staleChannel = unknown(BRIDGE_CHANNEL_FIELDS, names(engine.channel))
  if (staleChannel.length) push('channel', `桥抄的、引擎已经没有的字段：${staleChannel.join('、')}`)
  const stalePolicy = unknown(BRIDGE_POLICY_FIELDS, names(engine.policy))
  if (stalePolicy.length) push('policy', `桥抄的、引擎已经没有的字段：${stalePolicy.join('、')}`)
  const staleContextReader = unknown(BRIDGE_THREAD_CONTEXT_FIELDS, names(engine.threadContext))
  if (staleContextReader.length) push('threadContext', `桥抄的、引擎已经没有的字段：${staleContextReader.join('、')}`)

  const goneStates = missing(BRIDGE_HEALTH_STATES, engine.health.states)
  if (goneStates.length) push('health', `桥用的、引擎已经没有的健康状态：${goneStates.join('、')}`)
  const goneCodes = missing(BRIDGE_HEALTH_CODES, engine.health.codes)
  if (goneCodes.length) push('health', `桥用的、引擎已经没有的健康码：${goneCodes.join('、')}`)
  const goneFields = missing(BRIDGE_HEALTH_FIELDS, engine.health.fields)
  if (goneFields.length) push('health', `桥用的、引擎已经没有的健康字段：${goneFields.join('、')}`)
  return out
}

/** 引擎契约的来源。 */
export interface LoadedEngineContract { source: string; contract: EngineContract }

/**
 * 找到引擎的契约并读进来。
 *
 * 来源顺序：环境变量 `DSH_SUPERAGENT_CONTRACT_MODULE`（指向一个模块文件）→ 已安装的依赖
 * `dsh-superagent/contract` → 同机的引擎仓（`<包根>/../dsh-superagent-win/lib/contract.js`，开发时用）。
 *
 * 三条都找不到就**报错**，不静默跳过：一个永远跑不到的比对，等于没有比对。
 *
 * @param root 包根目录，默认当前工作目录（自测在包根运行）。
 */
export async function loadEngineContract(root: string = process.cwd()): Promise<LoadedEngineContract> {
  const candidates: { source: string; specifier: string }[] = []
  const override = process.env.DSH_SUPERAGENT_CONTRACT_MODULE
  if (override !== undefined && override !== '') {
    candidates.push({ source: `env:${override}`, specifier: pathToFileURL(resolve(override)).href })
  }
  candidates.push({ source: 'dependency:dsh-superagent/contract', specifier: 'dsh-superagent/contract' })
  candidates.push({ source: 'sibling:dsh-superagent-win', specifier: pathToFileURL(resolve(root, '..', 'dsh-superagent-win', 'lib', 'contract.js')).href })
  for (const candidate of candidates) {
    let module: { SOURCE_CONTRACT?: EngineContract }
    try { module = await import(candidate.specifier) as { SOURCE_CONTRACT?: EngineContract } }
    catch { continue }
    if (module.SOURCE_CONTRACT === undefined) continue
    return { source: candidate.source, contract: module.SOURCE_CONTRACT }
  }
  throw new Error(
    '找不到引擎的契约模块。装上带 `./contract` 导出的 dsh-superagent，或用 DSH_SUPERAGENT_CONTRACT_MODULE 指向它；'
    + '试过的来源：' + candidates.map(candidate => candidate.source).join('、'))
}
