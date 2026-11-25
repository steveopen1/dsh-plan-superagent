/**
 * dsh-plan-superagent client：面板（宿主右侧栏的一个 tab）+ 会话头部入口 + 输入栏旁的模式开关。
 * 两必坑（骨架实测）：apply 用 ctx.slots 必须 export const inject = ['slots']；register 必带 name。
 * M2 第一批：/stream NDJSON 实时 + 主题跟随（采样 body 亮度）。
 * M2 第三批（本文件主体）：面板直编辑——点选节点出编辑卡（标题/备注/验收/scope/优先级/依赖多选）、
 * 自由拖拽节点（位置持久化 pos）、拖拽连线改依赖（A 拖到 B = B 依赖 A，再拖一次 = 移除）、
 * ＋子任务 / 删除节点；一切改动先进草稿态，点「保存更改」才 POST /edit 生效（用户拍板：不保存不生效）。
 */
import { Component, createElement as h, useEffect, useMemo, useRef, useState } from 'react'
import type { MutableRefObject, ReactNode, RefObject } from 'react'

type WEv = { deltaY: number; preventDefault(): void }
type PEv = { clientX: number; clientY: number; pointerId: number; target: Element; stopPropagation(): void }

const NS = 'dsh-plan-superagent'
const API = '/_dsh/dsh-plan-board'
const POLL_MS = 4000

/** 面板记住的项目路径（localStorage 键）。与旧插件的键分开存，避免两个插件互相覆盖对方的项目路径。 */
const PROJECT_KEY = 'dsh-plan-superagent.project'
const PROJECT_KEY_OLD = 'planboard.project'

/** 读面板的项目路径：优先新键；没有就从旧键搬一次（改名升级不丢用户已选的项目）。 */
function loadProject(): string {
  const v = localStorage.getItem(PROJECT_KEY)
  if (v != null) return v
  return localStorage.getItem(PROJECT_KEY_OLD) ?? ''
}

/**
 * 浏览器端的绝对路径判定（不能用 node:path）。
 * 面板要接受用户在本机填的项目根：Windows 下是 `C:\path`（或 `C:/path`），
 * POSIX 下是 `/path`。上游原实现只认 startsWith('/')，在 Windows 上等于永不成立。
 */
const ABS_PATH_RE = /^(?:[A-Za-z]:[\\/]|[\\/])/
function isAbsoluteProject(p: string): boolean {
  return ABS_PATH_RE.test(p)
}

interface BoardNode {
  id: string; type: 'module' | 'task'; parent: string | null; title: string
  status: string; deps: string[]; priority?: number
  acceptance?: string[]; scope?: string[]; evidence?: string[]; note?: string
  pos?: { x: number; y: number } | null
}
interface NodeDraft {
  fields?: { title?: string; note?: string; acceptance?: string[]; scope?: string[]; priority?: number; deps?: string[] }
  pos?: { x: number; y: number }
}
interface AddedNode { id: string; type: 'module' | 'task'; parent: string; title: string }
interface BoardData {
  board: {
    version: number; digest?: string
    plan: { name: string; goal: string }
    nodes: BoardNode[]
    pendingApprovals: { id: string; reason: string; ops: unknown[]; by: string; proposedAt: string }[]
    driftBlock: { taskId: string; reason: string; at: string } | null
  }
  order: Record<string, number>
  station: string | null
  guard?: { suspended: boolean; enforceScope: boolean }
  events: { ts: string; seq: number; kind: string; actor: string; payload?: { taskId?: string; tool?: string; path?: string; note?: string } }[]
}

/**
 * ===== 提案（待批 ops）的面板侧模型 =====
 * 服务端 applyOps 只认这五种形状（src/board/schema.ts）：
 *   { op:'init_board', name, goal }
 *   { op:'add_node', node:{ id, type, title, parent?, deps?, priority?, acceptance?, scope? } }
 *   { op:'update_node', id, fields:{ title?,note?,acceptance?,scope?,priority?,parent?,deps?,pos? } }
 *   { op:'remove_node', id }
 *   { op:'set_deps', id, deps }
 * 面板改内容时必须保持原形状 —— 形状错了服务端 applyOps 直接抛 UNKNOWN_OP。
 */
interface OpInit { op: 'init_board'; name: string; goal: string }
interface OpAdd {
  op: 'add_node'
  node: { id: string; type: 'module' | 'task'; title: string; parent: string | null; deps: string[]; priority: number | null; acceptance: string[]; scope: string[] }
}
interface OpUpd { op: 'update_node'; id: string; fields: Record<string, unknown> }
interface OpRem { op: 'remove_node'; id: string }
interface OpDeps { op: 'set_deps'; id: string; deps: string[] }
type PbOp = OpInit | OpAdd | OpUpd | OpRem | OpDeps

/** 依赖多选的候选项（板子上的节点 + 同提案新增的节点）。 */
interface DepOption { id: string; title: string; type: string }

/** 多行文本 -> 字符串数组（每行一条，去空行）。 */
function splitLines(s: string): string[] {
  return s.split('\n').map(x => x.trim()).filter(x => x !== '')
}

