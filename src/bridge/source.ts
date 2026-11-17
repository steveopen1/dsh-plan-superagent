/**
 * 计划板来源 kind（`planboard`）：把板上的就绪任务变成引擎能吃的触发器。
 *
 * 契约要点（照引擎的 `docs/008-cookbook.md`「新增一个 Source kind」九步走）：
 * - `schema` / `fields`：面板表单与配置校验（`project` 绝对路径、`actor` 发起人 id、
 *   `designsDir` 子导图目录、`pollSeconds` 轮询间隔）；
 * - `health: ['planboard']`：本来源独占的健康条目名；
 * - `scope`：只接收自己配置的那个项目的触发器；
 * - `channel`：回写通道（引擎把 worker 的回复送回板上的任务备注）；
 * - `policy`：允许的发送者 = 配置里的 `actor`；
 * - `environment`：把项目路径、任务 id、子导图路径交给 worker。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BoardError } from '../board/schema.js'
import { PlanStore } from '../board/store.js'
import { isAbsolutePath } from '../board/pathutil.js'
import {
  arr, num, obj, opt, refine, str,
  type SourceKind, type SourcePolicyPart,
} from './contract.js'
import { PLANBOARD_SOURCE } from './trigger.js'

/** 来源 kind id（注册名、策略段名、thread key 前缀都是它）。 */
export const PLANBOARD_KIND = PLANBOARD_SOURCE
/** 健康条目名。 */
export const PLANBOARD_HEALTH = 'planboard'
/** 默认发起人 id。板上没有「人」，所以发起人是一个配置项。 */
export const PLANBOARD_ACTOR_DEFAULT = 'planboard'
/** 子导图默认目录（相对项目根目录）。 */
export const PLANBOARD_DESIGNS_DIR_DEFAULT = '.plan-board/designs'
/** 准入表里的行 id。 */
export const PLANBOARD_ROW = 'planboard'

/** 桥写板时用的 store 选项：漂移只报警报，不冻结板子（冻结由人决定）。 */
export const BRIDGE_STORE_OPTS = { blockOnDrift: false }

/** 来源配置。 */
export type PlanboardConfig = {
  /** 计划板所在项目根目录（绝对路径）。 */
  project: string
  /** 发起人 id：写在触发器的 `actor` 上，并需要出现在策略的允许名单里。 */
  actor: string
  /** 子导图目录（相对 project 或绝对路径）。 */
  designsDir: string
  /** 轮询间隔（秒）。 */
  pollSeconds: number
}

/** 默认项目目录：与板工具的默认一致（`<DSH_HOME>/dsh-plan-board/default`）。 */
export function defaultPlanboardProject(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'dsh-plan-board', 'default')
}

/** 来源配置的 schema。 */
export const planboardConfigSchema = obj({
  project: refine(str({ default: defaultPlanboardProject }), (value) => isAbsolutePath(value) ? true : 'project 必须是绝对路径'),
  actor: str({ min: 1, max: 200, default: PLANBOARD_ACTOR_DEFAULT }),
  designsDir: str({ min: 1, max: 400, default: PLANBOARD_DESIGNS_DIR_DEFAULT }),
  pollSeconds: num({ int: true, min: 5, max: 3600, default: 15 }),
}, { strict: true })

/** 来源策略段：允许的发送者。默认与 `actor` 的默认值一致，开箱即用。 */
export const planboardPolicySchema = obj({
  allowed: arr(obj({
    id: str({ min: 1, max: 200 }),
    name: opt(str({ max: 100 })),
  }, { strict: true }), { default: () => [{ id: PLANBOARD_ACTOR_DEFAULT, name: '计划板' }] }),
}, { strict: false })

type PlanboardPolicy = { allowed: { id: string; name?: string }[] }

/** 策略段定义（引擎把它渲染成 Eval → On each Source 的表单）。 */
export const planboardPolicyPart: SourcePolicyPart<Record<string, unknown> & PlanboardPolicy> = {
  schema: planboardPolicySchema,
  fields: [
    { key: 'allowed', type: 'rows', label: { zh: '能发起工作的发送者', en: 'Senders who may originate work' }, columns: [
      { key: 'id', type: 'text', label: { zh: '发送者', en: 'Sender' } },
      { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true },
    ] },
  ],
  explicit: { zh: '名单里的发起人把计划板上的就绪任务派给了智能体。', en: 'A listed originator hands a ready task on the plan board to the agent.' },
  rows: () => [{
    id: PLANBOARD_ROW,
    label: { zh: '计划板', en: 'Plan board' },
    note: { zh: '计划板上的就绪任务（只认名单里的发起人）', en: 'Ready tasks on the plan board (only a listed originator)' },
    cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: false },
  }],
}

/**
 * 计划板来源 kind。
 *
 * 注册到引擎后，它出现在 Sources 设置与 Eval → On each Source 里；
 * 桥的轮询循环（`watch.ts`）用 `ctx.receive(trigger)` 把任务喂给它。
 */