/** 宽松取字符串数组（服务端字段可能缺失或类型不对）。 */
function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** 宽松取数字（缺失 -> null：区分「没设优先级」与「优先级 0」）。 */
function numOr(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** update_node.fields 白名单归一化：只保留 applyOps 认识的键（status 故意不给 —— 服务端会抛）。 */
function normFields(v: unknown): Record<string, unknown> {
  const o = (v ?? {}) as Record<string, unknown>
  const out: Record<string, unknown> = {}
  if (typeof o.title === 'string') out.title = o.title
  if (typeof o.note === 'string') out.note = o.note
  if (Array.isArray(o.acceptance)) out.acceptance = strArr(o.acceptance)
  if (Array.isArray(o.scope)) out.scope = strArr(o.scope)
  if (typeof o.priority === 'number') out.priority = o.priority
  if ('parent' in o) out.parent = o.parent == null ? null : String(o.parent)
  if (Array.isArray(o.deps)) out.deps = strArr(o.deps)
  if ('pos' in o) out.pos = o.pos
  return out
}

/** 服务端 ops（unknown[]）-> 面板可编辑的强类型 ops；认不出的 op 直接丢弃。 */
function normOps(raw: unknown): PbOp[] {
  const out: PbOp[] = []
  if (!Array.isArray(raw)) return out
  for (const item of raw) {
    if (item == null || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const kind = String(o.op ?? '')
    if (kind === 'init_board') {
      out.push({ op: 'init_board', name: String(o.name ?? ''), goal: String(o.goal ?? '') })
    } else if (kind === 'add_node') {
      const n = (o.node ?? {}) as Record<string, unknown>
      out.push({
        op: 'add_node',
        node: {
          id: String(n.id ?? ''),
          type: n.type === 'task' ? 'task' : 'module',
          title: String(n.title ?? ''),
          parent: n.parent == null ? null : String(n.parent),
          deps: strArr(n.deps),
          priority: numOr(n.priority),
          acceptance: strArr(n.acceptance),
          scope: strArr(n.scope),
        },
      })
    } else if (kind === 'update_node') {
      out.push({ op: 'update_node', id: String(o.id ?? ''), fields: normFields(o.fields) })
    } else if (kind === 'remove_node') {
      out.push({ op: 'remove_node', id: String(o.id ?? '') })
    } else if (kind === 'set_deps') {
      out.push({ op: 'set_deps', id: String(o.id ?? ''), deps: strArr(o.deps) })
    }
  }
  return out
}

/** 单条 op 的比较键（字段顺序无关；只比较服务端真正会应用的字段）。 */
function canonOp(op: PbOp): string {
  if (op.op === 'init_board') return JSON.stringify(['init_board', op.name, op.goal])
  if (op.op === 'add_node') {
    return JSON.stringify(['add_node', op.node.id, op.node.type, op.node.title, op.node.parent,
      [...op.node.deps].sort(), op.node.priority, op.node.acceptance, op.node.scope])
  }
  if (op.op === 'update_node') {
    const f = op.fields
    return JSON.stringify(['update_node', op.id,
      f.title ?? null, f.note ?? null, f.acceptance ?? null, f.scope ?? null,
      f.priority ?? null, f.parent ?? null, f.deps ?? null, f.pos ?? null])
  }
  if (op.op === 'remove_node') return JSON.stringify(['remove_node', op.id])
  return JSON.stringify(['set_deps', op.id, [...op.deps].sort()])
}

/** 两组 ops 语义上是否不同（决定「确认生效」要不要带 ops 覆盖原提案）。 */
function opsChanged(a: PbOp[], b: PbOp[]): boolean {
  if (a.length !== b.length) return true
  for (let i = 0; i < a.length; i++) if (canonOp(a[i]) !== canonOp(b[i])) return true
  return false
}

/** 面板 op -> 回传服务端的线格式（形状必须与 applyOps 一致）。 */
function toWire(op: PbOp): Record<string, unknown> {
  if (op.op === 'init_board') return { op: 'init_board', name: op.name, goal: op.goal }
  if (op.op === 'add_node') {
    const node: Record<string, unknown> = {
      id: op.node.id, type: op.node.type, title: op.node.title,
      parent: op.node.parent, deps: op.node.deps,
      acceptance: op.node.acceptance, scope: op.node.scope,
    }
    if (op.node.priority != null) node.priority = op.node.priority
    return { op: 'add_node', node }
  }
  if (op.op === 'update_node') return { op: 'update_node', id: op.id, fields: op.fields }
  if (op.op === 'remove_node') return { op: 'remove_node', id: op.id }
  return { op: 'set_deps', id: op.id, deps: op.deps }
}

/** 提案应用后的依赖图（id -> deps）：板子现状 + 提案里的增删改。 */
function proposalDepGraph(base: { id: string; deps: string[] }[], ops: PbOp[]): Map<string, string[]> {
  const g = new Map<string, string[]>()
  for (const n of base) g.set(n.id, [...(n.deps ?? [])])
  for (const op of ops) {
    if (op.op === 'add_node') { g.set(op.node.id, [...op.node.deps]); continue }
    if (op.op === 'update_node') {
      const d = op.fields.deps
      if (Array.isArray(d)) g.set(op.id, [...(d as string[])])
      continue
    }
    if (op.op === 'set_deps') { g.set(op.id, [...op.deps]); continue }
    if (op.op === 'remove_node') {
      g.delete(op.id)
      for (const [k, v] of g) g.set(k, v.filter(x => x !== op.id))
    }
  }
  return g
}

/**
 * 提案里会不会依赖成环（返回成环路径，空串 = 无环）。
 * 服务端 lint 也会兜底，但前端先挡住：否则用户点「确认生效」才被服务端拒，现场很难看懂。
 */
function proposalCycle(base: { id: string; deps: string[] }[], ops: PbOp[]): string {
  const g = proposalDepGraph(base, ops)
  const items = [...g.entries()].map(([id, deps]) => ({ id, deps }))
  const byId = new Map(items.map(i => [i.id, i]))
  const color = new Map<string, number>()
  const stack: string[] = []
  // 用空数组当「没找到环」的哨兵：闭包里赋值时 TS 的控制流分析看不到赋值（null 哨兵会被收成 never）
  let cycle: string[] = []
  const dfs = (id: string): void => {
    if (cycle.length > 0) return
    const c = color.get(id)
    if (c === 2) return
    if (c === 1) { cycle = stack.slice(stack.indexOf(id)).concat([id]); return }
    color.set(id, 1)
    stack.push(id)
    for (const d of byId.get(id)?.deps ?? []) {
      if (!byId.has(d)) continue
      if (color.get(d) === 1) { cycle = stack.slice(stack.indexOf(d)).concat([d]); return }
      if (color.get(d) == null) dfs(d)
      if (cycle.length > 0) return
    }
    stack.pop()
    color.set(id, 2)
  }
  for (const i of items) { dfs(i.id); if (cycle.length > 0) break }
  return cycle.length === 0 ? '' : cycle.join(' -> ')
}

/**
 * 提案里 task 的父模块是否可解。
 * 删掉某个模块的 add_node，它名下的任务就成了孤儿 —— 服务端 applyOps 会抛 BAD_PARENT，前端先提醒。
 */
function proposalParentIssues(base: { id: string; type: string }[], ops: PbOp[]): string[] {
  const moduleIds = new Set<string>(base.filter(n => n.type === 'module').map(n => n.id))
  for (const op of ops) if (op.op === 'add_node' && op.node.type === 'module') moduleIds.add(op.node.id)
  const issues: string[] = []
  for (const op of ops) {
    if (op.op !== 'add_node' || op.node.type !== 'task') continue
    const p = op.node.parent
    if (p == null || !moduleIds.has(p)) issues.push('任务 ' + op.node.id + ' 的父模块 ' + (p ?? '(空)') + ' 不在板子/提案里 —— 批准会被服务端拒')
  }
  return issues
}

/** 依赖候选项合并（提案新增的节点覆盖板子里同 id 的旧标题）。 */
function mergeDepOptions(base: DepOption[], extra: DepOption[]): DepOption[] {
  const out = base.slice()
  for (const e of extra) {
    const i = out.findIndex(x => x.id === e.id)
    if (i >= 0) out[i] = e
    else out.push(e)
  }
  return out
}

/** 错误体 -> 可读文本（服务端两种形状：字符串 / {code,message}）。 */
function errText(e: unknown): string {
  if (e == null) return '未知错误'
  if (typeof e === 'string') return e
  if (typeof e === 'object') {
    const o = e as Record<string, unknown>
    if (typeof o.message === 'string') return o.message
    if (typeof o.code === 'string') return o.code
  }
  return String(e)
}

/** 安全读 JSON（404/网关可能回 HTML，抛 SyntaxError 对用户没意义）。 */
async function readJson(r: Response): Promise<Record<string, unknown>> {
  try { return await r.json() as Record<string, unknown> } catch { return { ok: false, error: 'HTTP ' + r.status + '：响应不是合法 JSON' } }
}

/** 文本截断（标签太长会把面板挤爆）。 */
function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

/**
 * ===== 子导图（<project>/.plan-board/designs/<taskId>.json）=====
 * 形状：{ summary, steps[], files[], risks[], tests[] }。
 * 读时容错：字段缺失补空、类型不对当空数组、多出来的未知字段原样留着（回写时不丢）。
 */
interface PbDesign {
  summary: string
  steps: string[]
  files: string[]
  risks: string[]
  tests: string[]
  /** 未知字段：原样带回，别在编辑时悄悄吃掉。 */
  extra: Record<string, unknown>
}

/** 子导图的规范字段名（其余都算「未知字段」）。 */
const DESIGN_FIELDS = ['summary', 'steps', 'files', 'risks', 'tests']

/** 任意 JSON → 规范形状（不崩：缺字段补空，类型不对当空，未知字段进 extra）。 */
function normDesign(raw: unknown): PbDesign {
  const o = (raw != null && typeof raw === 'object' && !Array.isArray(raw)) ? raw as Record<string, unknown> : {}
  const extra: Record<string, unknown> = {}
  for (const k of Object.keys(o)) if (!DESIGN_FIELDS.includes(k)) extra[k] = o[k]
  return {
    summary: typeof o.summary === 'string' ? o.summary : '',
    steps: strArr(o.steps),
    files: strArr(o.files),
    risks: strArr(o.risks),
    tests: strArr(o.tests),
    extra,
  }
}

/** 规范形状 → 回写形状（未知字段一起带回去）。 */
function designToWire(d: PbDesign): Record<string, unknown> {
  return {
    summary: d.summary,
    steps: d.steps,
    files: d.files,
    risks: d.risks,
    tests: d.tests,
    ...d.extra,
  }
}

/** 空的子导图（给「新建」用）。 */
function emptyDesign(): PbDesign {
  return { summary: '', steps: [], files: [], risks: [], tests: [], extra: {} }
}

/**
 * 任务的 note 里带 design-graph 指针 = 它有子导图。
 * 不用额外接口就能知道「有没有」，点开时再拉内容。
 */
function hasDesignPointer(note: string | undefined): boolean {
  return typeof note === 'string' && note.includes('design-graph:')
}

/**
 * ===== 计划板模式（原生对话框旁的开关） =====
 * 模式按会话存在服务端（会话重建、插件重启都不丢），前端只负责如实显示 + 切换。
 * 'plan' = 开发类需求先走计划板；'direct' = 按常规直接动手。
 */
type PbMode = 'plan' | 'direct'

/** 模式值归一：只认 'plan' / 'direct'，别的（缺字段/脏数据）当没有。 */
function normalizeMode(v: unknown): PbMode | null {
  return v === 'plan' || v === 'direct' ? v : null
}

/** 会话 id 归一（空串/缺失都算没有）。 */
function normalizeSessionId(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return s === '' ? null : s
}

/**
 * 会话 id 的取法。
 * 主路径：插槽注册里的 inject(sessionId) —— 宿主渲染输入栏时按会话注入，
 * 证据：宿主 slots 运行时的 runInject 会把 scope 绑定的 key（即会话 id）作为第一个实参传给 inject。
 * 兜底：URL 上的 session/sessionId 参数（宿主将来换路由也不至于瞎猜）。
 */
function resolveSessionId(prop: unknown, loc?: { search?: string; hash?: string }): string | null {
  const direct = normalizeSessionId(prop)
  if (direct != null) return direct
  try {
    const l = loc ?? (typeof window === 'undefined' ? null : window.location)
    if (l == null) return null
    const q = new URLSearchParams(l.search ?? '')
    const hash = (l.hash ?? '').replace(/^#/, '')
    const h = new URLSearchParams(hash)
    const path = /\/session\/([^/?#]+)/.exec(hash)
    return normalizeSessionId(q.get('session') ?? q.get('sessionId') ?? h.get('session') ?? h.get('sessionId') ?? (path == null ? null : path[1]))
  } catch { return null }
}

/** 开关文案：关 = 直改，开 = 计划板：开（一眼看出当前模式）。 */
function modeLabel(mode: PbMode): string {
  return mode === 'plan' ? '计划板：开' : '直改'
}

/** 点击切换的目标模式。 */
function nextMode(mode: PbMode): PbMode {
  return mode === 'plan' ? 'direct' : 'plan'
}

/**
 * POST /mode 的请求体。模式本身不放 localStorage（服务端按会话存）。
 * project 只是顺手带上：服务端现在的 /mode 分支排在 project 校验之后，不带会被 400 打回。
 */
function modeRequestBody(sessionId: string, mode: PbMode, project?: string): { sessionId: string; mode: PbMode; project?: string } {
  const body: { sessionId: string; mode: PbMode; project?: string } = { sessionId, mode }
  if (typeof project === 'string' && project !== '') body.project = project
  return body
}

/** 读响应里的模式值（错误体没有 mode）。 */
function parseMode(j: Record<string, unknown>): PbMode | null {
  return normalizeMode(j.mode)
}
const STATUS_COLOR: Record<string, string> = {
  planned: '#94a3b8', ready: '#3b82f6', doing: '#f59e0b',
  blocked: '#ef4444', done: '#10b981', canceled: '#6b7280',
}

/**
 * ===== 状态语义：颜色 + 形状 + 文字三重编码 =====
 * 只靠一个 6px 圆点，色盲看不出差别；现在三个通道一起给。
 */
interface StatusMeta { color: string; shape: string; label: string }
function statusMeta(status: string): StatusMeta {
  if (status === 'doing') return { color: STATUS_COLOR.doing, shape: '◐', label: '进行中' }
  if (status === 'ready') return { color: STATUS_COLOR.ready, shape: '◇', label: '就绪' }
  if (status === 'blocked') return { color: STATUS_COLOR.blocked, shape: '✕', label: '阻塞' }
  if (status === 'done') return { color: STATUS_COLOR.done, shape: '●', label: '完成' }
  if (status === 'canceled') return { color: STATUS_COLOR.canceled, shape: '—', label: '已取消' }
  return { color: STATUS_COLOR.planned, shape: '○', label: '待办' }
}

/**
 * ===== 导图拓扑（第 2 轮）=====
 * 导图要同时说清三件事：层级（模块→任务）、依赖（任务→任务）、状态（谁在做/谁被挡）。
 */
interface TopoNode {
  id: string
  type: string
  status: string
  title: string
  deps: string[]
  parent: string | null
  acceptance?: string[]
  priority?: number
}

/** 挡住我的那些前置任务（未完成/未取消的都算挡路）。 */
function unmetDepsOf(node: TopoNode, byId: Map<string, TopoNode>): string[] {
  return node.deps.filter(d => {
    const s = byId.get(d)
    return s != null && s.status !== 'done' && s.status !== 'canceled'
  })
}

/** 聚焦集合：主任务 + 它的上游依赖链（传递闭包）。其余节点只淡出、不隐藏。 */
function focusChain(nodes: TopoNode[], primaryId: string | null): Set<string> {
  const out = new Set<string>()
  if (primaryId == null) return out
  const byId = new Map(nodes.map(n => [n.id, n]))
  const walk = (id: string): void => {
    if (out.has(id)) return
    const n = byId.get(id)
    if (n == null) return
    out.add(id)
    for (const d of n.deps) walk(d)
  }
  walk(primaryId)
  return out
}

/** 模块进度：完成数 / 总数（折叠时显示「模块名 · 3/5 完成」）。 */
function moduleProgress(nodes: TopoNode[], moduleId: string): { done: number; total: number } {
  const kids = nodes.filter(n => n.type === 'task' && n.parent === moduleId)
  return { done: kids.filter(k => k.status === 'done' || k.status === 'canceled').length, total: kids.length }
}

/** 下一步可以做什么：ready 且依赖都满足的任务。 */
function nextSteps(nodes: TopoNode[]): TopoNode[] {
  const byId = new Map(nodes.map(n => [n.id, n]))
  return nodes.filter(n => n.type === 'task' && n.status === 'ready' && unmetDepsOf(n, byId).length === 0)
}

/** 「为什么还没轮到我」：挡住某个任务的前置任务（按拓扑序）。 */
function blockersOf(nodes: TopoNode[], taskId: string | null, order: Record<string, number>): TopoNode[] {
  if (taskId == null) return []
  const byId = new Map(nodes.map(n => [n.id, n]))
  const target = byId.get(taskId)
  if (target == null) return []
  return unmetDepsOf(target, byId)
    .map(id => byId.get(id))
    .filter((n): n is TopoNode => n != null)
    .sort((a, b) => (order[a.id] ?? 999) - (order[b.id] ?? 999))
}

/** 验收标准摘要（第一条 + 剩余条数）。 */
/** ===== 面板分区（tab）===== */
type PbTab = 'map' | 'approvals' | 'tasks' | 'events'
const TAB_ORDER: PbTab[] = ['map', 'approvals', 'tasks', 'events']

/** tab 的标题与计数（计数为 0 时置灰）。 */
function tabMeta(tab: PbTab, counts: Record<PbTab, number>): { id: PbTab; label: string; count: number } {
  const labels: Record<PbTab, string> = { map: '导图', approvals: '待批', tasks: '任务', events: '事件' }
  return { id: tab, label: labels[tab], count: counts[tab] ?? 0 }
}

/** ←/→ 切 tab（到头就停住，不循环：循环会让"按了没反应"变成"莫名其妙换了页"）。 */
function nextTab(tab: PbTab, dir: 1 | -1): PbTab {
  const i = TAB_ORDER.indexOf(tab)
  const j = i + dir
  if (j < 0 || j >= TAB_ORDER.length) return tab
  return TAB_ORDER[j]
}

/** 数字键 1-4 直达。 */
function tabByNumber(n: number): PbTab | null {
  if (!Number.isInteger(n) || n < 1 || n > TAB_ORDER.length) return null
  return TAB_ORDER[n - 1]
}

/**
 * 任务清单：按模块分组，可按 状态 / 优先级 / 依赖 排序。
 * 排序放在纯函数里（渲染里排序会每次重排，且不好测）。
 */
function taskRows(nodes: TopoNode[], order: Record<string, number>, sortBy: 'status' | 'priority' | 'deps'): { moduleId: string | null; moduleTitle: string; tasks: TopoNode[] }[] {
  const tasks = nodes.filter(n => n.type === 'task')
  const modules = nodes.filter(n => n.type === 'module')
  const groups: { moduleId: string | null; moduleTitle: string; tasks: TopoNode[] }[] = modules.map(m => ({
    moduleId: m.id, moduleTitle: m.title, tasks: tasks.filter(t => t.parent === m.id),
  }))
  const loose = tasks.filter(t => t.parent == null || !modules.some(m => m.id === t.parent))
  if (loose.length > 0) groups.push({ moduleId: null, moduleTitle: '未分组', tasks: loose })
  const rank: Record<string, number> = { doing: 0, ready: 1, blocked: 2, planned: 3, done: 4, canceled: 5 }
  for (const g of groups) {
    g.tasks.sort((a, b) => {
      if (sortBy === 'priority') return (a.priority ?? 3) - (b.priority ?? 3) || (order[a.id] ?? 999) - (order[b.id] ?? 999)
      if (sortBy === 'deps') return (b.deps?.length ?? 0) - (a.deps?.length ?? 0) || (order[a.id] ?? 999) - (order[b.id] ?? 999)
      return (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || (order[a.id] ?? 999) - (order[b.id] ?? 999)
    })
  }
  return groups
}
function acceptanceSummary(task: { acceptance?: string[] }): string {
  const a = task.acceptance ?? []
  if (a.length === 0) return '（没有写验收标准）'
  const first = a[0]
  return a.length > 1 ? first + '（+' + (a.length - 1) + ' 条）' : first
}

/**
 * ===== 导图度量与布局（第 3 轮：tidy tree + 画布质感）=====
 * SVG 里拿不到 CSS 变量，这些常量与第 1 轮的令牌同值（--pb-sp-12 = 12 等）。
 */
const MAP = {
  pad: 12,        // 分组块内边距（--pb-sp-12）
  gap: 14,        // 任务卡之间的垂直间隙（>= 12，任务别挤成一条线）
  cardH: 46,      // 任务卡高度（两行文字 + 内边距）
  cardW: 250,     // 任务卡宽度
  titleH: 26,     // 模块标题条高度
  modGap: 34,     // 模块块之间的水平间距
  rootW: 150,
  rootH: 38,
  originX: 28,
  originY: 24,
  rootGap: 54,    // 根节点到模块层的距离
}

interface MapBox { id: string; x: number; y: number; w: number; h: number }
interface MapGroup { id: string; x: number; y: number; w: number; h: number }
interface MapLayout {
  items: MapBox[]
  groups: MapGroup[]
  /** 层级边：from = 父（根/模块），to = 子（任务）。 */
  edges: { from: string; to: string }[]
  totalW: number
  totalH: number
}

/** tidy tree 的节点（w = 自身宽度；children 参与子树宽度计算）。 */
interface TidyNode { id: string; w: number; children: TidyNode[]; subtreeW?: number }

/**
 * tidy tree（Reingold–Tilford 的简化版，d3-hierarchy 的核心思路）：
 * ① 后序遍历算出每棵子树的宽度（子宽度之和 + 兄弟间距，且不小于自身宽度）；
 * ② 前序遍历按宽度切分横轴，**父节点取子节点区间的中点** → 父居中、兄弟等距、子树不重叠。
 * 不引 d3：自己写这 60 行就够，还能避免把 React 18 的 bundle 拖进依赖。
 */
function tidyTree(root: TidyNode, gapX: number): Map<string, { x: number; width: number }> {
  const measure = (n: TidyNode): number => {
    if (n.children.length === 0) { n.subtreeW = n.w; return n.w }
    let total = 0
    for (const c of n.children) total += measure(c) + gapX
    n.subtreeW = Math.max(n.w, total - gapX)
    return n.subtreeW
  }
  const out = new Map<string, { x: number; width: number }>()
  const place = (n: TidyNode, left: number): void => {
    const width = n.subtreeW ?? n.w
    out.set(n.id, { x: left + width / 2, width })
    let cursor = left
    for (const c of n.children) { place(c, cursor); cursor += (c.subtreeW ?? c.w) + gapX }
    // 父节点取**第一个与最后一个子节点的中点**（经典 tidy tree）：子树的宽度可以不同，
    // 按"自己占的那段"居中会让父节点偏离孩子的中线，看着歪。
    if (n.children.length === 1) {
      out.set(n.id, { x: out.get(n.children[0].id)!.x, width })
    } else if (n.children.length > 1) {
      const first = out.get(n.children[0].id)!.x
      const last = out.get(n.children[n.children.length - 1].id)!.x
      out.set(n.id, { x: (first + last) / 2, width })
    }
  }
  measure(root)
  place(root, 0)
  return out
}

/**
 * 分层树布局：
 *  - 模块层用 tidy tree 横向排开（父=计划名居中于所有模块之上）；
 *  - 每个模块是一个圆角分组块，任务卡在块内纵向堆叠（多的时候两列），模块标题居中于自己的任务组。
 */
function layoutMap(nodes: { id: string; type: string; title: string; parent: string | null; pos?: { x: number; y: number } | null }[], folded: Record<string, boolean>): MapLayout {
  const items: MapBox[] = []
  const groups: MapGroup[] = []
  const edges: { from: string; to: string }[] = []
  const modules = nodes.filter(n => n.type === 'module')

  // 1) 每个模块块：先把任务卡在块内排好，得出块宽/块高
  const blockOf = new Map<string, { w: number; h: number; tasks: { id: string; x: number; y: number }[] }>()
  for (const m of modules) {
    const kids = folded[m.id] === true ? [] : nodes.filter(n => n.type === 'task' && n.parent === m.id)
    const cols = kids.length > 3 ? 2 : 1
    const rows = Math.max(1, Math.ceil(kids.length / cols))
    const innerW = cols === 1 ? MAP.cardW : MAP.cardW * cols + MAP.gap * (cols - 1)
    const w = innerW + MAP.pad * 2
    const h = MAP.pad + MAP.titleH + rows * MAP.cardH + Math.max(0, rows - 1) * MAP.gap + MAP.pad
    const tasks = kids.map((t, i) => {
      const col = i % cols
      const row = Math.floor(i / cols)
      return { id: t.id, x: MAP.pad + col * (MAP.cardW + MAP.gap), y: MAP.pad + MAP.titleH + row * (MAP.cardH + MAP.gap) }
    })
    blockOf.set(m.id, { w, h, tasks })
  }

  // 2) 模块层交给 tidy tree（叶子 = 模块块）
  const tidyRoot: TidyNode = {
    id: '__root__',
    w: MAP.rootW,
    children: modules.map(m => ({ id: m.id, w: blockOf.get(m.id)?.w ?? MAP.cardW, children: [] })),
  }
  const places = tidyTree(tidyRoot, MAP.modGap)
  const rootPlace = places.get('__root__')
  const rootX = MAP.originX + (rootPlace?.x ?? 0)
  const rootY = MAP.originY
  const moduleY = rootY + MAP.rootH + MAP.rootGap

  items.push({ id: '__root__', x: rootX, y: rootY, w: MAP.rootW, h: MAP.rootH })
  for (const m of modules) {
    const blk = blockOf.get(m.id)
    if (blk == null) continue
    const place = places.get(m.id)
    const bx = MAP.originX + (place?.x ?? 0)
    // 模块标题：水平居中于自己的任务组（父在子上居中）
    const titleW = 190
    items.push({ id: m.id, x: bx + (blk.w - titleW) / 2, y: moduleY + MAP.pad, w: titleW, h: MAP.titleH })
    groups.push({ id: m.id, x: bx, y: moduleY, w: blk.w, h: blk.h })
    for (const t of blk.tasks) {
      items.push({ id: t.id, x: bx + t.x, y: moduleY + t.y, w: MAP.cardW, h: MAP.cardH })
    }
    edges.push({ from: '__root__', to: m.id })
    for (const t of blk.tasks) edges.push({ from: m.id, to: t.id })
  }

  // 3) 手动拖过的节点保持自己的位置（不参与自动排布）
  let maxX = 0, maxY = 0
  for (const it of items) { maxX = Math.max(maxX, it.x + it.w); maxY = Math.max(maxY, it.y + it.h) }
  for (const n of nodes) {
    if (n.pos == null) continue
    const box = items.find(i => i.id === n.id)
    if (box == null) continue
    box.x = n.pos.x
    box.y = n.pos.y
    maxX = Math.max(maxX, box.x + box.w)
    maxY = Math.max(maxY, box.y + box.h)
  }
  return { items, groups, edges, totalW: maxX + MAP.originX, totalH: maxY + MAP.originX }
}

/** 层级边：父底部 → 子顶部的平滑 S 曲线（近父略粗、末端渐细用渐变近似）。 */
function hierarchyPath(from: MapBox, to: MapBox): string {
  const x1 = from.x + from.w / 2, y1 = from.y + from.h
  const x2 = to.x + to.w / 2, y2 = to.y
  const dy = Math.max(20, (y2 - y1) / 2)
  return 'M ' + x1 + ' ' + y1 + ' C ' + x1 + ' ' + (y1 + dy) + ' ' + x2 + ' ' + (y2 - dy) + ' ' + x2 + ' ' + y2
}

/**
 * 依赖边：绕到卡片左侧的圆角折线（不穿过卡片）。
 * 直走会从卡片中间穿过去，看着像一团乱麻；绕左侧 + 圆角更像"关系线"。
 */
function dependencyPath(from: MapBox, to: MapBox): string {
  const sx = from.x, sy = from.y + from.h / 2
  const tx = to.x, ty = to.y + to.h / 2
  const r = 10
  const out = 30
  const dir = ty >= sy ? 1 : -1
  const lx = sx - out
  return 'M ' + sx + ' ' + sy
    + ' H ' + (lx + r)
    + ' Q ' + lx + ' ' + sy + ' ' + lx + ' ' + (sy + dir * r)
    + ' V ' + (ty - dir * r)
    + ' Q ' + lx + ' ' + ty + ' ' + (lx + r) + ' ' + ty
    + ' H ' + tx
}

/** 一键适应画布：缩放 + 居中（用户不用拿滚轮硬调）。 */
function fitView(layout: { items: MapBox[] }, box: { w: number; h: number }, pad = 24): { k: number; tx: number; ty: number } {
  if (layout.items.length === 0 || box.w <= 0 || box.h <= 0) return { k: 1, tx: 0, ty: 0 }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const i of layout.items) {
    minX = Math.min(minX, i.x); minY = Math.min(minY, i.y)
    maxX = Math.max(maxX, i.x + i.w); maxY = Math.max(maxY, i.y + i.h)
  }
  const cw = Math.max(1, maxX - minX)
  const ch = Math.max(1, maxY - minY)
  const k = Math.min(1.6, Math.max(0.35, Math.min((box.w - pad * 2) / cw, (box.h - pad * 2) / ch)))
  return { k, tx: (box.w - cw * k) / 2 - minX * k, ty: (box.h - ch * k) / 2 - minY * k }
}

/** ===== 聚焦卡：算出「现在该做什么」 ===== */
interface FocusNode { id: string; type: string; status: string; title: string; deps: string[] }
interface FocusPick {
  kind: 'doing' | 'ready' | 'blocked' | 'idle'
  taskId: string | null
  title: string
  detail: string
  hint: string
}

/**
 * 优先级：进行中的任务 > 下一个就绪任务 > 被依赖挡住的说明 > 空闲。
 * 「下一个就绪」按板上的拓扑序号取最靠前的那个。
 */
function pickFocus(nodes: FocusNode[], order: Record<string, number>): FocusPick {
  const tasks = nodes.filter(n => n.type === 'task')
  const byId = new Map(tasks.map(n => [n.id, n]))
  const rank = (a: FocusNode, b: FocusNode): number => (order[a.id] ?? 999) - (order[b.id] ?? 999)
  const doing = tasks.filter(n => n.status === 'doing').sort(rank)[0]
  if (doing != null) return { kind: 'doing', taskId: doing.id, title: doing.title, detail: '正在做：' + doing.title, hint: '这项做完再接下一件' }
  const ready = tasks.filter(n => n.status === 'ready').sort(rank)[0]
  if (ready != null) return { kind: 'ready', taskId: ready.id, title: ready.title, detail: '下一个就绪：' + ready.title, hint: '依赖都满足了，可以开工' }
  const unmetOf = (n: FocusNode): string[] => n.deps.filter(d => {
    const s = byId.get(d)
    return s != null && s.status !== 'done' && s.status !== 'canceled'
  })
  const blocked = tasks.filter(n => n.status === 'planned' && unmetOf(n).length > 0).sort(rank)[0]
  if (blocked != null) {
    const names = unmetOf(blocked).map(d => byId.get(d)?.title ?? d)
    return { kind: 'blocked', taskId: blocked.id, title: blocked.title, detail: '被 ' + names.join('、') + ' 挡住', hint: '先把前置任务做完' }
  }
  if (tasks.length === 0) return { kind: 'idle', taskId: null, title: '', detail: '板上还没有任务', hint: '用 plan_generate 生成一张任务树' }
  return { kind: 'idle', taskId: null, title: '', detail: '没有进行中或就绪的任务', hint: '看看待批提案，或等 Agent 派单' }
}

/** ===== 空态：每种空态一句可操作的话（不是空白）===== */
function emptyCopy(kind: 'board' | 'tasks' | 'approvals' | 'events'): { title: string; hint: string } {
  if (kind === 'board') return { title: '这个项目下还没有 .plan-board', hint: '让 Agent 跑 plan_edit init_board 起板，或生成一张任务树' }
  if (kind === 'tasks') return { title: '板上还没有任务', hint: '用 plan_generate 生成「计划 → 模块 → 任务」三层结构' }
  if (kind === 'approvals') return { title: '没有待批提案', hint: '一切已批准，直接看导图开工' }
  return { title: '还没有事件', hint: '板上的动作会按时间记在这里（审计用）' }
}

/** ===== 快捷键（克制，只这 4 个）===== */
type PbShortcut = 'focus-search' | 'refresh' | 'focus-map' | 'close-editor'
/** 输入框里只认 Esc（关掉编辑卡）；其余键交给输入框自己。 */
function shortcutOf(key: string, inField: boolean): PbShortcut | null {
  if (key === 'Escape') return 'close-editor'
  if (inField) return null
  if (key === '/') return 'focus-search'
  if (key === 'r' || key === 'R') return 'refresh'
  if (key === 'g' || key === 'G') return 'focus-map'
  return null
}

/**
 * 宿主主区面板 id。
 *
 * main 是 keyed 槽（key = 面板 id），sidebar.panellist 是 list 槽（id = 同一个面板 id）：
 * 宿主靠这个 id 把侧栏图标和主区面板对上（layout.selectPanel 找不到同名的 main 面板会抛
 * "main panel X is not registered"），所以两处必须同一个字符串。
 * 它与引擎的 'dsh-superagent'、旧插件的 'dsh-plan-board' 都不撞，全宿主唯一。
 */
const PANEL_ID = NS

/** 侧栏图标的显示名（locale 字典；zh/en 同名，PlanBoard 是产品名不翻译）。 */
const LOCALE_DICT = {
  zh: { panel: 'PlanBoard' },
  en: { panel: 'PlanBoard' },
}

/** 主题跟随：采样 app body 实际背景亮度；异常时退回系统偏好。 */
function appDark(): boolean {
  try {
    const bg = getComputedStyle(document.body).backgroundColor
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(bg)
    if (m != null) {
      const lum = (0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3])) / 255
      return lum < 0.5
    }
  } catch { /* 采样失败走系统偏好 */ }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
}

const CSS = [
  // 面板住在宿主**主区**（main 槽 keyed）：宿主自己排版，不盖对话区（用户不接受 UI 挡住操作面）
  // ===== 设计系统：字号阶梯 / 间距节奏 / 圆角 / 阴影 / 状态色，全部走变量 =====
  '.pb-panel{--pb-bg:#f8fafc;--pb-ink:#0f172a;--pb-line:#e2e8f0;--pb-card:#ffffff;--pb-muted:#64748b;',
  '--pb-fs-11:11px;--pb-fs-12:12px;--pb-fs-13:13px;--pb-fs-15:15px;--pb-fs-18:18px;',
  '--pb-sp-4:4px;--pb-sp-8:8px;--pb-sp-12:12px;--pb-sp-16:16px;--pb-sp-24:24px;',
  '--pb-r-6:6px;--pb-r-8:8px;--pb-r-10:10px;',
  '--pb-shadow-1:0 1px 2px rgba(15,23,42,.06);--pb-shadow-2:0 8px 24px rgba(15,23,42,.14);',
  '--pb-st-planned:#94a3b8;--pb-st-ready:#3b82f6;--pb-st-doing:#f59e0b;--pb-st-blocked:#ef4444;--pb-st-done:#10b981;--pb-st-canceled:#6b7280;',
  'position:relative;width:100%;height:100%;min-height:0;display:flex;flex-direction:column;overflow:hidden;',
  'background:var(--pb-bg);color:var(--pb-ink);border-left:1px solid var(--pb-line)}',
  '.pb-panel[data-collapsed] .pb-body{display:none}',
  '.pb-panel[data-mode="dark"]{--pb-bg:#0f141c;--pb-ink:#e2e8f0;--pb-line:#1e293b;--pb-card:#151b26;--pb-muted:#7c8798}',
  '.pb-head{display:flex;gap:8px;align-items:center;padding:10px 12px;border-bottom:1px solid var(--pb-line)}',
  '.pb-title{font-weight:700;font-size:var(--pb-fs-13);letter-spacing:.4px}',
  '.pb-input{flex:1;min-width:0;font:12px/1.4 ui-monospace,monospace;padding:5px 8px;border-radius:8px;',
  'border:1px solid var(--pb-line);background:var(--pb-card);color:var(--pb-ink)}',
  '.pb-btn{cursor:pointer;padding:5px 12px;border-radius:8px;font-size:var(--pb-fs-12);font-weight:600;',
  'border:1px solid var(--pb-line);background:var(--pb-card);color:var(--pb-ink)}',
  '.pb-btn:hover{filter:brightness(1.08)}',
  '.pb-btn.pb-ok{background:#10b981;border-color:#10b981;color:#fff}',
  '.pb-btn.pb-no{background:#ef4444;border-color:#ef4444;color:#fff}',
  '.pb-btn.pb-vio{background:#8b5cf6;border-color:#8b5cf6;color:#fff}',
  '.pb-btn:disabled{opacity:.5;cursor:not-allowed}',
  '.pb-body{flex:1;min-height:0;overflow:auto;padding:10px 12px;display:flex;flex-direction:column;gap:10px}',
  '.pb-banner{padding:8px 12px;border-radius:10px;font-size:var(--pb-fs-12);font-weight:600;display:flex;gap:8px;align-items:center}',
  '.pb-banner.pb-drift{background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.5);color:#ef4444}',
  '.pb-banner.pb-appr{background:rgba(245,158,11,.10);border:1px solid rgba(245,158,11,.45);color:#b45309}',
  '[data-mode="dark"] .pb-banner.pb-appr{color:#fbbf24}',
  '.pb-banner.pb-guard{background:rgba(139,92,246,.10);border:1px solid rgba(139,92,246,.5);color:#7c3aed}',
  '[data-mode="dark"] .pb-banner.pb-guard{color:#a78bfa}',
  '.pb-banner.pb-hold{background:rgba(100,116,139,.10);border:1px dashed rgba(100,116,139,.55);color:#64748b}',
  '[data-mode="dark"] .pb-banner.pb-hold{color:#94a3b8}',
  '.pb-banner.pb-dirty{background:rgba(245,158,11,.14);border:1px solid rgba(245,158,11,.6);color:#b45309;position:sticky;top:0;z-index:5}',
  '[data-mode="dark"] .pb-banner.pb-dirty{color:#fbbf24}',
  '.pb-card{background:var(--pb-card);border:1px solid var(--pb-line);border-radius:10px;padding:8px 10px;font-size:var(--pb-fs-12)}',
  '.pb-sec{font-size:var(--pb-fs-11);font-weight:700;letter-spacing:1px;color:var(--pb-muted);text-transform:uppercase}',
  '.pb-ev{display:flex;gap:8px;font:11px ui-monospace,monospace;color:var(--pb-muted);padding:1px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.pb-station{animation:pb-pulse 1.6s ease-in-out infinite}',
  '@keyframes pb-pulse{0%,100%{opacity:.35}50%{opacity:1}}',
  // flex:0 0 auto —— 面板 body 是 flex column，导图必须拒绝被编辑卡挤扁（M2-3 验收 P1 修复）
  '.pb-map{flex:0 0 auto;position:relative;background:var(--pb-card);border:1px solid var(--pb-line);border-radius:12px;overflow:hidden;cursor:grab}',
  '.pb-map text{font-family:ui-sans-serif,system-ui,sans-serif;fill:var(--pb-ink,#0f172a)}',
  '.pb-node{cursor:grab}',
  '.pb-node.pb-dragging{cursor:grabbing}',
  '.pb-handle{cursor:crosshair}',
  '.pb-hint{font-size:var(--pb-fs-11);color:var(--pb-muted);line-height:1.6}',
  '.pb-form{display:flex;flex-direction:column;gap:8px}',
  '.pb-form label{display:flex;flex-direction:column;gap:3px;font-size:var(--pb-fs-11);font-weight:600;color:var(--pb-muted)}',
  '.pb-form input,.pb-form textarea,.pb-form select{font:12px/1.5 ui-sans-serif,system-ui,sans-serif;padding:5px 8px;border-radius:8px;',
  'border:1px solid var(--pb-line);background:var(--pb-bg);color:var(--pb-ink)}',
  '.pb-form textarea{min-height:44px;resize:vertical;font:12px/1.5 ui-monospace,monospace}',
  '.pb-deprow{display:flex;align-items:center;gap:6px;font-size:var(--pb-fs-12);padding:2px 0}',
  '.pb-dot{width:6px;height:6px;border-radius:50%;background:#f59e0b;display:inline-block}',
  // ===== 入口按钮（A 极光玻璃 + C 能量核心）：高度 31px、圆角 999px，与「Android 面板」严格对齐 =====
  // 深色极光玻璃（两种主题同款，对齐概念稿 A）：内层近黑玻璃(padding-box) + 外层青→紫→洋红渐变描边(border-box)
  // 收起/展开：本按钮在 headerUtilities 里是流内 flex item（右邻「⋯ 更多操作」保持 8px 槽位间距），
  // 因此宽度变化只会向左生长——右缘天然固定，邻居变化时实时重排。
  'position:relative;display:inline-flex;align-items:center;gap:0;box-sizing:border-box;height:31px;padding:0 5.5px;',
  'border-radius:15.5px;cursor:pointer;overflow:hidden;user-select:none;vertical-align:middle;line-height:1;',
  'font-size:12.5px;font-weight:600;letter-spacing:.2px;color:#f3f7ff;border:1px solid transparent;',
  'background:linear-gradient(135deg,#080b14 0%,#0b0918 55%,#120a20 100%) padding-box,linear-gradient(112deg,#22d3ee 0%,#38bdf8 24%,#8b5cf6 58%,#e879f9 100%) border-box;',
  'box-shadow:0 0 0 1px rgba(139,92,246,.20),0 2px 12px rgba(56,189,248,.30),0 2px 18px rgba(232,121,249,.24),inset 0 0 14px rgba(124,58,237,.35),inset 0 1px 0 rgba(255,255,255,.07);',
  'transition:transform .16s cubic-bezier(.34,1.56,.64,1),box-shadow .28s,filter .28s,padding var(--pb-dur) var(--pb-ease),border-radius var(--pb-dur) var(--pb-ease)}',
  // 状态色（收起态只剩图标时靠它继续传达站位语义：图标光晕 + 悬停时的状态点）
  'background:radial-gradient(58% 120% at 12% 18%,rgba(34,211,238,.36),transparent 62%),radial-gradient(52% 128% at 88% 30%,rgba(232,121,249,.32),transparent 64%),radial-gradient(72% 140% at 50% 128%,rgba(139,92,246,.32),transparent 66%)}',
  // 流光描边环：conic 渐变 + mask 挖空成 1px 环，悬停/开启时旋转
  'background:conic-gradient(from 0deg,transparent 0 40%,rgba(34,211,238,.95) 58%,rgba(139,92,246,1) 72%,rgba(232,121,249,.95) 86%,transparent 100%);',
  '-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;',
  'mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);mask-composite:exclude}',
  '@keyframes pb-ring-spin{to{transform:rotate(360deg)}}',
  'background:linear-gradient(100deg,transparent,rgba(255,255,255,.55),transparent);transform:skewX(-18deg)}',
  '@keyframes pb-shine{0%{left:-65%;opacity:.9}100%{left:135%;opacity:0}}',
  // 能量核心图标（C）：轨道虚线流动 + 双卫星脉冲 + 核心呼吸
  'transition:transform .2s cubic-bezier(.34,1.56,.64,1)}',
  '@keyframes pb-core{0%,100%{transform:scale(1);opacity:.92}50%{transform:scale(1.18);opacity:1}}',
  '@keyframes pb-dash{to{stroke-dashoffset:-14}}',
  '@keyframes pb-sat{0%,100%{transform:scale(.72);opacity:.5}50%{transform:scale(1.15);opacity:1}}',
  'opacity:0;transition:opacity .25s,background .25s,box-shadow .25s}',
  '@keyframes pb-dot{0%,100%{opacity:1}50%{opacity:.45}}',
  'box-shadow:0 0 0 1px rgba(168,85,247,.45),0 6px 26px rgba(124,58,237,.55),0 0 26px rgba(56,189,248,.40),0 0 30px rgba(232,121,249,.32),inset 0 0 18px rgba(124,58,237,.45)}',
  'box-shadow:0 1px 6px rgba(99,102,241,.4),inset 0 1px 0 rgba(255,255,255,.12)}',
  '@keyframes pb-aurora{0%,100%{opacity:.8;filter:saturate(1)}50%{opacity:1;filter:saturate(1.35)}}',
  '.pb-projrow{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:6px 12px;border-bottom:1px solid var(--pb-line);font-size:var(--pb-fs-11);color:var(--pb-muted)}',
  '.pb-projpath{font-family:ui-monospace,monospace;font-size:var(--pb-fs-11);color:var(--pb-ink);cursor:pointer;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.pb-tag{cursor:pointer;padding:2px 8px;border-radius:999px;font-size:var(--pb-fs-11);border:1px solid var(--pb-line);background:var(--pb-card);color:var(--pb-muted);max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.pb-tag.pb-on{border-color:#8b5cf6;color:#7c3aed;background:rgba(139,92,246,.12)}',
  '[data-mode="dark"] .pb-tag.pb-on{color:#a78bfa}',
  '.pb-tag:hover{filter:brightness(1.08)}',
  // 模式开关挂在宿主输入栏里（不在面板内），所以样式自带颜色：紫色主题 + color:inherit 跟随宿主文字色
  // 模式开关：纯图标 20×20，不占文字宽度；状态用颜色表达（灰=直改，紫=计划板）。
  // 不定位、不展开 —— 输入区一个像素都不动。
  '.pb-modewrap{display:inline-flex;align-items:center;flex:0 0 auto;gap:0}',
  '.pb-modebtn{cursor:pointer;width:20px;height:20px;min-width:20px;flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;',
  'padding:0;border-radius:999px;border:1px solid transparent;background:transparent;color:inherit;opacity:.7}',
  '.pb-modebtn:hover{opacity:1;background:rgba(139,92,246,.14)}',
  '.pb-modebtn:focus-visible{outline:2px solid rgba(139,92,246,.7);outline-offset:1px}',
  '.pb-modebtn.pb-on{background:#8b5cf6;border-color:#8b5cf6;color:#fff;opacity:1;box-shadow:0 0 0 1px rgba(139,92,246,.3)}',
  '.pb-modebtn.pb-err{border-color:#ef4444}',
  '.pb-modebtn:disabled{opacity:.35;cursor:not-allowed}',
  '.pb-ops{border:1px dashed var(--pb-line);border-radius:8px;padding:6px;margin:6px 0;display:flex;flex-direction:column;gap:6px;background:rgba(100,116,139,.05)}',
  '.pb-oprow{border:1px solid var(--pb-line);border-radius:8px;padding:6px;display:flex;flex-direction:column;gap:5px;background:var(--pb-card)}',
  '.pb-ophead{display:flex;align-items:center;gap:6px;font-size:var(--pb-fs-11);font-weight:700;color:var(--pb-muted)}',
  '.pb-chip{font:10px/1.4 ui-monospace,monospace;padding:1px 6px;border-radius:999px;background:rgba(139,92,246,.12);color:#7c3aed}',
  '[data-mode="dark"] .pb-chip{color:#a78bfa}',
  '.pb-oplabel{display:flex;flex-direction:column;gap:2px;font-size:10px;font-weight:600;color:var(--pb-muted)}',
  '.pb-oplabel input,.pb-oplabel textarea,.pb-oplabel select{font:11px/1.5 ui-sans-serif,system-ui,sans-serif;padding:3px 6px;border-radius:6px;border:1px solid var(--pb-line);background:var(--pb-bg);color:var(--pb-ink)}',
  '.pb-oplabel textarea{min-height:38px;resize:vertical;font:11px/1.5 ui-monospace,monospace}',
  '.pb-deps{display:flex;flex-direction:column;gap:2px;max-height:150px;overflow:auto;border:1px solid var(--pb-line);border-radius:6px;padding:4px;background:var(--pb-bg)}',
  '.pb-deps .pb-deprow{font-size:var(--pb-fs-11)}',
  '.pb-cycle{font-size:var(--pb-fs-11);font-weight:700;color:#ef4444;line-height:1.5}',
  // ===== 第 4 轮：tab 化 =====
  '.pb-tabs{display:flex;gap:var(--pb-sp-4);align-items:stretch;padding:0 var(--pb-sp-16);border-bottom:1px solid var(--pb-line);background:var(--pb-card);position:sticky;top:0;z-index:4;overflow-x:auto}',
  '.pb-tab{display:inline-flex;align-items:center;gap:var(--pb-sp-4);cursor:pointer;padding:var(--pb-sp-8) var(--pb-sp-12);border:none;background:transparent;color:var(--pb-muted);font-size:var(--pb-fs-13);font-weight:600;border-bottom:2px solid transparent;white-space:nowrap}',
  '.pb-tab:hover{color:var(--pb-ink)}',
  '.pb-tab-on{color:var(--pb-ink);border-bottom-color:#8b5cf6}',
  '.pb-tab:focus-visible{outline:2px solid #8b5cf6;outline-offset:-2px;border-radius:var(--pb-r-6)}',
  '.pb-badge-dim{opacity:.45}',
  '.pb-tabbody{padding:var(--pb-sp-12) var(--pb-sp-16);display:flex;flex-direction:column;gap:var(--pb-sp-12);flex:1;min-height:0;overflow:auto}',
  '.pb-tablist{display:flex;flex-direction:column;gap:var(--pb-sp-8)}',
  '.pb-tasks{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:var(--pb-sp-12);align-items:start}',
  '.pb-tasklist{display:flex;flex-direction:column;gap:var(--pb-sp-8);min-width:0}',
  '.pb-tasklist-head{display:flex;align-items:center;gap:var(--pb-sp-8);justify-content:space-between}',
  '.pb-sortbar{display:flex;gap:var(--pb-sp-4)}',
  '.pb-canvasbtn-on{border-color:#8b5cf6;color:#7c3aed;background:rgba(139,92,246,.12)}',
  '.pb-taskgroup{display:flex;flex-direction:column;gap:var(--pb-sp-4);margin-bottom:var(--pb-sp-8)}',
  '.pb-taskgroup-title{font-size:var(--pb-fs-12);font-weight:700;color:var(--pb-muted);letter-spacing:.3px}',
  '.pb-taskrow{display:flex;align-items:center;gap:var(--pb-sp-8);cursor:pointer;text-align:left;width:100%;padding:var(--pb-sp-8) var(--pb-sp-12);border-radius:var(--pb-r-8);border:1px solid var(--pb-line);background:var(--pb-card);color:var(--pb-ink);font-size:var(--pb-fs-13)}',
  '.pb-taskrow:hover{background:rgba(139,92,246,.08);border-color:rgba(139,92,246,.45)}',
  '.pb-taskrow-on{border-color:#8b5cf6;box-shadow:0 0 0 1px rgba(139,92,246,.4)}',
  '.pb-taskrow-id{font-size:var(--pb-fs-11);color:var(--pb-muted);flex:none}',
  '.pb-taskrow-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.pb-taskrow-meta{font-size:var(--pb-fs-11);color:var(--pb-muted);flex:none}',
  '.pb-taskedit{min-width:0;position:sticky;top:var(--pb-sp-12)}',
  '.pb-emptycanvas{display:flex;flex-direction:column;align-items:center;gap:var(--pb-sp-8);padding:var(--pb-sp-24);color:var(--pb-muted);text-align:center}',
  // ===== 第 3 轮：画布质感（卡片/分组块/曲线边/工具条/点阵）=====
  '.pb-map{background-image:radial-gradient(circle,rgba(100,116,139,.16) 1px,transparent 1px);background-size:16px 16px;background-repeat:repeat;transition:none}',
  '.pb-group{fill:rgba(100,116,139,.05);stroke:var(--pb-line,#e2e8f0);stroke-width:1}',
  '.pb-cardnode{filter:drop-shadow(0 1px 2px rgba(15,23,42,.05));transition:filter .15s ease,transform .15s ease}',
  '.pb-node:hover .pb-cardnode{filter:drop-shadow(0 6px 14px rgba(15,23,42,.12));transform:translateY(-1px)}',
  '.pb-node-ring{filter:drop-shadow(0 4px 12px rgba(124,58,237,.25))}',
  '.pb-cardtitle{font-family:ui-sans-serif,system-ui,sans-serif}',
  '.pb-monoid{font-family:ui-monospace,monospace}',
  '.pb-edge{stroke:url(#pb-edge-grad);stroke-width:1.6;fill:none}',
  '.pb-edge-on{stroke:url(#pb-edge-grad-on);stroke-width:2.4}',
  '.pb-depedge{stroke-dasharray:5 4}',
  '.pb-blockpill{filter:drop-shadow(0 2px 6px rgba(239,68,68,.30))}',
  '.pb-canvasbar{position:absolute;display:flex;align-items:center;gap:var(--pb-sp-4);z-index:3}',
  '.pb-canvasbar-tl{left:var(--pb-sp-8);top:var(--pb-sp-8)}',
  '.pb-canvasbar-bl{left:var(--pb-sp-8);bottom:var(--pb-sp-8)}',
  '.pb-canvasbar-tr{right:var(--pb-sp-8);top:var(--pb-sp-8)}',
  '.pb-canvasbtn{cursor:pointer;padding:2px var(--pb-sp-8);border-radius:999px;font-size:var(--pb-fs-11);font-weight:600;border:1px solid var(--pb-line);background:var(--pb-card);color:var(--pb-muted);white-space:nowrap}',
  '.pb-canvasbtn:hover{color:var(--pb-ink);border-color:rgba(139,92,246,.5)}',
  '.pb-zoomval{font-size:var(--pb-fs-11);color:var(--pb-muted);min-width:34px;text-align:center;font-variant-numeric:tabular-nums}',
  '.pb-legend{position:static;display:inline-flex;gap:var(--pb-sp-8);align-items:center;padding:2px var(--pb-sp-8);border-radius:999px;border:1px solid var(--pb-line);background:var(--pb-card);font-size:var(--pb-fs-11);color:var(--pb-muted);pointer-events:none}',
  // ===== 新版式：顶栏 / 聚焦卡 / 分区 / 空态 / 骨架 / 状态徽标 =====
  '.pb-topbar{display:flex;flex-direction:column;gap:var(--pb-sp-8);padding:var(--pb-sp-12) var(--pb-sp-16);border-bottom:1px solid var(--pb-line);background:var(--pb-card)}',
  '.pb-topbar-row{display:flex;align-items:center;gap:var(--pb-sp-8);flex-wrap:wrap}',
  '.pb-brand{font-size:var(--pb-fs-15);font-weight:700;letter-spacing:.2px}',
  '.pb-grow{flex:1;min-width:120px}',
  '.pb-search{max-width:180px}',
  '.pb-tags{display:flex;flex-wrap:wrap;gap:var(--pb-sp-4)}',
  '.pb-focus{margin:var(--pb-sp-12) var(--pb-sp-16);padding:var(--pb-sp-12) var(--pb-sp-16);border:1px solid var(--pb-line);border-radius:var(--pb-r-10);background:var(--pb-card);box-shadow:var(--pb-shadow-1);display:flex;flex-direction:column;gap:var(--pb-sp-8)}',
  '.pb-focus-kicker{font-size:var(--pb-fs-11);font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--pb-muted)}',
  '.pb-focus-main{display:flex;align-items:center;gap:var(--pb-sp-8);flex-wrap:wrap}',
  '.pb-focus-title{font-size:var(--pb-fs-18);font-weight:700;line-height:1.3}',
  '.pb-focus-detail{font-size:var(--pb-fs-13);color:var(--pb-ink);line-height:1.6}',
  '.pb-focus-hint{font-size:var(--pb-fs-12);color:var(--pb-muted);line-height:1.6}',
  '.pb-status{display:inline-flex;align-items:center;gap:var(--pb-sp-4);font-size:var(--pb-fs-11);font-weight:700;padding:2px var(--pb-sp-8);border-radius:999px;border:1px solid currentColor;background:rgba(100,116,139,.10)}',
  '.pb-status-shape{font-size:var(--pb-fs-12);line-height:1}',
  '.pb-badge{font-size:var(--pb-fs-11);font-weight:700;padding:1px var(--pb-sp-8);border-radius:999px;background:rgba(139,92,246,.14);color:#7c3aed}',
  '[data-mode="dark"] .pb-badge{color:#a78bfa}',
  '.pb-empty{display:flex;flex-direction:column;gap:var(--pb-sp-4);padding:var(--pb-sp-16);border:1px dashed var(--pb-line);border-radius:var(--pb-r-8);background:rgba(100,116,139,.05)}',
  '.pb-empty-title{font-size:var(--pb-fs-15);font-weight:700}',
  '.pb-empty-hint{font-size:var(--pb-fs-13);color:var(--pb-muted);line-height:1.6}',
  '.pb-empty-action{margin-top:var(--pb-sp-4);display:flex;gap:var(--pb-sp-8)}',
  '.pb-skel{display:flex;flex-direction:column;gap:var(--pb-sp-8);padding:var(--pb-sp-16)}',
  '.pb-skel-row{height:12px;border-radius:var(--pb-r-6);background:linear-gradient(90deg,rgba(100,116,139,.14),rgba(100,116,139,.26),rgba(100,116,139,.14));background-size:200% 100%;animation:pb-shimmer 1.4s linear infinite}',
  '@keyframes pb-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}',
  '.pb-errbar{display:flex;align-items:center;gap:var(--pb-sp-8);margin:var(--pb-sp-12) var(--pb-sp-16) 0;padding:var(--pb-sp-8) var(--pb-sp-12);border:1px solid rgba(239,68,68,.5);border-radius:var(--pb-r-8);background:rgba(239,68,68,.10);font-size:var(--pb-fs-13);color:#b91c1c}',
  '[data-mode="dark"] .pb-errbar{color:#fca5a5}',
  '.pb-kbd{font:11px/1.4 ui-monospace,monospace;padding:1px 5px;border:1px solid var(--pb-line);border-bottom-width:2px;border-radius:var(--pb-r-6);background:var(--pb-bg);color:var(--pb-muted)}',
  // ===== 第 2 轮：图例 / 角标 / 折叠 / 下一步清单 =====
  '.pb-legend{position:absolute;right:8px;top:8px;display:flex;gap:8px;align-items:center;padding:3px 8px;border-radius:var(--pb-r-8);border:1px solid var(--pb-line);background:rgba(255,255,255,.86);font-size:10px;color:var(--pb-muted);pointer-events:none;z-index:2}',
  '.pb-legend-item{display:inline-flex;align-items:center;gap:3px;white-space:nowrap}',
  '.pb-legend-shape{font-size:11px;line-height:1}',
  '.pb-fold{cursor:pointer}',
  '.pb-focus-id{font:11px/1.4 ui-monospace,monospace;color:var(--pb-muted);padding:1px 6px;border-radius:var(--pb-r-6);background:rgba(100,116,139,.12)}',
  '.pb-focus-detail{font-size:var(--pb-fs-12);color:var(--pb-ink);line-height:1.6}',
  '.pb-focus-sub{display:block;font-size:var(--pb-fs-11);font-weight:700;color:var(--pb-muted);margin-bottom:var(--pb-sp-4)}',
  '.pb-focus-blocked{margin-top:var(--pb-sp-8)}',
  '.pb-focus-blocked-list{display:flex;flex-wrap:wrap;gap:var(--pb-sp-4)}',
  '.pb-focus-blocked-item{display:inline-flex;align-items:center;gap:var(--pb-sp-4);font-size:var(--pb-fs-12);color:var(--pb-ink)}',
  '.pb-next{margin-top:var(--pb-sp-8)}',
  '.pb-next-list{display:flex;flex-direction:column;gap:var(--pb-sp-4)}',
  '.pb-next-item{display:flex;align-items:center;gap:var(--pb-sp-8);cursor:pointer;text-align:left;padding:var(--pb-sp-4) var(--pb-sp-8);border-radius:var(--pb-r-6);border:1px solid var(--pb-line);background:var(--pb-bg);color:var(--pb-ink);font-size:var(--pb-fs-12)}',
  '.pb-next-item:hover{background:rgba(139,92,246,.10);border-color:rgba(139,92,246,.5)}',
  // 崩溃面：宿主那道边界只会留空 div，这里自己给一句人话 + 一个重载按钮
  '.pb-crash{padding:14px;border:1px solid rgba(239,68,68,.5);border-radius:10px;background:rgba(239,68,68,.08);display:flex;flex-direction:column;gap:8px;font-size:var(--pb-fs-12);color:inherit}',
  '.pb-crash-title{font-weight:700;color:#ef4444;font-size:var(--pb-fs-13)}',
  '.pb-crash-msg{opacity:.85;line-height:1.6}',
  '.pb-crash-btn{cursor:pointer;align-self:flex-start;padding:5px 12px;border-radius:8px;font-size:var(--pb-fs-12);font-weight:600;border:1px solid #ef4444;background:#ef4444;color:#fff}',
  // ===== 子导图 =====
  '.pb-designbar{display:flex;align-items:center;gap:8px;margin-top:2px}',
  '.pb-design{border:1px dashed var(--pb-line);border-radius:8px;padding:8px;display:flex;flex-direction:column;gap:8px;background:rgba(100,116,139,.05)}',
  '.pb-designsteps{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:4px}',
  '.pb-designsteps li{display:flex;gap:6px;align-items:center}',
  '.pb-designsteps input{flex:1;min-width:0;font:11px/1.5 ui-monospace,monospace;padding:3px 6px;border-radius:6px;border:1px solid var(--pb-line);background:var(--pb-bg);color:var(--pb-ink)}',
  '.pb-designextra{font:10px/1.4 ui-monospace,monospace;color:var(--pb-muted);white-space:pre-wrap;word-break:break-all;background:var(--pb-bg);border:1px solid var(--pb-line);border-radius:6px;padding:4px 6px;max-height:120px;overflow:auto}',
].join('\n')

function ensureStyles(): void {
  if (document.getElementById('dsh-plan-superagent-css') != null) return
  const el = document.createElement('style')
  el.id = 'dsh-plan-superagent-css'
  el.textContent = CSS
  document.head.appendChild(el)
}

/** Register the project the panel is on, so the bridge can follow it even before it has a board. */
async function rememberProject(path: string): Promise<void> {
  const value = path.trim()
  if (value === '') return
  try { await post('/remember', { project: value, name: value }) } catch { /* the registry is a convenience */ }
}

async function post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return await r.json() as Record<string, unknown>
}


/** 客户端环检测（保存前快失败；服务端 lint 仍兜底）。 */
function hasCycle(nodes: { id: string; deps: string[] }[]): boolean {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const color = new Map<string, number>()
  const dfs = (id: string): boolean => {
    const c = color.get(id)
    if (c === 1) return true
    if (c === 2) return false
    color.set(id, 1)
    for (const d of byId.get(id)?.deps ?? []) {
      if (byId.has(d) && dfs(d)) return true
    }
    color.set(id, 2)
    return false
  }
  for (const n of nodes) { if (dfs(n.id)) return true }
  return false
}


interface MapProps {
  data: BoardData
  effNodes: BoardNode[]
  layout: MapLayout
  dirtyIds: Set<string>
  view: { k: number; tx: number; ty: number }
  setView: (f: (v: { k: number; tx: number; ty: number }) => { k: number; tx: number; ty: number }) => void
  dragRef: MutableRefObject<{ kind: 'node'; id: string; sx: number; sy: number; bx: number; by: number; moved: boolean } | { kind: 'dep'; from: string } | null>
  depLine: { x1: number; y1: number; x2: number; y2: number } | null
  setDepLine: (v: { x1: number; y1: number; x2: number; y2: number } | null) => void
  editorId: string | null
  onNodePointerDown: (e: PEv, id: string, base: { x: number; y: number }) => void
  onNodeMove: (id: string, pos: { x: number; y: number }) => void
  onNodeClick: (id: string) => void
  onDepDrop: (from: string, at: { clientX: number; clientY: number }) => void
  onHandlePointerDown: (e: PEv, id: string) => void
  svgRef: RefObject<SVGSVGElement | null>
  /** 第 2 轮：模块折叠状态（moduleId -> 是否折叠）。 */
  folded: Record<string, boolean>
  /** 第 2 轮：聚焦集合（主任务 + 上游依赖链）；其余节点淡出但仍可见。 */
  focusIds: Set<string>
  /** 第 2 轮：挡住每个任务的前置任务 id。 */
  blockers: Record<string, string[]>
  /** 第 2 轮：折叠/展开某个模块。 */
  onToggleModule: (id: string) => void
  /** 第 3 轮：折叠/展开全部模块。 */
  onFoldAll: (folded: boolean) => void
}

const ROW = 30
const MOD_H = 42

function MindMap(props: MapProps): ReturnType<typeof h> {
  const { data, effNodes, layout, dirtyIds, view, setView, dragRef, depLine, setDepLine, editorId, onNodePointerDown, onNodeMove, onNodeClick, onDepDrop, onHandlePointerDown, svgRef, folded, focusIds, blockers, onToggleModule, onFoldAll } = props
  const b = data.board
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)
  const mapRef = useRef<HTMLDivElement | null>(null)
  const [legendOpen, setLegendOpen] = useState(false)
  // 聚焦集合为空 = 没人在做（不淡出任何节点）；有则集合外的淡出但仍可见（要看得出全局）
  const dimOpacity = (id: string): number => (focusIds.size === 0 ? 1 : (focusIds.has(id) ? 1 : .3))
  const boxOf = (id: string): MapBox | undefined => layout.items.find(i => i.id === id)
  const nodeOf = (id: string): BoardNode | undefined => effNodes.find(n => n.id === id)
  const toSvg = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = svgRef.current?.getBoundingClientRect()
    const left = rect?.left ?? 0
    const top = rect?.top ?? 0
    return { x: (clientX - left - view.tx) / view.k, y: (clientY - top - view.ty) / view.k }
  };
  // 缩放/适应：用户不用拿滚轮硬调
  const zoomBy = (f: number): void => { setView(v => ({ ...v, k: Math.min(2.2, Math.max(0.35, v.k * f)) })) }
  const doFit = (): void => {
    const el = mapRef.current
    if (el == null) return
    const v = fitView(layout, { w: el.clientWidth, h: el.clientHeight })
    setView(() => ({ k: v.k, tx: v.tx, ty: v.ty }))
  }
  // 原生非 passive 监听器：React 合成 onWheel 走根节点 passive 注册，preventDefault 无效且报错
  useEffect(() => {
    const el = mapRef.current
    if (el == null) return
    const onWheel = (e: WheelEvent): void => {
      // 只在真要缩放时（Ctrl/⌘ + 滚轮）才吃掉默认行为；普通滚动放行，
      // 否则面板在导图上根本滚不动（用户说的"滑动两下"其实是被吞掉的滚动）
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      setView(v => ({ ...v, k: Math.min(2.2, Math.max(0.35, v.k * (e.deltaY > 0 ? 0.92 : 1.08))) }))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [setView])
  return h('div', {
    className: 'pb-map',
    ref: mapRef,
    // 点阵网格跟随平移（专业感全靠它）
    style: { backgroundPosition: (view.tx % 16) + 'px ' + (view.ty % 16) + 'px' },
    onPointerDown: (e: PEv) => { if (dragRef.current != null) return; drag.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty }; (e.target as Element).setPointerCapture?.(e.pointerId) },
    onPointerMove: (e: PEv) => {
      const d = dragRef.current
      if (d != null && d.kind === 'node') {
        const p = toSvg(e.clientX, e.clientY)
        if (Math.abs(p.x - d.sx) * view.k > 3 || Math.abs(p.y - d.sy) * view.k > 3) d.moved = true
        onNodeMove(d.id, { x: d.bx + (p.x - d.sx), y: d.by + (p.y - d.sy) })
        return
      }
      if (d != null && d.kind === 'dep') {
        const p = toSvg(e.clientX, e.clientY)
        const f = boxOf(d.from)
        if (f != null) setDepLine({ x1: f.x + f.w, y1: f.y + f.h / 2, x2: p.x, y2: p.y })
        return
      }
      const base = drag.current
      if (base == null) return
      setView(v => ({ ...v, tx: base.tx + (e.clientX - base.x), ty: base.ty + (e.clientY - base.y) }))
    },
    onPointerUp: (e: PEv) => {
      const d = dragRef.current
      dragRef.current = null
      setDepLine(null)
      drag.current = null
      if (d != null && d.kind === 'node') { if (!d.moved) onNodeClick(d.id); return }
      if (d != null && d.kind === 'dep') { onDepDrop(d.from, { clientX: e.clientX, clientY: e.clientY }); return }
    },
    onPointerCancel: () => { drag.current = null; dragRef.current = null; setDepLine(null) },
    onPointerLeave: () => { drag.current = null; dragRef.current = null; setDepLine(null) },
    onLostPointerCapture: () => { drag.current = null; dragRef.current = null; setDepLine(null) },
    // 空白处双击 = 适应画布（点在节点上不算）
    onDoubleClick: (e: PEv) => {
      const el = e.target as Element
      if (el.closest('.pb-node') != null) return
      doFit()
    },
  },
    h('svg', { width: '100%', height: Math.max(layout.totalH, 320), ref: svgRef, key: b.version },
      h('defs', {},
        // 层级边渐变：近父浓、末端淡（"呼吸感"的关键）
        h('linearGradient', { key: 'g1', id: 'pb-edge-grad', x1: '0', y1: '0', x2: '0', y2: '1' },
          h('stop', { key: 's1', offset: '0%', style: { stopColor: 'var(--pb-line)', stopOpacity: '.95' } }),
          h('stop', { key: 's2', offset: '100%', style: { stopColor: 'var(--pb-line)', stopOpacity: '.2' } })),
        h('linearGradient', { key: 'g2', id: 'pb-edge-grad-on', x1: '0', y1: '0', x2: '0', y2: '1' },
          h('stop', { key: 's3', offset: '0%', style: { stopColor: '#8b5cf6', stopOpacity: '1' } }),
          h('stop', { key: 's4', offset: '100%', style: { stopColor: '#8b5cf6', stopOpacity: '.3' } }))),
      h('g', { transform: 'translate(' + view.tx + ',' + view.ty + ') scale(' + view.k + ')' },
        // ===== 模块分组块（容器，不是方框）=====
        layout.groups.map(g => h('rect', { key: 'grp' + g.id, className: 'pb-group', x: g.x, y: g.y, width: g.w, height: g.h, rx: 14 })),
        // ===== 层级边：平滑 S 曲线，默认很淡，聚焦链才提亮 =====
        layout.edges.map((e, i) => {
          const from = boxOf(e.from)
          const to = boxOf(e.to)
          if (from == null || to == null) return null
          const on = focusIds.size > 0 && focusIds.has(e.to) && focusIds.has(e.from)
          return h('path', { key: 'e' + i, className: 'pb-edge' + (on ? ' pb-edge-on' : ''), d: hierarchyPath(from, to), fill: 'none' })
        }),
        // ===== 依赖边：圆角折线绕开卡片；挡路的加粗标红 =====
        effNodes.flatMap((t, di) => (t.deps ?? []).map((d, dj) => {
          const from = boxOf(d)
          const to = boxOf(t.id)
          if (from == null || to == null) return null
          const dep = nodeOf(d)
          const depColor = STATUS_COLOR[dep?.status ?? 'planned'] ?? '#94a3b8'
          const blocking = (blockers[t.id] ?? []).includes(d)
          const on = focusIds.size > 0 && focusIds.has(t.id) && focusIds.has(d)
          const op = focusIds.size === 0 ? .7 : (on || blocking ? .95 : .18)
          const stroke = blocking ? '#ef4444' : depColor
          const tipX = to.x, tipY = to.y + to.h / 2
          return h('g', { key: 'dep' + di + '_' + dj, opacity: op },
            h('path', { className: 'pb-depedge', d: dependencyPath(from, to), stroke, strokeWidth: blocking ? 2 : 1.4, fill: 'none' }),
            h('path', { d: 'M ' + tipX + ' ' + tipY + ' l -7 -4 l 0 8 z', fill: stroke, stroke: 'none' }))
        })),
        depLine != null ? h('line', { x1: depLine.x1, y1: depLine.y1, x2: depLine.x2, y2: depLine.y2, stroke: '#8b5cf6', strokeWidth: 2, strokeDasharray: '4 3', opacity: .9 }) : null,
        // ===== 节点 =====
        layout.items.map((bx, ii) => {
          const n = nodeOf(bx.id)
          const isRoot = bx.id === '__root__'
          const meta = statusMeta(n?.status ?? 'planned')
          const color = meta.color
          const ord = data.order[bx.id]
          const isStation = bx.id === data.station
          const isEditor = bx.id === editorId
          const isDirty = dirtyIds.has(bx.id)
          const op = dimOpacity(bx.id)
          const blockedBy = blockers[bx.id] ?? []
          const isModule = n != null && n.type === 'module'
          const prog = isModule ? moduleProgress(effNodes as unknown as TopoNode[], bx.id) : null
          const title = isRoot ? (b?.plan.name ?? 'Plan') : (n?.title ?? bx.id)
          if (isRoot) {
            return h('g', { key: 'n' + ii, className: 'pb-node', opacity: op },
              h('rect', { className: 'pb-cardnode', x: bx.x, y: bx.y, width: bx.w, height: bx.h, rx: 10, fill: 'var(--pb-card)', stroke: 'var(--pb-line)', strokeWidth: 1 }),
              h('rect', { x: bx.x + 12, y: bx.y + 10, width: 4, height: bx.h - 20, rx: 2, fill: color }),
              h('text', { className: 'pb-cardtitle', x: bx.x + 24, y: bx.y + 24, fontSize: 13, fontWeight: 600 }, title.slice(0, 16)))
          }
          if (isModule) {
            return h('g', {
              key: 'n' + bx.id,
              className: 'pb-node',
              'data-id': bx.id,
              opacity: op,
              onPointerDown: (e: PEv) => { e.stopPropagation(); onNodePointerDown(e, bx.id, { x: bx.x, y: bx.y }) },
            },
              h('rect', { x: bx.x, y: bx.y, width: bx.w, height: bx.h, fill: 'transparent' }),
              h('text', { className: 'pb-cardtitle', x: bx.x + bx.w / 2, y: bx.y + 18, fontSize: 13, fontWeight: 600, textAnchor: 'middle', fill: 'var(--pb-ink,#0f172a)' }, title.slice(0, 18)),
              prog != null && prog.total > 0 ? h('text', { x: bx.x + bx.w - 26, y: bx.y + 18, fontSize: 11, textAnchor: 'end', fill: 'var(--pb-muted,#64748b)' }, prog.done + '/' + prog.total) : null,
              h('g', {
                className: 'pb-fold',
                onPointerDown: (e: PEv) => { e.stopPropagation() },
                onClick: (e: { stopPropagation: () => void }) => { e.stopPropagation(); onToggleModule(bx.id) },
              },
                h('circle', { cx: bx.x + bx.w - 10, cy: bx.y + 13, r: 8, fill: 'var(--pb-card)', stroke: 'var(--pb-line,#cbd5e1)' }),
                h('text', { x: bx.x + bx.w - 10, y: bx.y + 16, fontSize: 9, textAnchor: 'middle', fill: 'var(--pb-muted,#64748b)' }, folded[bx.id] === true ? '▸' : '▾')))
          }
          const acc = n?.acceptance?.length ?? 0
          const depc = n?.deps?.length ?? 0
          const pillW = 54
          return h('g', {
            key: 'n' + bx.id,
            className: 'pb-node' + (isEditor ? ' pb-node-sel' : ''),
            'data-id': bx.id,
            opacity: op,
            onPointerDown: (e: PEv) => { e.stopPropagation(); onNodePointerDown(e, bx.id, { x: bx.x, y: bx.y }) },
          },
            isStation ? h('rect', { className: 'pb-station', x: bx.x - 4, y: bx.y - 4, width: bx.w + 8, height: bx.h + 8, rx: 12, fill: 'none', stroke: 'var(--pb-st-doing,#f59e0b)', strokeWidth: 2 }) : null,
            isEditor ? h('rect', { className: 'pb-node-ring', x: bx.x - 3, y: bx.y - 3, width: bx.w + 6, height: bx.h + 6, rx: 12, fill: 'none', stroke: '#8b5cf6', strokeWidth: 2 }) : null,
            h('rect', { className: 'pb-cardnode', x: bx.x, y: bx.y, width: bx.w, height: bx.h, rx: 10, fill: 'var(--pb-card)', stroke: blockedBy.length > 0 ? '#ef4444' : 'var(--pb-line,#e2e8f0)', strokeWidth: blockedBy.length > 0 ? 1.5 : 1, strokeDasharray: blockedBy.length > 0 ? '4 3' : undefined }),
            // 左侧状态色条（不只靠边框/圆点）
            h('rect', { x: bx.x, y: bx.y + 9, width: 4, height: bx.h - 18, rx: 2, fill: color }),
            h('text', { className: 'pb-cardtitle', x: bx.x + 16, y: bx.y + 21, fontSize: 13, fontWeight: 500, fill: 'var(--pb-ink,#0f172a)' }, (ord != null ? '#' + ord + ' ' : '') + (isDirty ? '● ' : '') + title.slice(0, 18)),
            // id 等宽徽标 + 次要元信息
            h('rect', { x: bx.x + 16, y: bx.y + 28, width: 38, height: 14, rx: 4, fill: 'rgba(100,116,139,.14)' }),
            h('text', { className: 'pb-monoid', x: bx.x + 35, y: bx.y + 39, fontSize: 10, textAnchor: 'middle', fill: 'var(--pb-muted,#64748b)' }, bx.id),
            h('text', { x: bx.x + 60, y: bx.y + 39, fontSize: 11, fill: 'var(--pb-muted,#64748b)' }, meta.label + ' · 验收 ' + acc + ' · 依赖 ' + depc),
            // 状态胶囊（右上）
            h('g', {},
              h('rect', { x: bx.x + bx.w - 8 - pillW, y: bx.y + 9, width: pillW, height: 16, rx: 8, fill: 'rgba(100,116,139,.10)', stroke: color, strokeWidth: 1 }),
              h('text', { x: bx.x + bx.w - 8 - pillW + 8, y: bx.y + 21, fontSize: 10, fill: color }, meta.shape),
              h('text', { x: bx.x + bx.w - 14, y: bx.y + 21, fontSize: 10, textAnchor: 'end', fill: color }, meta.label)),
            // 被挡：贴在卡片右上角**外侧**的小胶囊（不压标题）
            blockedBy.length > 0 ? h('g', { className: 'pb-blockpill' },
              h('rect', { x: bx.x + bx.w - 78, y: bx.y - 10, width: 82, height: 17, rx: 8, fill: '#ef4444' }),
              h('text', { x: bx.x + bx.w - 37, y: bx.y + 2, fontSize: 10, textAnchor: 'middle', fill: '#fff' }, '⛔ 被 ' + blockedBy.slice(0, 2).join(' ') + (blockedBy.length > 2 ? '…' : '') + ' 挡住')) : null,
            // 拖紫点连依赖（保留）
            h('circle', {
              className: 'pb-handle', cx: bx.x + bx.w + 8, cy: bx.y + bx.h / 2, r: 5, fill: '#8b5cf6', opacity: .85,
              title: '拖到目标任务 = 目标依赖此任务；再拖一次 = 移除依赖',
              onPointerDown: (e: PEv) => { e.stopPropagation(); onHandlePointerDown(e, bx.id) },
            }))
        }))),
    // ===== 画布工具：顶部工具行 =====
    h('div', { className: 'pb-canvasbar pb-canvasbar-tl' },
      h('button', { className: 'pb-canvasbtn', 'aria-label': '适应画布', title: '适应画布（双击空白处也行）', onClick: doFit }, '适应'),
      h('button', { className: 'pb-canvasbtn', 'aria-label': '折叠全部模块', title: '折叠全部模块', onClick: () => onFoldAll(true) }, '折叠全部'),
      h('button', { className: 'pb-canvasbtn', 'aria-label': '展开全部模块', title: '展开全部模块', onClick: () => onFoldAll(false) }, '展开全部')),
    // ===== 缩放工具条（左下）=====
    h('div', { className: 'pb-canvasbar pb-canvasbar-bl' },
      h('button', { className: 'pb-canvasbtn', 'aria-label': '缩小', onClick: () => zoomBy(0.9) }, '−'),
      h('span', { className: 'pb-zoomval' }, Math.round(view.k * 100) + '%'),
      h('button', { className: 'pb-canvasbtn', 'aria-label': '放大', onClick: () => zoomBy(1.1) }, '+'),
      h('button', { className: 'pb-canvasbtn', 'aria-label': '适应画布', onClick: doFit }, '适应')),
    // ===== 图例（右上，可折叠的小胶囊）=====
    h('div', { className: 'pb-canvasbar pb-canvasbar-tr' },
      h('button', { className: 'pb-canvasbtn', 'aria-expanded': legendOpen, 'aria-label': '图例', onClick: () => setLegendOpen(v => !v) }, legendOpen ? '图例 ▴' : '图例 ▾'),
      legendOpen ? h('span', { className: 'pb-legend' },
        ['planned', 'ready', 'doing', 'blocked', 'done'].map(s => {
          const m = statusMeta(s)
          return h('span', { className: 'pb-legend-item', key: 'lg' + s },
            h('span', { className: 'pb-legend-shape', style: { color: m.color } }, m.shape),
            h('span', {}, m.label))
        })) : null),
  )
}
/** 依赖多选（候选项来自板子节点 + 同提案新增的节点）。 */
function DepPicker(props: { options: DepOption[]; value: string[]; onChange: (v: string[]) => void }): ReturnType<typeof h> {
  const { options, value, onChange } = props
  return h('div', { className: 'pb-deps' },
    options.length === 0 ? h('span', { className: 'pb-hint' }, '（暂无可选依赖节点）') : null,
    options.map(o => h('label', { className: 'pb-deprow', key: o.id },
      h('input', {
        type: 'checkbox',
        checked: value.includes(o.id),
        onChange: (e: { target: { checked: boolean } }) => {
          const arr = value.slice()
          const i = arr.indexOf(o.id)
          if (e.target.checked && i < 0) arr.push(o.id)
          if (!e.target.checked && i >= 0) arr.splice(i, 1)
          onChange(arr)
        },
      }),
      h('span', {}, o.id + ' · ' + clip(o.title, 26)))))
}

interface ApprovalCardProps {
  ap: { id: string; reason: string; by: string; proposedAt: string }
  ops: PbOp[]
  origOps: PbOp[]
  dirty: boolean
  cycle: string
  issues: string[]
  options: DepOption[]
  busy: boolean
  rev: number
  onOps: (ops: PbOp[]) => void
  onReset: () => void
  onApprove: () => void
  onReject: () => void
}

/**
 * 待批提案卡：把 ops 摊开成可编辑的行。
 * 用户真正的痛点是「一句话生成的导图没法手改」—— 以前只能确认/驳回，现在能改标题、验收、scope、
 * 依赖、优先级，能删掉某条 op（= 不创建那个节点），改完再把改过的 ops 一起提交。
 */
function ApprovalCard(props: ApprovalCardProps): ReturnType<typeof h> {
  const { ap, ops, origOps, dirty, cycle, issues, options, busy, rev, onOps, onReset, onApprove, onReject } = props
  const patch = (i: number, next: PbOp): void => { onOps(ops.map((o, k) => (k === i ? next : o))) }
  const patchNode = (i: number, p: Partial<OpAdd['node']>): void => {
    const o = ops[i]
    if (o == null || o.op !== 'add_node') return
    patch(i, { ...o, node: { ...o.node, ...p } })
  }
  const patchFields = (i: number, p: Record<string, unknown>): void => {
    const o = ops[i]
    if (o == null || o.op !== 'update_node') return
    patch(i, { ...o, fields: { ...o.fields, ...p } })
  }
  const dropOp = (i: number): void => { onOps(ops.filter((_, k) => k !== i)) }
  const lbl = (text: string, ctrl: ReturnType<typeof h>): ReturnType<typeof h> => h('label', { className: 'pb-oplabel' }, text, ctrl)
  const prio = (cur: number | null, onChange: (v: number) => void): ReturnType<typeof h> =>
    h('select', { value: String(cur ?? 3), onChange: (e: { target: { value: string } }) => onChange(Number(e.target.value)) },
      [1, 2, 3, 4, 5].map(p => h('option', { key: p, value: String(p) }, 'P' + p)))
  const delBtn = (i: number): ReturnType<typeof h> =>
    h('button', { className: 'pb-btn', style: { marginLeft: 'auto' }, onClick: () => dropOp(i) }, '删除此条')
  const rows = ops.map((op, i) => {
    if (op.op === 'init_board') {
      const nameVal = op.name
      const goalVal = op.goal
      return h('div', { className: 'pb-oprow', key: 'op' + i },
        h('div', { className: 'pb-ophead' },
          h('span', { className: 'pb-chip' }, 'init_board'),
          delBtn(i)),
        lbl('计划名', h('input', { value: nameVal, onChange: (e: { target: { value: string } }) => patch(i, { ...op, name: e.target.value }) })),
        lbl('目标', h('textarea', { key: 'goal' + rev, defaultValue: goalVal, onChange: (e: { target: { value: string } }) => patch(i, { ...op, goal: e.target.value }) })))
    }
    if (op.op === 'add_node') {
      const n = op.node
      return h('div', { className: 'pb-oprow', key: 'op' + i },
        h('div', { className: 'pb-ophead' },
          h('span', { className: 'pb-chip' }, 'add_node'),
          h('span', { className: 'pb-chip' }, n.type === 'task' ? '任务' : '模块'),
          h('span', { className: 'pb-chip' }, n.id),
          delBtn(i)),
        lbl('标题', h('input', { value: n.title, onChange: (e: { target: { value: string } }) => patchNode(i, { title: e.target.value }) })),
        lbl('验收标准（每行一条）', h('textarea', { key: 'acc' + rev, defaultValue: n.acceptance.join('\n'), onChange: (e: { target: { value: string } }) => patchNode(i, { acceptance: splitLines(e.target.value) }) })),
        lbl('scope（每行一条，目录以 / 结尾）', h('textarea', { key: 'scope' + rev, defaultValue: n.scope.join('\n'), onChange: (e: { target: { value: string } }) => patchNode(i, { scope: splitLines(e.target.value) }) })),
        lbl('优先级', prio(n.priority, v => patchNode(i, { priority: v }))),
        h('div', { className: 'pb-oplabel' }, '依赖（前置节点，可多选）',
          h(DepPicker, { options: options.filter(o => o.id !== n.id), value: n.deps, onChange: (v: string[]) => patchNode(i, { deps: v }) })))
    }
    if (op.op === 'update_node') {
      const f = op.fields
      // 先取到局部 const：字段窄化在闭包里会丢（TS 不会把 f.title 的窄化带进 onChange）
      const titleVal = typeof f.title === 'string' ? f.title : null
      const noteVal = typeof f.note === 'string' ? f.note : null
      const accVal = Array.isArray(f.acceptance) ? (f.acceptance as string[]) : null
      const scopeVal = Array.isArray(f.scope) ? (f.scope as string[]) : null
      const prioVal = typeof f.priority === 'number' ? f.priority : null
      const depsVal = Array.isArray(f.deps) ? (f.deps as string[]) : null
      return h('div', { className: 'pb-oprow', key: 'op' + i },
        h('div', { className: 'pb-ophead' },
          h('span', { className: 'pb-chip' }, 'update_node'),
          h('span', { className: 'pb-chip' }, op.id),
          delBtn(i)),
        titleVal != null ? lbl('标题', h('input', { value: titleVal, onChange: (e: { target: { value: string } }) => patchFields(i, { title: e.target.value }) })) : null,
        noteVal != null ? lbl('备注（生成器写的是子导图指针，改坏了子导图就找不到）', h('textarea', { key: 'unote' + rev, defaultValue: noteVal, onChange: (e: { target: { value: string } }) => patchFields(i, { note: e.target.value }) })) : null,
        accVal != null ? lbl('验收标准（每行一条）', h('textarea', { key: 'uacc' + rev, defaultValue: accVal.join('\n'), onChange: (e: { target: { value: string } }) => patchFields(i, { acceptance: splitLines(e.target.value) }) })) : null,
        scopeVal != null ? lbl('scope（每行一条）', h('textarea', { key: 'uscope' + rev, defaultValue: scopeVal.join('\n'), onChange: (e: { target: { value: string } }) => patchFields(i, { scope: splitLines(e.target.value) }) })) : null,
        prioVal != null ? lbl('优先级', prio(prioVal, v => patchFields(i, { priority: v }))) : null,
        depsVal != null ? h('div', { className: 'pb-oplabel' }, '依赖（可多选）',
          h(DepPicker, { options: options.filter(o => o.id !== op.id), value: depsVal, onChange: (v: string[]) => patchFields(i, { deps: v }) })) : null)
    }
    if (op.op === 'remove_node') {
      return h('div', { className: 'pb-oprow', key: 'op' + i },
        h('div', { className: 'pb-ophead' },
          h('span', { className: 'pb-chip' }, 'remove_node'),
          h('span', { className: 'pb-chip' }, op.id),
          delBtn(i)),
        h('div', { className: 'pb-hint' }, '生效后会移除节点 ' + op.id))
    }
    return h('div', { className: 'pb-oprow', key: 'op' + i },
      h('div', { className: 'pb-ophead' },
        h('span', { className: 'pb-chip' }, 'set_deps'),
        h('span', { className: 'pb-chip' }, op.id),
        delBtn(i)),
      h('div', { className: 'pb-oplabel' }, '依赖（可多选）',
        h(DepPicker, { options: options.filter(o => o.id !== op.id), value: op.deps, onChange: (v: string[]) => patch(i, { ...op, deps: v }) })))
  })
  return h('div', { className: 'pb-card' },
    h('div', { style: { fontWeight: 700, marginBottom: '4px' } }, ap.id + ' · ' + ops.length + ' ops · ' + ap.by),
    h('div', { style: { opacity: .8, marginBottom: '6px' } }, ap.reason),
    h('div', { className: 'pb-ops' },
      rows.length === 0 ? h('div', { className: 'pb-hint' }, '（这条提案的操作都被你删了 —— 批准它等于什么都不做）') : rows),
    cycle !== '' ? h('div', { className: 'pb-cycle' }, '⛔ 依赖会成环：' + cycle + '（先去掉其中一条再批准）') : null,
    issues.map((x, i) => h('div', { className: 'pb-cycle', key: 'iss' + i }, '⚠ ' + x)),
    h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '6px', flexWrap: 'wrap' } },
      h('button', { className: 'pb-btn pb-ok', disabled: busy || cycle !== '', onClick: onApprove }, dirty ? '确认生效（按你的修改）' : '确认生效'),
      h('button', { className: 'pb-btn pb-no', disabled: busy, onClick: onReject }, '驳回'),
      h('button', { className: 'pb-btn', disabled: busy || !dirty, onClick: onReset }, '重置为原提案'),
      h('span', { className: 'pb-hint' }, dirty ? '已修改（原 ' + origOps.length + ' 条 → 现 ' + ops.length + ' 条）' : '未修改')))
}
/**
 * 计划板模式开关：挂在宿主输入栏左侧（conversation.input.left 插槽，与权限/计划芯片同一排）。
 * 状态按会话存在服务端：挂载时 GET /mode 读回，点一下 POST /mode 切。
 * 失败只在按钮旁显示一行小字 —— 输入栏旁边弹 alert 会吓人。
 */
function PlanBoardModeChip(props: { sessionId?: string }): ReturnType<typeof h> {
  ensureStyles()
  const [mode, setMode] = useState<PbMode>('direct')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const sid = resolveSessionId(props.sessionId)
  useEffect(() => {
    if (sid == null) return
    let stop = false
    void (async () => {
      try {
        const r = await fetch(API + '/mode?sessionId=' + encodeURIComponent(sid))
        const j = await readJson(r)
        if (stop) return
        const m = parseMode(j)
        if (m != null) setMode(m)
        else setErr(errText(j.error))
      } catch (e) { if (!stop) setErr(String(e)) }
    })()
    return () => { stop = true }
  }, [sid])
  const toggle = async (): Promise<void> => {
    if (busy || sid == null) return
    const target = nextMode(mode)
    setBusy(true)
    setErr('')
    try {
      // project 顺手带上（服务端 /mode 分支现在排在 project 校验之后）
      const j = await post('/mode', modeRequestBody(sid, target, loadProject()))
      if (j.ok !== true) { setErr(errText(j.error)); return }
      const m = parseMode(j)
      if (m != null) setMode(m)
    } catch (e) { setErr(String(e)) } finally { setBusy(false) }
  }
  // 纯图标按钮：文字全在 title 里（输入区不因为它多出任何宽度）
  const tip = sid == null
    ? '计划板模式：拿不到会话 id，开关不可用'
    : mode === 'plan'
      ? '计划板模式：开 —— 开发类需求先出计划树再动手（点击关掉）'
      : '计划板模式：关 —— 点击开启：开发类需求先出计划树再动手'
  return h('span', { className: 'pb-modewrap' },
    h('button', {
      className: 'pb-modebtn' + (mode === 'plan' ? ' pb-on' : '') + (err !== '' ? ' pb-err' : ''),
      disabled: busy || sid == null,
      'aria-pressed': mode === 'plan',
      'aria-label': modeLabel(mode),
      title: err !== '' ? modeLabel(mode) + '｜' + err : tip,
      onClick: (e: { currentTarget: { blur: () => void } }) => {
        e.currentTarget.blur() // 点完就把焦点还给输入框，别抢
        void toggle()
      },
    }, h('svg', { viewBox: '0 0 16 16', width: 13, height: 13, 'aria-hidden': 'true' },
      h('rect', { x: 2.2, y: 2.6, width: 11.6, height: 10.8, rx: 2.4, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 }),
      h('path', { d: 'M4.8 6.3h6.4M4.8 9.2h4.2', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }))))
}
/**
 * 侧栏面板图标：宿主按面板大小传 size（16/18），颜色跟主题走 currentColor。
 * 不加文字、不加外框 —— 侧栏那一列都是小图标，板只是其中一个。
 */