export const planboardKind: SourceKind<PlanboardConfig> = {
  kind: PLANBOARD_KIND,
  title: { zh: '计划板', en: 'Plan board' },
  description: {
    zh: '把计划板上就绪的任务变成工单：每个就绪任务一张单，任务结束后把证据写回板上。',
    en: 'Turns ready plan-board tasks into tickets: one ticket per ready task, and the evidence is written back to the board.',
  },
  schema: planboardConfigSchema,
  fields: [
    { key: 'project', type: 'text', label: { zh: '项目根目录', en: 'Project root' },
      hint: { zh: '计划板所在项目的绝对路径（含 .plan-board/plan.board.json）', en: 'Absolute path of the project that holds .plan-board/plan.board.json' } },
    { key: 'actor', type: 'text', label: { zh: '发起人 id', en: 'Actor id' },
      hint: { zh: '写在触发器上的发起人；需与 Eval → On each Source 的允许名单一致', en: 'The originator written on the trigger; must match the allowed list under Eval → On each Source' } },
    { key: 'designsDir', type: 'text', advanced: true, label: { zh: '子导图目录', en: 'Design map directory' },
      hint: { zh: '相对项目根目录或绝对路径，默认 .plan-board/designs', en: 'Relative to the project root or absolute; default .plan-board/designs' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 5, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
  ],
  health: [PLANBOARD_HEALTH],
  scope: ({ meta }, config) => {
    const project = String(meta.project ?? '')
    if (project !== '' && project !== config.project) return { listened: false, reason: 'project_changed' }
    return { listened: true, observed: false, row: PLANBOARD_ROW }
  },
  channel: {
    allowed: (address, config) => address.project === config.project && (address.taskId ?? '') !== '',
    send: async (_host, message) => {
      const project = message.channel.address.project ?? ''
      const taskId = message.channel.address.taskId ?? ''
      if (project === '' || taskId === '') throw new Error('Missing plan board reply target')
      let store: PlanStore
      try {
        store = PlanStore.open(project, BRIDGE_STORE_OPTS)
      } catch (error) {
        // 板没了 = 这个地址永远收不到回复（不是暂时失败）。
        if (error instanceof BoardError && error.code === 'PLAN_NOT_FOUND') return 'gone'
        throw error
      }
      if (store.boardNode(taskId) == null) return 'gone'
      const stamp = `[${message.kind}] ${message.text}`
      store.mutate('superagent:reply', 'superagent_reply', { taskId, messageId: message.id, kind: message.kind }, (b) => {
        const node = b.nodes.find(item => item.id === taskId)
        if (node == null) return
        // 幂等：同一条消息 id 不写第二遍（Outbox 会重试）。
        if ((node.note ?? '').includes(message.id)) return
        const note = node.note ?? ''
        node.note = (note === '' ? '' : note + '\n') + stamp + ' #' + message.id
        node.updatedAt = new Date().toISOString()
      })
      return 'sent'
    },
    link: (address) => ({
      url: '',
      label: { zh: '计划板任务 ' + (address.taskId ?? ''), en: 'Plan board task ' + (address.taskId ?? '') },
    }),
  },
  threadContext: {
    messageId: trigger => String(trigger.meta.taskId ?? trigger.id),
    read: async (_commands, trigger, _part, _cursor, _config) => {
      // 计划板的「线程」就是一条任务：评估时能读到的上下文就是任务简报本身。
      const messages = [{
        id: String(trigger.meta.taskId ?? trigger.id),
        from: String(trigger.actor.id),
        at: trigger.at,
        text: trigger.text,
      }]
      return { messages, body: { messages } }
    },
  },
  find: query => ({
    threads: query.match(/\bplanboard:[^\s]+/g) ?? [],
    terms: [...new Set(query.match(/[\p{L}\p{N}_.-]{3,64}/gu) ?? [])],
  }),
  policy: planboardPolicyPart,
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_PLANBOARD_PROJECT', description: {
        zh: '计划板所在的项目根目录（绝对路径）；工单不是来自计划板时为空',
        en: 'Project root holding the plan board (absolute path); empty when the ticket did not start on the plan board' } },
      { key: 'DSH_SUPERAGENT_PLANBOARD_TASK', description: {
        zh: '本工单对应的计划板任务 id；工单不是来自计划板时为空',
        en: 'Plan board task id of this ticket; empty when the ticket did not start on the plan board' } },
      { key: 'DSH_SUPERAGENT_PLANBOARD_DESIGN', description: {
        zh: '该任务的功能实现导图文件绝对路径（worker 可直接读）；工单不是来自计划板时为空',
        en: 'Absolute path of the task design map file (the worker can read it); empty when the ticket did not start on the plan board' } },
      { key: 'DSH_SUPERAGENT_PLANBOARD_DESIGN_REL', description: {
        zh: '该任务的功能实现导图文件相对项目根目录的路径；工单不是来自计划板时为空',
        en: 'Design map file path relative to the project root; empty when the ticket did not start on the plan board' } },
    ],
    values: ({ config, trigger }) => ({
      DSH_SUPERAGENT_PLANBOARD_PROJECT: config.project,
      DSH_SUPERAGENT_PLANBOARD_TASK: trigger?.source === PLANBOARD_SOURCE ? String(trigger.meta.taskId ?? '') : '',
      DSH_SUPERAGENT_PLANBOARD_DESIGN: trigger?.source === PLANBOARD_SOURCE ? String(trigger.meta.designAbs ?? '') : '',
      DSH_SUPERAGENT_PLANBOARD_DESIGN_REL: trigger?.source === PLANBOARD_SOURCE ? String(trigger.meta.designPath ?? '') : '',
    }),
  },
}