function PanelBoardIcon(props: { size?: number; active?: boolean }): ReturnType<typeof h> {
  const size = props.size ?? 18
  return h('svg', {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
  },
    h('rect', { x: 3.5, y: 4, width: 17, height: 16, rx: 2.5 }),
    h('path', { d: 'M3.5 9.2h17' }),
    h('path', { d: 'M9.2 9.2V20' }),
    h('path', { d: 'M12.8 13.2h4.4M12.8 16.6h4.4' }))
}
/** 状态徽标：颜色 + 形状 + 文字三重编码（色盲可用）。 */
function StatusChip(props: { status: string; label?: string }): ReturnType<typeof h> {
  const m = statusMeta(props.status)
  return h('span', { className: 'pb-status', style: { color: m.color }, 'data-status': props.status },
    h('span', { className: 'pb-status-shape', 'aria-hidden': 'true' }, m.shape),
    h('span', {}, props.label ?? m.label))
}

/** 分区（可折叠）：标题行带徽标，body 收起时不占位置。 */
function Zone(props: { title: string; badge?: string; open: boolean; onToggle: () => void; children?: unknown; id?: string }): ReturnType<typeof h> {
  return h('section', { className: 'pb-zone', role: 'region', 'aria-label': props.title, id: props.id },
    h('button', {
      className: 'pb-zonehead',
      'aria-expanded': props.open,
      onClick: props.onToggle,
      title: (props.open ? '收起' : '展开') + props.title,
    },
      h('span', { className: 'pb-zone-caret', 'aria-hidden': 'true' }, props.open ? '▾' : '▸'),
      h('span', { className: 'pb-zone-title' }, props.title),
      props.badge != null && props.badge !== '' ? h('span', { className: 'pb-badge' }, props.badge) : null),
    props.open ? h('div', { className: 'pb-zonebody' }, props.children as never) : null)
}

/** 空态：一句标题 + 一句可操作的话（不留白屏）。 */
function EmptyState(props: { kind: 'board' | 'tasks' | 'approvals' | 'events'; action?: unknown }): ReturnType<typeof h> {
  const c = emptyCopy(props.kind)
  return h('div', { className: 'pb-empty' },
    h('div', { className: 'pb-empty-title' }, c.title),
    h('div', { className: 'pb-empty-hint' }, c.hint),
    props.action != null ? h('div', { className: 'pb-empty-action' }, props.action as never) : null)
}

/** 加载态：微光骨架（别让人干等）。 */
function Skeleton(props: { rows?: number }): ReturnType<typeof h> {
  const rows = props.rows ?? 3
  return h('div', { className: 'pb-skel', 'aria-hidden': 'true' },
    Array.from({ length: rows }, (_, i) => h('div', { className: 'pb-skel-row', key: 'sk' + i, style: { width: (60 + ((i * 17) % 40)) + '%' } })))
}
/** tab 栏：role=tablist / tab / aria-selected，←/→ 与 1-4 直达。 */
function TabBar(props: { tab: PbTab; counts: Record<PbTab, number>; onChange: (t: PbTab) => void }): ReturnType<typeof h> {
  const { tab, counts, onChange } = props
  return h('div', { className: 'pb-tabs', role: 'tablist', 'aria-label': '面板分区' },
    TAB_ORDER.map(t => {
      const m = tabMeta(t, counts)
      const on = t === tab
      return h('button', {
        key: t,
        className: 'pb-tab' + (on ? ' pb-tab-on' : ''),
        role: 'tab',
        'aria-selected': on,
        tabIndex: on ? 0 : -1,
        onClick: () => onChange(t),
      },
        h('span', { className: 'pb-tab-label' }, m.label),
        h('span', { className: 'pb-badge' + (m.count === 0 ? ' pb-badge-dim' : '') }, String(m.count)))
    }))
}

/** 空画布占位：线框树 + 一句"怎么开始"（别只留一行字）。 */
function EmptyCanvas(): ReturnType<typeof h> {
  return h('div', { className: 'pb-emptycanvas' },
    h('svg', { viewBox: '0 0 220 124', width: 220, height: 124, 'aria-hidden': 'true' },
      h('rect', { x: 90, y: 8, width: 40, height: 18, rx: 6, fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, opacity: .55 }),
      h('path', { d: 'M110 26 V44 M60 56 H160 M60 44 V56 M160 44 V56 M60 74 V92', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, opacity: .35 }),
      h('rect', { x: 30, y: 56, width: 60, height: 18, rx: 6, fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, opacity: .55 }),
      h('rect', { x: 130, y: 56, width: 60, height: 18, rx: 6, fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, opacity: .55 }),
      h('rect', { x: 30, y: 92, width: 60, height: 18, rx: 6, fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, opacity: .3 })),
    h('div', { className: 'pb-empty-title' }, '还没有任务'),
    h('div', { className: 'pb-empty-hint' }, '先让 agent 生成一份计划：说一句话，plan_generate 会把它变成「计划 → 模块 → 任务」三层结构。'))
}
/** 任务清单的排序条。 */
function SortBar(props: { sort: 'status' | 'priority' | 'deps'; onChange: (s: 'status' | 'priority' | 'deps') => void }): ReturnType<typeof h> {
  const opts: { id: 'status' | 'priority' | 'deps'; label: string }[] = [
    { id: 'status', label: '按状态' }, { id: 'priority', label: '按优先级' }, { id: 'deps', label: '按依赖' },
  ]
  return h('div', { className: 'pb-sortbar' }, opts.map(o => h('button', {
    key: o.id,
    className: 'pb-canvasbtn' + (props.sort === o.id ? ' pb-canvasbtn-on' : ''),
    'aria-pressed': props.sort === o.id,
    onClick: () => props.onChange(o.id),
  }, o.label)))
}

/** 任务清单的一行（拆成组件：JSX 嵌套太深，括号容易数错）。 */
function TaskRow(props: { t: TopoNode; selected: boolean; onSelect: (id: string) => void }): ReturnType<typeof h> {
  const t = props.t
  return h('button', {
    className: 'pb-taskrow' + (props.selected ? ' pb-taskrow-on' : ''),
    onClick: () => props.onSelect(t.id),
  },
    h(StatusChip, { status: t.status }),
    h('span', { className: 'pb-monoid pb-taskrow-id' }, t.id),
    h('span', { className: 'pb-taskrow-title' }, t.title),
    h('span', { className: 'pb-taskrow-meta' }, '验收 ' + (t.acceptance?.length ?? 0) + ' · 依赖 ' + (t.deps?.length ?? 0)))
}
interface PanelBoundaryProps { children?: ReactNode; onReset: () => void }
interface PanelBoundaryState { error: Error | null }

/**
 * 面板自己的错误边界。
 * 宿主虽然有 SlotErrorBoundary，但它的崩溃面是**空 div**，而且会把条目永久退役（abdicate）
 * → 用户只看到一块空白、没有出口。这里自己接住：一句人话提示 + 一个"重新加载面板"按钮。
 */
class PanelBoundary extends Component<PanelBoundaryProps, PanelBoundaryState> {
  state: PanelBoundaryState = { error: null }
  componentDidCatch(error: Error): void {
    console.error('[dsh-plan-superagent] 面板渲染异常：', error)
    this.setState({ error })
  }
  render(): ReactNode {
    const err = this.state.error
    if (err != null) {
      return h('div', { className: 'pb-crash' },
        h('div', { className: 'pb-crash-title' }, '面板出错了'),
        h('div', { className: 'pb-crash-msg' }, '这一次的渲染抛了异常，导图与编辑卡先停在这里。'
          + (err.message !== '' ? '（' + clip(err.message, 140) + '）' : '')),
        h('button', { className: 'pb-crash-btn', onClick: () => { this.setState({ error: null }); this.props.onReset() } }, '重新加载面板'))
    }
    return this.props.children ?? null
  }
}

/** 面板外壳：错误边界 + 重挂载（崩了能自己回来，而不是留一块空白）。 */
function PanelHost(props: { sessionId?: string }): ReturnType<typeof h> {
  const [gen, setGen] = useState(0)
  return h(PanelBoundary, { onReset: () => setGen(g => g + 1) },
    h('div', { key: gen, style: { display: 'contents' } }, h(PaneWindow)))
}
function PaneWindow(): ReturnType<typeof h> | null {
  const [collapsed, setCollapsed] = useState(false)
  const [project, setProject] = useState(loadProject())
  const [data, setData] = useState<BoardData | null>(null)
  const [err, setErr] = useState('')
  const [nonce, setNonce] = useState(0)
  const [mode, setMode] = useState(appDark() ? 'dark' : 'light')
  const [drafts, setDrafts] = useState<Record<string, NodeDraft>>({})
  const [added, setAdded] = useState<AddedNode[]>([])
  const [removed, setRemoved] = useState<string[]>([])
  const [editorId, setEditorId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')
  const [depLine, setDepLine] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null)
  const [newChild, setNewChild] = useState('')
  const [recent, setRecent] = useState<{ project: string; name: string }[]>([])
  // ===== 待批提案编辑态 =====
  const [projListOpen, setProjListOpen] = useState(false)
  const [apEdits, setApEdits] = useState<Record<string, PbOp[]>>({})
  const [apBusy, setApBusy] = useState('')
  const [apRev, setApRev] = useState(0)
  // ===== 子导图（ designs/<taskId>.json ）=====
  const [designOpen, setDesignOpen] = useState(false)
  const [design, setDesign] = useState<PbDesign | null>(null)
  const [designMsg, setDesignMsg] = useState('')
  const [designBusy, setDesignBusy] = useState(false)
  // ===== 分区折叠 / 搜索 =====
  const [mapOpen, setMapOpen] = useState(true)
  const [apOpen, setApOpen] = useState(false)
  const [evOpen, setEvOpen] = useState(false)
  const [query, setQuery] = useState('')
  // 第 3 轮：面板分区（状态挂在面板根，切 tab 不丢草稿/选中/缩放/折叠）
  const [tab, setTab] = useState<PbTab>('map')
  const [taskSort, setTaskSort] = useState<'status' | 'priority' | 'deps'>('status')
  // 第 2 轮：模块折叠（moduleId -> 是否折叠）
  const [folded, setFolded] = useState<Record<string, boolean>>({})
  const searchRef = useRef<HTMLInputElement | null>(null)
  // 依赖候选项 = 板子上的节点（提案新增的节点在渲染时再并进来）
  const depOptions = useMemo<DepOption[]>(() => (data?.board.nodes ?? []).map(n => ({ id: n.id, title: n.title, type: n.type })), [data])
  const [view, setView] = useState({ k: 1, tx: 0, ty: 0 })
  const dragRef = useRef<{ kind: 'node'; id: string; sx: number; sy: number; bx: number; by: number; moved: boolean } | { kind: 'dep'; from: string } | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const editorRef = useRef<HTMLDivElement | null>(null)
  // /stream 重连定时器（清理时必须清掉，见下方 effect）
  const streamTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 「当前选中的任务」的最新值：异步回调要判断"回来的响应是不是还属于当前任务"，
  // 闭包里的 editorId 只是发起时的快照。每次渲染同步一次（幂等，React 严格模式下也安全）。
  const editorIdRef = useRef<string | null>(null)
  editorIdRef.current = editorId
  useEffect(() => {
    const t = setInterval(() => { const d = appDark(); setMode(prev => (prev === (d ? 'dark' : 'light') ? prev : (d ? 'dark' : 'light'))) }, 2000)
    return () => clearInterval(t)
  }, [])
  // 换任务时把子导图收起来（不同任务的子导图不是一个东西）
  useEffect(() => {
    setDesignOpen(false)
    setDesign(null)
    setDesignMsg('')
  }, [editorId])
  useEffect(() => {
    // 面板只在宿主把它挂上来的时候存在（main 槽），所以"可见"不需要再判断一次。
    // （旧代码这里判的是 open —— 那个状态在改成主区面板时已经删掉，却留在了代码里，
    //   于是 open 静默解析成全局 window.open：宿主没有它时这两个轮询 effect 直接 return，
    //   面板就永远不刷新。现在彻底不依赖任何全局 window.open。）
    if (!isAbsoluteProject(project)) return
    const ctrl = new AbortController()
    let stop = false
    const run = async (): Promise<void> => {
      try {
        const r = await fetch(API + '/stream?project=' + encodeURIComponent(project), { signal: ctrl.signal })
        const reader = r.body?.getReader()
        if (reader == null) return
        const dec = new TextDecoder()
        let buf = ''
        while (!stop) {
          const chunk = await reader.read()
          if (chunk.done) break
          buf += dec.decode(chunk.value, { stream: true })
          const lines = buf.split('\n')
          buf = lines.pop() ?? ''
          for (const line of lines) {
            if (line.trim() === '') continue
            try { const msg = JSON.parse(line) as { kind?: string }; if (msg.kind === 'event') setNonce(n => n + 1) } catch { /* 跳过坏行 */ }
          }
        }
      } catch { /* abort 或连接失败 */ }
      // 重连定时器记进 ref：清理时必须清掉，否则面板关掉/切项目后它仍会触发，
      // 又开一条没人管的 /stream 连接（关了面板还在动）
      if (!stop) {
        streamTimerRef.current = setTimeout(() => { streamTimerRef.current = null; void run() }, 3000)
      }
    };
    void run()
    return () => {
      stop = true
      ctrl.abort()
      if (streamTimerRef.current != null) { clearTimeout(streamTimerRef.current); streamTimerRef.current = null }
    }
  }, [project])
  useEffect(() => {
    if (!isAbsoluteProject(project)) return
    localStorage.setItem(PROJECT_KEY, project)
    let stop = false
    let inFlight = false
    const tick = async (): Promise<void> => {
      // in-flight 去重：上一次还没回来就不再发下一次，
      // 否则慢响应会后到并覆盖更新的板状态（面板显示旧板）
      if (inFlight) return
      inFlight = true
      try {
        const r = await fetch(API + '/state?project=' + encodeURIComponent(project))
        const j = await r.json() as Record<string, unknown>
        if (stop) return
        if (j.ok === true) { setData(j as unknown as BoardData); setErr('') }
        else setErr(String((j.error as { message?: string })?.message ?? '加载失败'))
      } catch (e) { if (!stop) setErr(String(e)) }
      finally { inFlight = false }
    };
    void tick()
    const t = setInterval(tick, POLL_MS)
    return () => { stop = true; clearInterval(t) }
  }, [project, nonce])
  ensureStyles()
  // 空态一键入口：列出注册表里最近打开过的项目（面板此前只有一个空输入框，用户不知道该填什么）
  useEffect(() => {
    let stop = false
    void (async () => {
      try {
        const r = await fetch(API + '/projects')
        const j = await r.json() as { ok?: boolean; projects?: Record<string, { name?: string; at?: string }> }
        if (stop || j.ok !== true || j.projects == null) return
        const list = Object.entries(j.projects)
          .map(([p, v]) => ({ project: p, name: String(v.name ?? p), at: String(v.at ?? '') }))
          .sort((x, y) => (x.at < y.at ? 1 : -1))
        setRecent(list)
      } catch { /* 注册表读取失败不影响手填路径 */ }
    })()
    return () => { stop = true }
  }, [nonce])
  const b = data?.board
  // ===== 直编辑：有效节点模型（服务端态 + 草稿叠加 − 已删 + 新增） =====
  const effNodes: BoardNode[] = useMemo(() => {
    if (data == null) return []
    const alive = data.board.nodes.filter(n => !removed.includes(n.id)).map(n => {
      const d = drafts[n.id]
      if (d == null) return n
      return { ...n, ...((d.fields ?? {}) as Partial<BoardNode>), pos: d.pos !== undefined ? d.pos : (n.pos ?? null) }
    });
    for (const a of added) alive.push({ id: a.id, type: a.type, parent: a.parent, title: a.title, status: 'planned', deps: [] })
    return alive
  }, [data, drafts, added, removed]);
  // 布局交给纯函数（分层树：模块分组块 + 父在子上居中 + 统一间距），useMemo 保证不重排
  const layout = useMemo<MapLayout>(() => layoutMap(effNodes as unknown as { id: string; type: string; title: string; parent: string | null; pos?: { x: number; y: number } | null }[], folded), [effNodes, folded])
  const foldAll = (v: boolean): void => {
    const next: Record<string, boolean> = {}
    for (const n of effNodes) if (n.type === 'module') next[n.id] = v
    setFolded(next)
  }
  const dirtyIds = useMemo(() => new Set([...Object.keys(drafts), ...added.map(a => a.id), ...removed]), [drafts, added, removed]);
  // ===== 聚焦卡：算出「现在该做什么」=====
  const focusPick = useMemo<FocusPick>(() => pickFocus(
    (data?.board.nodes ?? []).map(n => ({ id: n.id, type: n.type, status: n.status, title: n.title, deps: n.deps })),
    data?.order ?? {},
  ), [data])
  const focusKindLabel = focusPick.kind === 'doing' ? '进行中' : focusPick.kind === 'ready' ? '就绪' : focusPick.kind === 'blocked' ? '受阻' : '空闲'
  // ===== 第 2 轮：拓扑（状态/依赖/阻塞/聚焦）=====
  const topoNodes = useMemo<TopoNode[]>(() => (data?.board.nodes ?? []).map(n => ({
    id: n.id, type: n.type, status: n.status, title: n.title, deps: n.deps ?? [], parent: n.parent, acceptance: n.acceptance,
  })), [data])
  // 聚焦集合 = 主任务 + 它的上游依赖链；其余节点淡出但仍可见
  const focusIds = useMemo(() => focusChain(topoNodes, focusPick.taskId), [topoNodes, focusPick.taskId])
  // 挡住每个任务的前置任务（角标 + 依赖边高亮都用它）
  const blockers = useMemo(() => {
    const byId = new Map(topoNodes.map(n => [n.id, n]))
    const out: Record<string, string[]> = {}
    for (const n of topoNodes) { const u = unmetDepsOf(n, byId); if (u.length > 0) out[n.id] = u }
    return out
  }, [topoNodes])
  const focusTask = useMemo(() => topoNodes.find(n => n.id === focusPick.taskId), [topoNodes, focusPick.taskId])
  const focusBlockers = useMemo(() => blockersOf(topoNodes, focusPick.taskId, data?.order ?? {}), [topoNodes, focusPick.taskId, data])
  // 下一步可以做什么：ready 且依赖都满足
  const readyList = useMemo(() => nextSteps(topoNodes), [topoNodes])
  const toggleModule = (id: string): void => { setFolded(prev => ({ ...prev, [id]: prev[id] === true ? false : true })) }
  // 搜索只过滤导图（编辑/待批/聚焦卡都用全量数据）
  const q = query.trim().toLowerCase()
  const mapNodes = useMemo(() => (q === '' ? effNodes : effNodes.filter(n => n.title.toLowerCase().includes(q) || n.id.toLowerCase().includes(q))), [effNodes, q])
  // tab 徽标计数
  const tabCounts: Record<PbTab, number> = {
    map: mapNodes.length,
    approvals: b?.pendingApprovals.length ?? 0,
    tasks: topoNodes.filter(n => n.type === 'task').length,
    events: (data?.events ?? []).length,
  }

  /** 刷新：重拉 /state（重连流也顺带重开）。 */
  const refresh = (): void => { setNonce(n => n + 1) }
  /** 快捷键：/ 聚焦搜索、r 刷新、g 展开并聚焦导图、Esc 收起编辑。挂在面板根上，不劫持别的面板。 */
  const onPanelKey = (e: { key: string; target: unknown; preventDefault: () => void }): void => {
    const t = e.target as { tagName?: string; isContentEditable?: boolean } | null
    const tag = (t?.tagName ?? '').toUpperCase()
    const inField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable === true
    // tab 快捷键：←/→ 切换、1-4 直达（输入框里不抢）
    if (!inField) {
      if (e.key === 'ArrowRight') { e.preventDefault(); setTab(t => nextTab(t, 1)); return }
      if (e.key === 'ArrowLeft') { e.preventDefault(); setTab(t => nextTab(t, -1)); return }
      const byNum = tabByNumber(Number(e.key))
      if (byNum != null) { e.preventDefault(); setTab(byNum); return }
    }
    const sc = shortcutOf(e.key, inField)
    if (sc == null) return
    if (sc === 'close-editor') { setEditorId(null); setSaveMsg(''); return }
    e.preventDefault()
    if (sc === 'focus-search') searchRef.current?.focus()
    else if (sc === 'refresh') refresh()
    else if (sc === 'focus-map') { setMapOpen(true); setTimeout(() => svgRef.current?.scrollIntoView({ block: 'nearest' }), 0) }
  }
  // 打开编辑卡时优先保住导图可见（不跳屏）；只在卡片标题行整个落在视野外时才滚动一下
  useEffect(() => {
    if (editorId == null) return
    const el = editorRef.current
    if (el == null) return
    if (el.getBoundingClientRect().top > window.innerHeight - 40) el.scrollIntoView({ block: 'nearest' })
  }, [editorId])
  const dirtyCount = dirtyIds.size;
  const toSvg = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = svgRef.current?.getBoundingClientRect()
    return { x: (clientX - (rect?.left ?? 0) - view.tx) / view.k, y: (clientY - (rect?.top ?? 0) - view.ty) / view.k }
  };
  const setDraft = (id: string, patch: NodeDraft): void => {
    setDrafts(prev => ({ ...prev, [id]: { ...prev[id], ...patch, fields: { ...(prev[id]?.fields ?? {}), ...(patch.fields ?? {}) } } }))
  };
  const onNodePointerDown = (e: PEv, id: string, base: { x: number; y: number }): void => {
    if (id === '__root__') return
    const p = toSvg(e.clientX, e.clientY)
    dragRef.current = { kind: 'node', id, sx: p.x, sy: p.y, bx: base.x, by: base.y, moved: false }
    try { (e.target as Element).setPointerCapture?.(e.pointerId) } catch { /* 捕获失败走 svg 级 move */ }
  };
  const onNodeMove = (id: string, pos: { x: number; y: number }): void => {
    setDraft(id, { pos: { x: Math.round(pos.x), y: Math.round(pos.y) } })
  };
  // 点节点选中 -> 顺手切到「任务」tab（编辑卡在那里，不然点了节点看不到反应）
  const onNodeClick = (id: string): void => { setEditorId(prev => (prev === id ? null : id)); setSaveMsg(''); setTab('tasks') };
  const onHandlePointerDown = (e: PEv, id: string): void => { dragRef.current = { kind: 'dep', from: id } };
  const onDepDrop = (from: string, at: { clientX: number; clientY: number }): void => {
    // 落点用真实 DOM 命中（与「点节点」同一套判定，取视觉最上层节点）；
    // 旧实现按 layout.items 数组序 find——与绘制序不一致，会出现「拖到 A 却落到 B」（M2-3 验收 P2 修复）
    const el = document.elementFromPoint(at.clientX, at.clientY)
    const gEl = el != null ? el.closest('.pb-node') : null
    const hitId = gEl != null ? gEl.getAttribute('data-id') : null
    if (hitId == null || hitId === from || hitId === '__root__') return
    const tid = hitId
    const cur = effNodes.find(n => n.id === tid)
    if (cur == null || cur.type !== 'task') return
    const deps = [...(cur.deps ?? [])];
    const idx = deps.indexOf(from);
    if (idx >= 0) deps.splice(idx, 1); else deps.push(from);
    // 快速环检测（把目标节点 deps 替换后全图判环）
    const sim = effNodes.filter(n => !removed.includes(n.id)).map(n => (n.id === tid ? { ...n, deps } : { ...n, deps: [...(n.deps ?? [])] }));
    if (hasCycle(sim.filter(n => n.type === 'task'))) { setSaveMsg('⛔ 该依赖会成环，已拒绝（' + tid + ' ⇠ ' + from + '）'); return }
    setDraft(tid, { fields: { deps } })
    setSaveMsg('');
  };
  const addChild = (parentId: string): void => {
    const title = newChild.trim()
    if (title === '') return
    const id = 'pb-' + Date.now().toString(36);
    setAdded(prev => [...prev, { id, type: 'task', parent: parentId, title }])
    setNewChild('')
    setEditorId(id)
  };
  const removeNode = (id: string): void => {
    const node = effNodes.find(n => n.id === id);
    if (node == null) return
    if (effNodes.some(n => n.parent === id)) { setSaveMsg('⛔ 先删除其子任务/子模块'); return }
    if (!window.confirm('删除节点 ' + id + '（' + node.title + '）？')) return
    if (!window.confirm('确认：该操作随「保存更改」一并生效，且会自动剥离其他任务对它的依赖。')) return
    // 剥离他人 deps 中对它的引用（草稿态合并）
    for (const n of effNodes) {
      if (n.id === id) continue
      const ds = n.deps ?? [];
      if (ds.includes(id)) setDraft(n.id, { fields: { deps: ds.filter(d => d !== id) } })
    }
    setRemoved(prev => prev.includes(id) ? prev : [...prev, id])
    if (editorId === id) setEditorId(null)
  };
  const save = async (): Promise<void> => {
    if (saving || dirtyCount === 0) return
    const ops: unknown[] = [];
    for (const a of added) ops.push({ op: 'add_node', node: { id: a.id, type: a.type, parent: a.parent, title: a.title } });
    for (const [id, d] of Object.entries(drafts)) {
      if (removed.includes(id)) continue
      const fields: Record<string, unknown> = { ...(d.fields ?? {}) };
      if (d.pos != null) fields.pos = d.pos;
      if (Object.keys(fields).length === 0) continue
      ops.push({ op: 'update_node', id, fields });
    }
    for (const id of removed) ops.push({ op: 'remove_node', id });
    if (ops.length === 0) { setDrafts({}); setAdded([]); setRemoved([]); return }
    // 全图环检测（终态）
    const sim = effNodes.filter(n => !removed.includes(n.id)).map(n => {
      const d = drafts[n.id];
      return { id: n.id, deps: (d?.fields?.deps ?? n.deps ?? []) as string[] };
    }).filter(n => n.id !== '__root__');
    if (hasCycle(sim)) { setSaveMsg('⛔ 保存被拒绝：依赖成环'); return }
    setSaving(true); setSaveMsg('');
    try {
      const j = await post('/edit', { project, ops, note: 'panel:direct-edit' });
      if (j.ok === true) { setDrafts({}); setAdded([]); setRemoved([]); setEditorId(null); setNonce(n => n + 1) }
      else setSaveMsg('⛔ ' + String((j.error as { message?: string })?.message ?? '保存失败'));
    } catch (e) { setSaveMsg('⛔ ' + String(e)) }
    setSaving(false);
  };
  const discard = (): void => { setDrafts({}); setAdded([]); setRemoved([]); setEditorId(null); setSaveMsg('') }
  // ===== 子导图：读 / 写都走服务端接口（浏览器不直接碰文件）=====
  const loadDesign = async (taskId: string): Promise<void> => {
    if (!isAbsoluteProject(project)) { setDesignMsg('⚠ 先在上面填项目根目录绝对路径'); return }
    setDesignBusy(true)
    setDesignMsg('')
    try {
      const r = await fetch(API + '/design?project=' + encodeURIComponent(project) + '&taskId=' + encodeURIComponent(taskId))
      const j = await readJson(r)
      // 过期响应直接丢弃：请求途中用户可能已经切到别的任务了。迟到的内容落到新任务上，
      // 再点保存就会把上一个任务写进这个任务的文件（服务端数据损坏）。
      if (editorIdRef.current !== taskId) return
      if (j.ok !== true) { setDesignMsg('⛔ 读子导图失败：' + errText(j.error)); setDesign(null); return }
      // design 为 null = 这个任务没有子导图（不是错误，显示一句说明即可）
      setDesign(j.design == null ? null : normDesign(j.design))
    } catch (e) {
      if (editorIdRef.current !== taskId) return
      setDesignMsg('⛔ 读子导图失败：' + String(e)); setDesign(null)
    }
    if (editorIdRef.current === taskId) setDesignBusy(false)
  }
  const saveDesign = async (taskId: string): Promise<void> => {
    if (design == null) return
    // 保存前再核对一次目标就是当前任务：否则会把上一个任务的内容写进这个任务的文件
    if (editorIdRef.current !== taskId) { setDesignMsg('⛔ 当前任务已经切换，放弃保存（避免写错文件）'); return }
    setDesignBusy(true)
    setDesignMsg('')
    try {
      const j = await post('/design', { project, taskId, design: designToWire(design) })
      if (j.ok !== true) { setDesignMsg('⛔ 保存子导图失败：' + errText(j.error)); return }
      setDesign(j.design == null ? design : normDesign(j.design))
      setDesignMsg('✅ 子导图已保存')
    } catch (e) { setDesignMsg('⛔ 保存子导图失败：' + String(e)) }
    setDesignBusy(false)
  }
  const patchDesign = (p: Partial<PbDesign>): void => { setDesign(prev => (prev == null ? prev : { ...prev, ...p })) };
  // ===== 待批提案：确认时可带改过的 ops（服务端用提交的 ops 覆盖原提案再生效） =====
  const approveAp = async (ap: { id: string; ops: unknown[] }): Promise<void> => {
    const orig = normOps(ap.ops)
    const edited = apEdits[ap.id] ?? orig
    const body: Record<string, unknown> = { project, approvalId: ap.id, decision: 'approve' }
    // 只有人真改了才带 ops：不带 = 按原提案生效（对还没支持 ops 覆盖的服务端也安全）
    if (opsChanged(orig, edited)) body.ops = edited.map(toWire)
    setApBusy(ap.id)
    setSaveMsg('')
    try {
      const j = await post('/approve', body)
      if (j.ok === true) {
        setApEdits(prev => { const n = { ...prev }; delete n[ap.id]; return n })
        setNonce(n => n + 1)
      } else setSaveMsg('⛔ 批准失败：' + errText(j.error))
    } catch (e) { setSaveMsg('⛔ 批准失败：' + String(e)) }
    setApBusy('')
  }
  const rejectAp = async (ap: { id: string }): Promise<void> => {
    setApBusy(ap.id)
    try {
      const j = await post('/approve', { project, approvalId: ap.id, decision: 'reject' })
      if (j.ok === true) {
        setApEdits(prev => { const n = { ...prev }; delete n[ap.id]; return n })
        setNonce(n => n + 1)
      } else setSaveMsg('⛔ 驳回失败：' + errText(j.error))
    } catch (e) { setSaveMsg('⛔ 驳回失败：' + String(e)) }
    setApBusy('')
  }
  const editor = editorId != null ? effNodes.find(n => n.id === editorId) : undefined;
  const tasksOf = (pred: (n: BoardNode) => boolean): BoardNode[] => effNodes.filter(n => n.type === 'task' && !removed.includes(n.id) && pred(n));
  const fd = (editor != null ? drafts[editor.id]?.fields : undefined) ?? {};
  const dirtyField = (editorId2: string | null, k: string): boolean => editorId2 != null && drafts[editorId2]?.fields != null && (drafts[editorId2].fields as Record<string, unknown>)[k] !== undefined;
  // ===== 编辑卡（先计算后渲染） =====
  const editorChildren: ReturnType<typeof h>[] = []
  if (editor != null) {
    editorChildren.push(
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
        h('span', { className: 'pb-sec' }, '编辑 ' + editor.id + '（' + (editor.type === 'task' ? '任务' : '模块') + '）'),
        h('button', { className: 'pb-btn', style: { marginLeft: 'auto' }, onClick: () => setEditorId(null) }, '完成'),
      ),
    )
    editorChildren.push(h('label', {}, '标题' + (dirtyField(editor.id, 'title') ? ' ●' : ''),
      h('input', { value: fd.title ?? editor.title, onChange: (e: { target: { value: string } }) => setDraft(editor.id, { fields: { title: e.target.value } }) })))
    if (editor.type === 'task') {
      editorChildren.push(h('label', {}, '优先级' + (dirtyField(editor.id, 'priority') ? ' ●' : ''),
        h('select', { value: String(fd.priority ?? editor.priority ?? 3), onChange: (e: { target: { value: string } }) => setDraft(editor.id, { fields: { priority: Number(e.target.value) } }) },
          [1, 2, 3, 4, 5].map(pv => h('option', { key: pv, value: String(pv) }, 'P' + pv)))))
    }
    editorChildren.push(h('label', {}, '备注' + (dirtyField(editor.id, 'note') ? ' ●' : ''),
      h('textarea', { value: fd.note ?? editor.note ?? '', onChange: (e: { target: { value: string } }) => setDraft(editor.id, { fields: { note: e.target.value } }) })))
    if (editor.type === 'task') {
      editorChildren.push(h('label', {}, '验收标准（每行一条）' + (dirtyField(editor.id, 'acceptance') ? ' ●' : ''),
        h('textarea', { value: (fd.acceptance ?? editor.acceptance ?? []).join('\n'), onChange: (e: { target: { value: string } }) => setDraft(editor.id, { fields: { acceptance: e.target.value.split('\n').map(s => s.trim()).filter(Boolean) } }) })))
      editorChildren.push(h('label', {}, 'scope（每行一条路径前缀，目录以 / 结尾）' + (dirtyField(editor.id, 'scope') ? ' ●' : ''),
        h('textarea', { value: (fd.scope ?? editor.scope ?? []).join('\n'), onChange: (e: { target: { value: string } }) => setDraft(editor.id, { fields: { scope: e.target.value.split('\n').map(s => s.trim()).filter(Boolean) } }) })))
      const depDeps = (fd.deps ?? editor.deps ?? []) as string[]
      editorChildren.push(h('div', {},
        h('span', { className: 'pb-sec' }, '依赖（被此任务依赖的前置任务）' + (dirtyField(editor.id, 'deps') ? ' ●' : '')),
        tasksOf(n => n.id !== editor.id).map(dn => h('label', { className: 'pb-deprow', key: dn.id },
          h('input', { type: 'checkbox', checked: depDeps.includes(dn.id), onChange: (e: { target: { checked: boolean } }) => {
            const arr = ((fd.deps ?? editor.deps ?? []) as string[]).slice()
            const i2 = arr.indexOf(dn.id)
            if (e.target.checked && i2 < 0) arr.push(dn.id)
            if (!e.target.checked && i2 >= 0) arr.splice(i2, 1)
            setDraft(editor.id, { fields: { deps: arr } })
          } }),
          h('span', {}, '#' + (data?.order[dn.id] ?? '?') + ' ' + dn.id + ' ' + dn.title.slice(0, 22)))),
      ))
    }
    if (editor.type === 'task') {
      // ===== 子导图入口（功能实现步骤/文件/风险/测试）=====
      editorChildren.push(h('div', { className: 'pb-designbar' },
        h('button', {
          className: 'pb-btn pb-vio',
          onClick: () => {
            const next = !designOpen
            setDesignOpen(next)
            if (next) void loadDesign(editor.id)
          },
        }, designOpen ? '收起子导图' : '子导图' + (hasDesignPointer(fd.note ?? editor.note) ? ' ●' : '')),
        h('span', { className: 'pb-hint' }, '功能实现子导图（步骤 / 涉及文件 / 风险 / 测试），存在 .plan-board/designs/' + editor.id + '.json'),
      ))
      if (designOpen) {
        const d = design
        editorChildren.push(h('div', { className: 'pb-design' },
          designBusy && d == null ? h('div', { className: 'pb-hint' }, '读取子导图…') : null,
          !designBusy && d == null
            ? h('div', { className: 'pb-hint' }, '该任务没有子导图',
                h('button', { className: 'pb-btn', style: { marginLeft: '8px' }, onClick: () => { setDesign(emptyDesign()); setDesignMsg('') } }, '新建空子导图'))
            : null,
          d != null ? h('div', { className: 'pb-form' },
            h('label', {}, '概述',
              h('textarea', { value: d.summary, onChange: (e: { target: { value: string } }) => patchDesign({ summary: e.target.value }) })),
            h('div', { className: 'pb-oplabel' }, '步骤（有序）',
              h('ol', { className: 'pb-designsteps' },
                d.steps.map((s, i) => h('li', { key: 'ds' + i },
                  h('input', {
                    value: s,
                    onChange: (e: { target: { value: string } }) => patchDesign({ steps: d.steps.map((x, k) => (k === i ? e.target.value : x)) }),
                  }),
                  h('button', { className: 'pb-btn', onClick: () => patchDesign({ steps: d.steps.filter((_, k) => k !== i) }) }, '删')))),
              h('button', { className: 'pb-btn', onClick: () => patchDesign({ steps: [...d.steps, ''] }) }, '＋步骤')),
            h('label', {}, '涉及文件（每行一条）',
              h('textarea', { value: d.files.join('\n'), onChange: (e: { target: { value: string } }) => patchDesign({ files: splitLines(e.target.value) }) })),
            h('label', {}, '风险（每行一条）',
              h('textarea', { value: d.risks.join('\n'), onChange: (e: { target: { value: string } }) => patchDesign({ risks: splitLines(e.target.value) }) })),
            h('label', {}, '怎么验（每行一条）',
              h('textarea', { value: d.tests.join('\n'), onChange: (e: { target: { value: string } }) => patchDesign({ tests: splitLines(e.target.value) }) })),
            Object.keys(d.extra).length > 0
              ? h('div', { className: 'pb-oplabel' }, '其它字段（只读，保存时原样带回）',
                  h('div', { className: 'pb-designextra' }, JSON.stringify(d.extra, null, 2)))
              : null,
            h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
              h('button', { className: 'pb-btn pb-ok', disabled: designBusy, onClick: () => { void saveDesign(editor.id) } }, designBusy ? '保存中…' : '保存子导图'),
              designMsg !== '' ? h('span', { className: 'pb-hint' }, designMsg) : null),
          ) : null,
          d == null && designMsg !== '' ? h('div', { className: 'pb-hint' }, designMsg) : null,
        ))
      }
    }
    if (editor.type === 'module') {
      editorChildren.push(h('div', { style: { display: 'flex', gap: '6px' } },
        h('input', { className: 'pb-input', style: { flex: 1 }, value: newChild, placeholder: '新子任务标题（回车或点按钮加入，保存后生效）', onChange: (e: { target: { value: string } }) => setNewChild(e.target.value), onKeyDown: (e: { key: string }) => { if (e.key === 'Enter') addChild(editor.id) } }),
        h('button', { className: 'pb-btn pb-vio', disabled: newChild.trim() === '', onClick: () => addChild(editor.id) }, '＋子任务')))
    }
    editorChildren.push(h('div', { style: { display: 'flex', gap: '8px' } },
      h('button', { className: 'pb-btn pb-no', onClick: () => removeNode(editor.id) }, '删除节点'),
      h('span', { className: 'pb-hint', style: { alignSelf: 'center' } }, editor.type === 'task' ? '状态流转与证据走 task_update（L3 证据门），不在面板直改' : '模块删除需先清空子任务')))
  }
  const editorCard = editor != null ? h('div', { className: 'pb-card pb-form', key: 'editor', ref: editorRef }, editorChildren) : null
  return h('div', {
    className: 'pb-panel',
    'data-mode': mode,
    'data-collapsed': collapsed ? 'true' : undefined,
    role: 'region',
    'aria-label': 'PlanBoard 规划面板',
    // 分区键盘可达：面板根可聚焦，快捷键挂在它身上（不劫持别的面板/聊天框）
    tabIndex: 0,
    onKeyDown: onPanelKey,
  },
    // ===== 顶栏（常驻）：项目切换 · 状态徽标 · 刷新 =====
    h('div', { className: 'pb-topbar' },
      h('div', { className: 'pb-topbar-row' },
        h('span', { className: 'pb-brand' }, '🗺 PlanBoard'),
        h(StatusChip, { status: focusPick.kind === 'idle' ? 'planned' : focusPick.kind, label: focusKindLabel }),
        h('input', {
          className: 'pb-input pb-grow',
          value: project,
          placeholder: '项目根目录绝对路径，如 C:\\path\\to\\project',
          'aria-label': '项目根目录绝对路径',
          onChange: (e: { target: { value: string } }) => setProject(e.target.value),
          onBlur: () => { void rememberProject(project) },
        }),
        h('input', {
          className: 'pb-input pb-search',
          ref: searchRef,
          value: query,
          placeholder: '搜索任务（/）',
          'aria-label': '搜索任务',
          onChange: (e: { target: { value: string } }) => setQuery(e.target.value),
        }),
        h('button', { className: 'pb-btn', 'aria-label': '刷新板面', title: '刷新板面（快捷键 r）', onClick: () => { refresh() } }, '⟳ 刷新'),
        h('button', { className: 'pb-btn', onClick: () => setCollapsed(v => !v) }, collapsed ? '展开' : '收起')),
      h('div', { className: 'pb-topbar-row pb-tags' },
        h('span', { className: 'pb-hint' }, '最近项目：'),
        recent.length === 0 ? h('span', { className: 'pb-hint' }, '（还没有记录）') : null,
        recent.slice(0, 12).map(r => h('button', {
          key: r.project,
          className: 'pb-tag' + (r.project === project ? ' pb-on' : ''),
          title: r.project,
          'aria-label': '切换到项目 ' + r.project,
          onClick: () => { setProject(r.project); setSaveMsg(''); void rememberProject(r.project) },
        }, clip(r.name, 18))))),
    // ===== 错误条：面板内可见 + 重试（不是只有一层空白）=====
    err !== '' ? h('div', { className: 'pb-errbar', role: 'alert' },
      h('span', { style: { flex: 1 } }, '⚠ ' + err),
      h('button', { className: 'pb-btn', onClick: () => { refresh() } }, '重试')) : null,
    // ===== 加载态：骨架（别干等）=====
    data == null && err === ''
      ? h('div', { className: 'pb-body' }, h(Skeleton, { rows: 4 }))
      : b == null ? h('div', { className: 'pb-body' },
        h('div', { className: 'pb-card' },
          h(EmptyState, { kind: 'board' }),
          recent.length > 0 ? h('div', { className: 'pb-empty-action' },
            recent.slice(0, 6).map(r => h('button', {
              key: r.project, className: 'pb-btn', title: r.project, 'aria-label': '切换到项目 ' + r.project,
              onClick: () => { setProject(r.project); void rememberProject(r.project) },
            }, r.name))) : null),
      ) : h('div', { className: 'pb-body' },
        dirtyCount > 0 ? h('div', { className: 'pb-banner pb-dirty' },
          '● ' + dirtyCount + ' 项未保存更改（拖拽位置/内容/依赖/增删，保存后才生效）',
          h('button', { className: 'pb-btn pb-ok', style: { marginLeft: 'auto' }, disabled: saving, onClick: () => { void save() } }, saving ? '保存中…' : '保存更改'),
          h('button', { className: 'pb-btn', disabled: saving, onClick: discard }, '放弃'),
        ) : null,
        saveMsg !== '' ? h('div', { className: 'pb-banner pb-drift' }, saveMsg) : null,
        b.driftBlock != null ? h('div', { className: 'pb-banner pb-drift' },
          '⛔ 漂移阻断: ' + b.driftBlock.reason,
          h('button', {
            className: 'pb-btn pb-ok', style: { marginLeft: 'auto' },
            onClick: () => { void post('/unblock', { project }).then(() => refresh()) },
          }, '解除阻断')) : null,
        (data?.guard?.suspended ? h('div', { className: 'pb-banner pb-hold' },
          '⏸ L7 越界拦截已挂起（仅内存态，重启后自动恢复拦截）',
          h('button', {
            className: 'pb-btn pb-ok', style: { marginLeft: 'auto' },
            onClick: () => { void post('/guard', { project, suspended: false }).then(() => refresh()) },
          }, '恢复拦截')) : null),
        ((): ReturnType<typeof h> | null => {
          const blocks = (data?.events ?? []).filter(ev => ev.kind === 'guard_block')
          if (blocks.length === 0 || data?.guard?.suspended) return null
          const last = blocks[blocks.length - 1]
          return h('div', { className: 'pb-banner pb-guard' },
            '🛡 L7 越界拦截 ' + blocks.length + ' 次: ' + (last.payload?.tool ?? '?') + ' → ' + (last.payload?.path ?? '?') + '（任务 ' + (last.payload?.taskId ?? '?') + '）',
            h('button', {
              className: 'pb-btn', style: { marginLeft: 'auto' },
              onClick: () => { void post('/guard', { project, suspended: true }).then(() => refresh()) },
            }, '暂停拦截'))
        })(),
        // ===== 聚焦卡：第一屏就说清「现在该做什么」=====
        h('section', { className: 'pb-focus', role: 'region', 'aria-label': '现在该做什么' },
          h('div', { className: 'pb-focus-kicker' }, '现在该做什么'),
          h('div', { className: 'pb-focus-main' },
            focusPick.taskId != null ? h(StatusChip, { status: focusPick.kind }) : null,
            h('span', { className: 'pb-focus-title' }, focusPick.title !== '' ? focusPick.title : focusPick.detail),
            focusPick.taskId != null ? h('span', { className: 'pb-focus-id' }, focusPick.taskId) : null,
            focusPick.taskId != null
              ? h('button', { className: 'pb-btn', 'aria-label': '编辑 ' + focusPick.title, onClick: () => { setEditorId(focusPick.taskId); setMapOpen(true) } }, '编辑')
              : null),
          // 验收标准摘要（第一轮只给了标题，这一轮给「要做到什么」）
          focusTask != null ? h('div', { className: 'pb-focus-detail' }, '验收：' + acceptanceSummary(focusTask)) : null,
          // 为什么还没轮到我
          focusBlockers.length > 0 ? h('div', { className: 'pb-focus-blocked' },
            h('span', { className: 'pb-focus-sub' }, '为什么还没轮到我'),
            h('div', { className: 'pb-focus-blocked-list' }, focusBlockers.map(t => h('span', { className: 'pb-focus-blocked-item', key: 'bl' + t.id },
              h(StatusChip, { status: t.status }), t.id + ' ' + t.title)))) : null,
          // 下一步可以做什么（可直接点开那个任务）
          readyList.length > 0 ? h('div', { className: 'pb-next' },
            h('span', { className: 'pb-focus-sub' }, '下一步可以做什么'),
            h('div', { className: 'pb-next-list' }, readyList.map(t => h('button', {
              key: 'ns' + t.id, className: 'pb-next-item',
              'aria-label': '打开任务 ' + t.id + ' ' + t.title,
              onClick: () => { setEditorId(t.id); setMapOpen(true) },
            }, h(StatusChip, { status: t.status }), t.id + ' ' + t.title)))) : null,
          h('div', { className: 'pb-focus-hint' }, focusPick.hint)),
        // ===== Tab 栏（吸顶）+ Tab 内容区（只渲染当前 tab）=====
    h(TabBar, { tab, counts: tabCounts, onChange: (t: PbTab) => setTab(t) }),
    h('div', { className: 'pb-tabbody', role: 'tabpanel', 'aria-label': tabMeta(tab, tabCounts).label },
      // --- 导图 ---
      tab === 'map'
        ? (mapNodes.length === 0
          ? h(EmptyCanvas, {})
          : h(MindMap, { data: data as BoardData, effNodes: mapNodes, layout, dirtyIds, view, setView, dragRef, depLine, setDepLine, editorId, onNodePointerDown, onNodeMove, onNodeClick, onDepDrop, onHandlePointerDown, svgRef, folded, focusIds, blockers, onToggleModule: toggleModule, onFoldAll: foldAll } as never))
        : null,
      // --- 待批 ---
      tab === 'approvals'
        ? (b.pendingApprovals.length === 0
          ? h(EmptyState, { kind: 'approvals' })
          : h('div', { className: 'pb-tablist' }, b.pendingApprovals.map(ap => {
            const orig = normOps(ap.ops)
            const ops = apEdits[ap.id] ?? orig
            const extra: DepOption[] = []
            for (const o of ops) if (o.op === 'add_node') extra.push({ id: o.node.id, title: o.node.title, type: o.node.type })
            return h(ApprovalCard, {
              key: ap.id,
              ap,
              ops,
              origOps: orig,
              dirty: opsChanged(orig, ops),
              cycle: proposalCycle(b.nodes, ops),
              issues: proposalParentIssues(b.nodes, ops),
              options: mergeDepOptions(depOptions, extra),
              busy: apBusy === ap.id,
              rev: apRev,
              onOps: (next: PbOp[]) => { setApEdits(prev => ({ ...prev, [ap.id]: next })) },
              onReset: () => {
                setApEdits(prev => { const n = { ...prev }; delete n[ap.id]; return n })
                setApRev(r => r + 1)
              },
              onApprove: () => { void approveAp(ap) },
              onReject: () => { void rejectAp(ap) },
            })
          })))
        : null,
      // --- 任务清单 + 右侧编辑卡 ---
      tab === 'tasks'
        ? h('div', { className: 'pb-tasks' },
          h('div', { className: 'pb-tasklist' },
            h('div', { className: 'pb-tasklist-head' },
              h('span', { className: 'pb-sec' }, '任务'),
              h(SortBar, { sort: taskSort, onChange: (s) => setTaskSort(s) })),
            taskRows(topoNodes, data?.order ?? {}, taskSort).map(g => h('div', { key: g.moduleId ?? 'none', className: 'pb-taskgroup' },
              h('div', { className: 'pb-taskgroup-title' }, g.moduleTitle),
              g.tasks.map(t => h(TaskRow, { key: t.id, t, selected: editorId === t.id, onSelect: (id) => { setEditorId(id); setSaveMsg('') } }))))),
          h('div', { className: 'pb-taskedit' },
            editor != null ? editorCard : h('div', { className: 'pb-hint' }, '点左边的任务，这里会出现编辑卡（标题 / 验收 / scope / 依赖 / 子导图）')),
        )
        : null,
      // --- 事件流 ---
      tab === 'events'
        ? ((data?.events ?? []).length === 0
          ? h(EmptyState, { kind: 'events' })
          : h('div', { className: 'pb-card' },
            (data?.events ?? []).slice(-40).reverse().map(ev => h('div', { className: 'pb-ev', key: ev.seq },
              h('span', {}, new Date(ev.ts).toLocaleTimeString()),
              h('span', { style: { fontWeight: 700 } }, ev.kind),
              h('span', { style: { opacity: .7 } }, ev.actor)))))
        : null,
      )))
}

/** 宿主 locale 服务：注册字典 + 绑一个 t(key)。 */
interface LocaleLike {
  register(ns: string, dicts: Record<string, Record<string, string>>): unknown
  bind(ns: string): (key: string) => string
}
type SlotsCtx = {
  slots: {
    inject(slot: string, register: () => unknown): void
    register(meta: Record<string, unknown>, component?: unknown): unknown
  }
  effect(fn: () => unknown, label?: string): void
  locale: LocaleLike
}

/** 客户端模块要的服务：slots（插槽）+ locale（侧栏图标的字典）。 */
export const inject = ['slots', 'locale']

export function apply(ctx: SlotsCtx): void {
  // 侧栏图标的显示名走 locale（跟引擎一个姿势：注册字典 -> bind -> label: () => t('panel')）
  ctx.effect(() => ctx.locale.register(NS, LOCALE_DICT), NS + ': dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.effect(() => {
    // 主区面板（main 是 keyed 槽）：点侧栏图标就在主区打开板 —— 宿主自己排版，不盖聊天区。
    ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main',
      key: PANEL_ID,
      locale: NS,
      inject: () => ({}),
    }, PanelHost as unknown as (props: never) => unknown))
    // 侧栏图标（sidebar.panellist 是 list 槽）：id 必须全宿主唯一，重复会抛
    // "already has an entry with id"；order 11 = 排在引擎(10)后面，别抢位置。
    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist',
      id: PANEL_ID,
      order: 11,
      label: () => t('panel'),
      locale: NS,
    }, PanelBoardIcon as unknown as (props: never) => unknown))
    // 输入框左侧的模式开关（conversation.input.left）：这是模式开关，不是板入口，保留。
    // inject 收到的第一个实参就是会话 id（宿主 slots 的 runInject 把 scope 绑定 key 传进来）。
    ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
      name: 'conversation.input.left',
      id: NS + ':mode',
      // order 排在宿主自带控件之后（模型/权限那排），别把人家挤走
      order: 0.5,
      inject: (sessionId: string) => ({ sessionId }),
    }, PlanBoardModeChip as unknown as (props: never) => unknown))
  }, NS + ':ui')
}
