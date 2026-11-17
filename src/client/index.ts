/**
 * dsh-plan-superagent client：右侧停靠面板（shell.overlay）+ 侧栏入口（header.utilities）。
 * 两必坑（骨架实测）：apply 用 ctx.slots 必须 export const inject = ['slots']；register 必带 name。
 * M2 第一批：/stream NDJSON 实时 + 主题跟随（采样 body 亮度）。
 * M2 第三批（本文件主体）：面板直编辑——点选节点出编辑卡（标题/备注/验收/scope/优先级/依赖多选）、
 * 自由拖拽节点（位置持久化 pos）、拖拽连线改依赖（A 拖到 B = B 依赖 A，再拖一次 = 移除）、
 * ＋子任务 / 删除节点；一切改动先进草稿态，点「保存更改」才 POST /edit 生效（用户拍板：不保存不生效）。
 */
import { createElement as h, useEffect, useMemo, useRef, useState } from 'react'
import type { MutableRefObject, RefObject } from 'react'

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

let openState = false
function togglePanel(): void {
  openState = !openState
  window.dispatchEvent(new CustomEvent('dsh-plan-superagent:toggle'))
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
  '.pb-panel{--pb-bg:#f8fafc;--pb-ink:#0f172a;--pb-line:#e2e8f0;--pb-card:#ffffff;--pb-muted:#64748b;',
  'position:fixed;top:0;right:0;bottom:0;width:min(560px,46vw);z-index:60;display:flex;flex-direction:column;',
  'background:var(--pb-bg);color:var(--pb-ink);border-left:1px solid var(--pb-line);box-shadow:-8px 0 24px rgba(15,23,42,.10)}',
  '.pb-panel[data-mode="dark"]{--pb-bg:#0f141c;--pb-ink:#e2e8f0;--pb-line:#1e293b;--pb-card:#151b26;--pb-muted:#7c8798}',
  '.pb-head{display:flex;gap:8px;align-items:center;padding:10px 12px;border-bottom:1px solid var(--pb-line)}',
  '.pb-title{font-weight:700;font-size:13px;letter-spacing:.4px}',
  '.pb-input{flex:1;min-width:0;font:12px/1.4 ui-monospace,monospace;padding:5px 8px;border-radius:8px;',
  'border:1px solid var(--pb-line);background:var(--pb-card);color:var(--pb-ink)}',
  '.pb-btn{cursor:pointer;padding:5px 12px;border-radius:8px;font-size:12px;font-weight:600;',
  'border:1px solid var(--pb-line);background:var(--pb-card);color:var(--pb-ink)}',
  '.pb-btn:hover{filter:brightness(1.08)}',
  '.pb-btn.pb-ok{background:#10b981;border-color:#10b981;color:#fff}',
  '.pb-btn.pb-no{background:#ef4444;border-color:#ef4444;color:#fff}',
  '.pb-btn.pb-vio{background:#8b5cf6;border-color:#8b5cf6;color:#fff}',
  '.pb-btn:disabled{opacity:.5;cursor:not-allowed}',
  '.pb-body{flex:1;min-height:0;overflow:auto;padding:10px 12px;display:flex;flex-direction:column;gap:10px}',
  '.pb-banner{padding:8px 12px;border-radius:10px;font-size:12px;font-weight:600;display:flex;gap:8px;align-items:center}',
  '.pb-banner.pb-drift{background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.5);color:#ef4444}',
  '.pb-banner.pb-appr{background:rgba(245,158,11,.10);border:1px solid rgba(245,158,11,.45);color:#b45309}',
  '[data-mode="dark"] .pb-banner.pb-appr{color:#fbbf24}',
  '.pb-banner.pb-guard{background:rgba(139,92,246,.10);border:1px solid rgba(139,92,246,.5);color:#7c3aed}',
  '[data-mode="dark"] .pb-banner.pb-guard{color:#a78bfa}',
  '.pb-banner.pb-hold{background:rgba(100,116,139,.10);border:1px dashed rgba(100,116,139,.55);color:#64748b}',
  '[data-mode="dark"] .pb-banner.pb-hold{color:#94a3b8}',
  '.pb-banner.pb-dirty{background:rgba(245,158,11,.14);border:1px solid rgba(245,158,11,.6);color:#b45309;position:sticky;top:0;z-index:5}',
  '[data-mode="dark"] .pb-banner.pb-dirty{color:#fbbf24}',
  '.pb-card{background:var(--pb-card);border:1px solid var(--pb-line);border-radius:10px;padding:8px 10px;font-size:12px}',
  '.pb-sec{font-size:11px;font-weight:700;letter-spacing:1px;color:var(--pb-muted);text-transform:uppercase}',
  '.pb-ev{display:flex;gap:8px;font:11px ui-monospace,monospace;color:var(--pb-muted);padding:1px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.pb-station{animation:pb-pulse 1.6s ease-in-out infinite}',
  '@keyframes pb-pulse{0%,100%{opacity:.35}50%{opacity:1}}',
  // flex:0 0 auto —— 面板 body 是 flex column，导图必须拒绝被编辑卡挤扁（M2-3 验收 P1 修复）
  '.pb-map{flex:0 0 auto;background:var(--pb-card);border:1px solid var(--pb-line);border-radius:12px;overflow:hidden;cursor:grab}',
  '.pb-map text{font-family:ui-sans-serif,system-ui,sans-serif;fill:var(--pb-ink,#0f172a)}',
  '.pb-node{cursor:grab}',
  '.pb-node.pb-dragging{cursor:grabbing}',
  '.pb-handle{cursor:crosshair}',
  '.pb-hint{font-size:11px;color:var(--pb-muted);line-height:1.6}',
  '.pb-form{display:flex;flex-direction:column;gap:8px}',
  '.pb-form label{display:flex;flex-direction:column;gap:3px;font-size:11px;font-weight:600;color:var(--pb-muted)}',
  '.pb-form input,.pb-form textarea,.pb-form select{font:12px/1.5 ui-sans-serif,system-ui,sans-serif;padding:5px 8px;border-radius:8px;',
  'border:1px solid var(--pb-line);background:var(--pb-bg);color:var(--pb-ink)}',
  '.pb-form textarea{min-height:44px;resize:vertical;font:12px/1.5 ui-monospace,monospace}',
  '.pb-deprow{display:flex;align-items:center;gap:6px;font-size:12px;padding:2px 0}',
  '.pb-dot{width:6px;height:6px;border-radius:50%;background:#f59e0b;display:inline-block}',
  // ===== 入口按钮（A 极光玻璃 + C 能量核心）：高度 31px、圆角 999px，与「Android 面板」严格对齐 =====
  // 深色极光玻璃（两种主题同款，对齐概念稿 A）：内层近黑玻璃(padding-box) + 外层青→紫→洋红渐变描边(border-box)
  // 收起/展开：本按钮在 headerUtilities 里是流内 flex item（右邻「⋯ 更多操作」保持 8px 槽位间距），
  // 因此宽度变化只会向左生长——右缘天然固定，邻居变化时实时重排。
  '.pb-entry{--pb-ease:cubic-bezier(.22,1,.36,1);--pb-dur:.42s;--pb-stat:#a855f7;',
  // 收起时 5.5px 内边距 + 1px 边框 = 31×31 整；圆角与展开态同值 15.5px（= 高度/2）：
  // 31×31 上即正圆，展开成胶囊时弧度完全连续，不会出现「方角 → 胶囊」的弧度跳变（用户 2026-09-16 要求统一）。
  'position:relative;display:inline-flex;align-items:center;gap:0;box-sizing:border-box;height:31px;padding:0 5.5px;',
  'border-radius:15.5px;cursor:pointer;overflow:hidden;user-select:none;vertical-align:middle;line-height:1;',
  'font-size:12.5px;font-weight:600;letter-spacing:.2px;color:#f3f7ff;border:1px solid transparent;',
  'background:linear-gradient(135deg,#080b14 0%,#0b0918 55%,#120a20 100%) padding-box,linear-gradient(112deg,#22d3ee 0%,#38bdf8 24%,#8b5cf6 58%,#e879f9 100%) border-box;',
  'box-shadow:0 0 0 1px rgba(139,92,246,.20),0 2px 12px rgba(56,189,248,.30),0 2px 18px rgba(232,121,249,.24),inset 0 0 14px rgba(124,58,237,.35),inset 0 1px 0 rgba(255,255,255,.07);',
  'transition:transform .16s cubic-bezier(.34,1.56,.64,1),box-shadow .28s,filter .28s,padding var(--pb-dur) var(--pb-ease),border-radius var(--pb-dur) var(--pb-ease)}',
  // 状态色（收起态只剩图标时靠它继续传达站位语义：图标光晕 + 悬停时的状态点）
  '.pb-entry[data-stat="clean"]{--pb-stat:#22d3ee}',
  '.pb-entry[data-stat="work"]{--pb-stat:#f59e0b}',
  '.pb-entry[data-stat="block"]{--pb-stat:#ef4444}',
  '.pb-entry[data-stat="none"]{--pb-stat:#94a3b8}',
  '.pb-entry .pb-halo-stop{stop-color:var(--pb-stat)}',
  // 浅色主题不反白：保持深色玻璃，仅加强外发光，让它在白底上"跳"出来
  '.pb-entry[data-mode="light"]{box-shadow:0 0 0 1px rgba(139,92,246,.22),0 2px 14px rgba(56,189,248,.40),0 2px 22px rgba(232,121,249,.30),inset 0 0 14px rgba(124,58,237,.35),inset 0 1px 0 rgba(255,255,255,.08)}',
  // 极光内层：三点径向叠加（悬停/开启时增亮呼吸）
  '.pb-entry .pb-aurora{position:absolute;inset:0;border-radius:inherit;pointer-events:none;opacity:.85;transition:opacity .3s;',
  'background:radial-gradient(58% 120% at 12% 18%,rgba(34,211,238,.36),transparent 62%),radial-gradient(52% 128% at 88% 30%,rgba(232,121,249,.32),transparent 64%),radial-gradient(72% 140% at 50% 128%,rgba(139,92,246,.32),transparent 66%)}',
  // 流光描边环：conic 渐变 + mask 挖空成 1px 环，悬停/开启时旋转
  '.pb-entry .pb-ring{position:absolute;inset:0;border-radius:inherit;padding:1px;opacity:0;transition:opacity .25s;pointer-events:none;',
  'background:conic-gradient(from 0deg,transparent 0 40%,rgba(34,211,238,.95) 58%,rgba(139,92,246,1) 72%,rgba(232,121,249,.95) 86%,transparent 100%);',
  '-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;',
  'mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);mask-composite:exclude}',
  '.pb-entry.pb-on .pb-ring,.pb-entry:hover .pb-ring{opacity:1;animation:pb-ring-spin 2.6s linear infinite}',
  '@keyframes pb-ring-spin{to{transform:rotate(360deg)}}',
  '.pb-entry .pb-shine{position:absolute;top:-20%;left:-65%;width:38%;height:140%;pointer-events:none;opacity:0;',
  'background:linear-gradient(100deg,transparent,rgba(255,255,255,.55),transparent);transform:skewX(-18deg)}',
  '.pb-entry:hover .pb-shine{animation:pb-shine .9s ease}',
  '@keyframes pb-shine{0%{left:-65%;opacity:.9}100%{left:135%;opacity:0}}',
  // 能量核心图标（C）：轨道虚线流动 + 双卫星脉冲 + 核心呼吸
  '.pb-entry .pb-orb{position:relative;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;flex:none;',
  'transition:transform .2s cubic-bezier(.34,1.56,.64,1)}',
  '.pb-entry .pb-orb svg{width:18px;height:18px;display:block;overflow:visible}',
  '.pb-entry .pb-core{transform-box:fill-box;transform-origin:center;animation:pb-core 2.8s ease-in-out infinite}',
  '@keyframes pb-core{0%,100%{transform:scale(1);opacity:.92}50%{transform:scale(1.18);opacity:1}}',
  '@keyframes pb-dash{to{stroke-dashoffset:-14}}',
  '.pb-entry .pb-sat{transform-box:fill-box;transform-origin:center;animation:pb-sat 2.8s ease-in-out infinite}',
  '.pb-entry .pb-sat.s2{animation-delay:.45s}',
  '@keyframes pb-sat{0%,100%{transform:scale(.72);opacity:.5}50%{transform:scale(1.15);opacity:1}}',
  '.pb-entry:hover .pb-orb{transform:rotate(-6deg)}',
  '.pb-entry:hover .pb-core{animation-duration:1.1s}',
  '.pb-entry:hover .pb-orbit{stroke-dasharray:4 3;animation:pb-dash .8s linear infinite}',
  '.pb-entry .pb-lwrap{display:inline-block;overflow:hidden;max-width:0;margin-left:0;transition:max-width var(--pb-dur) var(--pb-ease),margin-left var(--pb-dur) var(--pb-ease)}',
  '.pb-entry:hover .pb-lwrap,.pb-entry:focus-visible .pb-lwrap,.pb-entry.pb-on .pb-lwrap{max-width:var(--pb-lw,62px);margin-left:7px}',
  '.pb-entry .pb-label{display:inline-block;white-space:nowrap;opacity:0;transform:translateX(-5px);transition:opacity .2s ease,transform .34s var(--pb-ease);',
  'text-shadow:0 1px 6px rgba(6,8,20,.75),0 0 12px rgba(139,92,246,.35)}',
  '.pb-entry:hover .pb-label,.pb-entry:focus-visible .pb-label,.pb-entry.pb-on .pb-label{opacity:1;transform:none;transition-delay:.07s}',
  // 状态点：灰=未设置/无板 · 青=干净 · 琥珀=有 doing · 红=漂移阻断
  '.pb-entry .pb-dot{width:0;height:7px;margin-left:0;opacity:0;border-radius:50%;flex:none;background:#94a3b8;',
  'transition:width var(--pb-dur) var(--pb-ease),margin-left var(--pb-dur) var(--pb-ease),background .25s,box-shadow .25s,opacity .3s}',
  '.pb-entry:hover .pb-dot,.pb-entry:focus-visible .pb-dot,.pb-entry.pb-on .pb-dot{width:7px;margin-left:7px;opacity:1}',
  '.pb-entry .pb-dot.pb-clean{background:#22d3ee;box-shadow:0 0 6px rgba(34,211,238,.65)}',
  '.pb-entry .pb-dot.pb-work{background:#f59e0b;box-shadow:0 0 8px rgba(245,158,11,.75);animation:pb-dot 2s ease-in-out infinite}',
  '.pb-entry .pb-dot.pb-block{background:#ef4444;box-shadow:0 0 9px rgba(239,68,68,.85);animation:pb-dot 1.1s ease-in-out infinite}',
  '@keyframes pb-dot{0%,100%{opacity:1}50%{opacity:.45}}',
  '.pb-entry .pb-dot.pb-none{background:#94a3b8;opacity:.55}',
  // 展开态（悬停 / 键盘聚焦 / 面板开启）：只改 padding（宽度随内容生长）+ 上浮/提亮 + 辉光。
  // 圆角两态同为 15.5px（= 高度/2，渲染结果与邻居的 999px 一致）：收起=正圆、展开=胶囊，
  // 弧度全程不动 —— 既没有「方角 → 胶囊」的跳变，也没有 999px 那种"超过半高即被 clamp、
  // 补间尾帧才突变"的问题（用户 2026-09-16 要求两态弧度统一）。
  // 悬停不再放大缩小（用户 2026-09-15 要求去掉）：避免与收起/展开的形变动效叠加。
  '.pb-entry:hover,.pb-entry:focus-visible,.pb-entry.pb-on{padding:0 12px 0 10px;transform:translateY(-1.5px);filter:brightness(1.12);',
  'box-shadow:0 0 0 1px rgba(168,85,247,.45),0 6px 26px rgba(124,58,237,.55),0 0 26px rgba(56,189,248,.40),0 0 30px rgba(232,121,249,.32),inset 0 0 18px rgba(124,58,237,.45)}',
  '.pb-entry:active{transform:translateY(0);transition-duration:.06s;',
  'box-shadow:0 1px 6px rgba(99,102,241,.4),inset 0 1px 0 rgba(255,255,255,.12)}',
  '.pb-entry:focus-visible{outline:2px solid rgba(168,85,247,.75);outline-offset:2px}',
  '.pb-entry.pb-on{box-shadow:0 0 0 1px rgba(168,85,247,.55),0 2px 16px rgba(124,58,237,.50),0 0 20px rgba(56,189,248,.28),inset 0 0 16px rgba(124,58,237,.45)}',
  '.pb-entry.pb-on .pb-aurora{opacity:1;animation:pb-aurora 3.2s ease-in-out infinite}',
  '@keyframes pb-aurora{0%,100%{opacity:.8;filter:saturate(1)}50%{opacity:1;filter:saturate(1.35)}}',
  '@media (prefers-reduced-motion:reduce){.pb-entry,.pb-entry *{animation:none!important;transition:none!important}}',
  // ===== 一句话生成 / 项目切换 / 提案编辑 =====
  '.pb-projrow{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:6px 12px;border-bottom:1px solid var(--pb-line);font-size:11px;color:var(--pb-muted)}',
  '.pb-projpath{font-family:ui-monospace,monospace;font-size:11px;color:var(--pb-ink);cursor:pointer;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.pb-tag{cursor:pointer;padding:2px 8px;border-radius:999px;font-size:11px;border:1px solid var(--pb-line);background:var(--pb-card);color:var(--pb-muted);max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.pb-tag.pb-on{border-color:#8b5cf6;color:#7c3aed;background:rgba(139,92,246,.12)}',
  '[data-mode="dark"] .pb-tag.pb-on{color:#a78bfa}',
  '.pb-tag:hover{filter:brightness(1.08)}',
  // 模式开关挂在宿主输入栏里（不在面板内），所以样式自带颜色：紫色主题 + color:inherit 跟随宿主文字色
  '.pb-modewrap{display:inline-flex;align-items:center;gap:6px;max-width:100%}',
  '.pb-modebtn{cursor:pointer;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:600;white-space:nowrap;',
  'border:1px solid rgba(139,92,246,.55);background:rgba(139,92,246,.12);color:inherit}',
  '.pb-modebtn:hover{filter:brightness(1.08)}',
  '.pb-modebtn.pb-on{background:#8b5cf6;border-color:#8b5cf6;color:#fff;box-shadow:0 0 0 1px rgba(139,92,246,.35),0 2px 10px rgba(124,58,237,.35)}',
  '.pb-modebtn:disabled{opacity:.5;cursor:not-allowed}',
  '.pb-modeerr{font-size:11px;color:#ef4444;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px}',
  '.pb-ops{border:1px dashed var(--pb-line);border-radius:8px;padding:6px;margin:6px 0;display:flex;flex-direction:column;gap:6px;background:rgba(100,116,139,.05)}',
  '.pb-oprow{border:1px solid var(--pb-line);border-radius:8px;padding:6px;display:flex;flex-direction:column;gap:5px;background:var(--pb-card)}',
  '.pb-ophead{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:700;color:var(--pb-muted)}',
  '.pb-chip{font:10px/1.4 ui-monospace,monospace;padding:1px 6px;border-radius:999px;background:rgba(139,92,246,.12);color:#7c3aed}',
  '[data-mode="dark"] .pb-chip{color:#a78bfa}',
  '.pb-oplabel{display:flex;flex-direction:column;gap:2px;font-size:10px;font-weight:600;color:var(--pb-muted)}',
  '.pb-oplabel input,.pb-oplabel textarea,.pb-oplabel select{font:11px/1.5 ui-sans-serif,system-ui,sans-serif;padding:3px 6px;border-radius:6px;border:1px solid var(--pb-line);background:var(--pb-bg);color:var(--pb-ink)}',
  '.pb-oplabel textarea{min-height:38px;resize:vertical;font:11px/1.5 ui-monospace,monospace}',
  '.pb-deps{display:flex;flex-direction:column;gap:2px;max-height:150px;overflow:auto;border:1px solid var(--pb-line);border-radius:6px;padding:4px;background:var(--pb-bg)}',
  '.pb-deps .pb-deprow{font-size:11px}',
  '.pb-cycle{font-size:11px;font-weight:700;color:#ef4444;line-height:1.5}',
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

/**
 * 入口按钮（A 极光玻璃 + C 能量核心）：高度 31px、胶囊圆角 999px，与同槽位「Android 面板」严格对齐。
 * 状态点数据来自 GET /state（15s 轮询 + 主题跟随），未设置项目路径时退化为灰点。
 */
function PaneSidebarButton(): ReturnType<typeof h> {
  ensureStyles()
  const [on, setOn] = useState(openState)
  const [mode, setMode] = useState(appDark() ? 'dark' : 'light')
  const [stat, setStat] = useState<{ kind: 'none' | 'clean' | 'work' | 'block'; tip: string }>({ kind: 'none', tip: '未设置项目路径' })
  const btnRef = useRef<HTMLButtonElement | null>(null)
  // 收起/展开靠 max-width 过渡：量一次真实文字宽写进 --pb-lw，让补间全程都在动（不用猜测值）。
  useEffect(() => {
    const btn = btnRef.current
    const label = btn?.querySelector('.pb-label') as HTMLElement | null
    if (btn == null || label == null) return
    const w = label.offsetWidth
    if (w > 0) btn.style.setProperty('--pb-lw', w + 'px')
  }, [])
  useEffect(() => {
    const f = (): void => setOn(openState)
    window.addEventListener('dsh-plan-superagent:toggle', f)
    return () => window.removeEventListener('dsh-plan-superagent:toggle', f)
  }, [])
  useEffect(() => {
    let stop = false
    const tick = async (): Promise<void> => {
      if (stop) return
      setMode(appDark() ? 'dark' : 'light')
      const project = loadProject()
      if (!isAbsoluteProject(project)) { setStat({ kind: 'none', tip: '未设置项目路径（点开面板填写）' }); return }
      try {
        const r = await fetch(API + '/state?project=' + encodeURIComponent(project))
        const j = await r.json() as { ok?: boolean; board?: { version?: number; nodes?: { status: string }[]; driftBlock?: unknown }; station?: string | null }
        if (stop) return
        if (j.ok !== true || j.board == null) { setStat({ kind: 'none', tip: '未找到 .plan-board/（先跑 plan_edit init_board）' }); return }
        const nodes = j.board.nodes ?? []
        const doing = nodes.filter(n => n.status === 'doing').length
        const blocked = nodes.filter(n => n.status === 'blocked').length
        const drift = j.board.driftBlock != null
        const kind: 'clean' | 'work' | 'block' = drift || blocked > 0 ? 'block' : doing > 0 ? 'work' : 'clean'
        const head = drift ? '漂移阻断中' : doing > 0 ? doing + ' 个进行中' : blocked > 0 ? blocked + ' 个阻塞' : '无进行中任务'
        setStat({ kind, tip: 'v' + (j.board.version ?? '?') + ' · ' + head + (j.station != null ? ' · 站位 ' + j.station : '') })
      } catch { if (!stop) setStat({ kind: 'none', tip: '读取板子失败' }) }
    }
    void tick()
    const t = setInterval(() => { void tick() }, 15000)
    return () => { stop = true; clearInterval(t) }
  }, [])
  const orb = h('span', { className: 'pb-orb', key: 'orb', 'aria-hidden': 'true' },
    h('svg', { viewBox: '0 0 18 18' },
      h('defs', { key: 'defs' },
        h('linearGradient', { id: 'pb-orb-orbit', x1: '0', y1: '0', x2: '1', y2: '0' },
          h('stop', { key: 'o1', offset: '0', stopColor: '#22d3ee' }),
          h('stop', { key: 'o2', offset: '1', stopColor: '#e879f9' })),
        h('radialGradient', { id: 'pb-orb-core', cx: '.42', cy: '.38', r: '.68' },
          h('stop', { key: 'c1', offset: '0', stopColor: '#ffffff' }),
          h('stop', { key: 'c2', offset: '.34', stopColor: '#ddd6fe' }),
          h('stop', { key: 'c3', offset: '1', stopColor: '#7c3aed' })),
        h('radialGradient', { id: 'pb-orb-halo', cx: '.5', cy: '.5', r: '.5' },
          h('stop', { key: 'h1', className: 'pb-halo-stop', offset: '0', stopOpacity: '.55' }),
          h('stop', { key: 'h2', offset: '1', stopColor: '#a855f7', stopOpacity: '0' }))),
      h('circle', { key: 'halo', cx: 9, cy: 9, r: 6.5, fill: 'url(#pb-orb-halo)' }),
      h('g', { key: 'ring', transform: 'rotate(-22 9 9)' },
        h('ellipse', { key: 'flow', className: 'pb-orbit', cx: 9, cy: 9, rx: 7.4, ry: 2.9, fill: 'none', stroke: 'url(#pb-orb-orbit)', strokeWidth: 1 }),
        h('circle', { key: 'sat1', className: 'pb-sat', cx: 1.6, cy: 9, r: 1.25, fill: '#22d3ee' }),
        h('circle', { key: 'sat2', className: 'pb-sat s2', cx: 16.4, cy: 9, r: 1.25, fill: '#e879f9' })),
      h('circle', { key: 'core', className: 'pb-core', cx: 9, cy: 9, r: 2.6, fill: 'url(#pb-orb-core)' })))
  const dotCls = 'pb-dot ' + (stat.kind === 'clean' ? 'pb-clean' : stat.kind === 'work' ? 'pb-work' : stat.kind === 'block' ? 'pb-block' : 'pb-none')
  return h('button', {
    className: 'pb-entry' + (on ? ' pb-on' : ''),
    'data-mode': mode,
    'data-stat': stat.kind,
    ref: btnRef,
    onClick: togglePanel,
    'aria-pressed': on,
    title: 'dsh-plan-superagent 规划面板 · ' + stat.tip,
    'aria-label': 'dsh-plan-superagent 规划面板，' + stat.tip,
  },
    h('span', { className: 'pb-aurora', key: 'aurora', 'aria-hidden': 'true' }),
    h('span', { className: 'pb-ring', key: 'ring', 'aria-hidden': 'true' }),
    orb,
    h('span', { className: 'pb-lwrap', key: 'lwrap' }, h('span', { className: 'pb-label', key: 'label' }, 'PlanBoard')),
    h('span', { className: dotCls, key: 'dot' }),
    h('span', { className: 'pb-shine', key: 'shine', 'aria-hidden': 'true' }))
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

interface LayoutItem { node: BoardNode; x: number; y: number; w: number; h: number }
interface Layout { items: LayoutItem[]; totalH: number }
interface MapProps {
  data: BoardData
  effNodes: BoardNode[]
  layout: Layout
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
}

const ROW = 30
const MOD_H = 42

function MindMap(props: MapProps): ReturnType<typeof h> {
  const { data, effNodes, layout, dirtyIds, view, setView, dragRef, depLine, setDepLine, editorId, onNodePointerDown, onNodeMove, onNodeClick, onDepDrop, onHandlePointerDown, svgRef } = props
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)
  const b = data.board
  const mods = useMemo(() => effNodes.filter(n => n.type === 'module'), [effNodes])
  const posOf = (id: string): LayoutItem | undefined => layout.items.find(i => i.node.id === id)
  const toSvg = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = svgRef.current?.getBoundingClientRect()
    const left = rect?.left ?? 0
    const top = rect?.top ?? 0
    return { x: (clientX - left - view.tx) / view.k, y: (clientY - top - view.ty) / view.k }
  };
  const edge = (a: LayoutItem, bx: number, by: number): string => {
    const x1 = a.x + a.w
    const y1 = a.y + a.h / 2
    const mx = (x1 + bx) / 2
    return 'M ' + x1 + ' ' + y1 + ' C ' + mx + ' ' + y1 + ', ' + mx + ' ' + by + ', ' + bx + ' ' + by
  };
  const depEdge = (a: LayoutItem, bp: LayoutItem): string => {
    const x1 = a.x - 6
    const y1 = a.y + a.h / 2
    const x2 = bp.x - 6
    const y2 = bp.y + bp.h / 2
    const mx = Math.min(x1, x2) - 46
    return 'M ' + x1 + ' ' + y1 + ' C ' + mx + ' ' + y1 + ', ' + mx + ' ' + y2 + ', ' + x2 + ' ' + y2
  };
  // 原生非 passive 监听器：React 合成 onWheel 走根节点 passive 注册，preventDefault 无效且报错（M2-3 验收 P2 修复）
  const mapRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = mapRef.current
    if (el == null) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      setView(v => ({ ...v, k: Math.min(2.2, Math.max(0.35, v.k * (e.deltaY > 0 ? 0.92 : 1.08))) }))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [setView])
  return h('div', {
    className: 'pb-map',
    ref: mapRef,
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
        const f = posOf(d.from)
        if (f != null) setDepLine({ x1: f.x + f.w, y1: f.y + f.h / 2, x2: p.x, y2: p.y })
        return
      }
      if (drag.current == null) return
      setView(v => ({ ...v, tx: drag.current!.tx + (e.clientX - drag.current!.x), ty: drag.current!.ty + (e.clientY - drag.current!.y) }))
    },
    onPointerUp: (e: PEv) => {
      const d = dragRef.current
      dragRef.current = null
      setDepLine(null)
      if (d != null && d.kind === 'node') { if (!d.moved) onNodeClick(d.id); return }
      if (d != null && d.kind === 'dep') { onDepDrop(d.from, { clientX: e.clientX, clientY: e.clientY }); return }
      drag.current = null
    },
  },
    h('svg', { width: '100%', height: Math.max(layout.totalH, 300), ref: svgRef, key: b.version },
      h('g', { transform: 'translate(' + view.tx + ',' + view.ty + ') scale(' + view.k + ')' },
        effNodes.filter(n => n.type === 'module' && n.parent == null).map((m, i) => {
          const rp = posOf('__root__')
          const mp = posOf(m.id)
          if (rp == null || mp == null) return null
          return h('path', { key: 'e' + i, d: edge(rp, mp.x, mp.y + mp.h / 2), stroke: 'var(--pb-line,#cbd5e1)', strokeWidth: 1.6, fill: 'none' })
        }),
        mods.map((m, mi) => {
          const mp = posOf(m.id)
          if (mp == null) return null
          return h('g', { key: 'mg' + mi },
            effNodes.filter(t => t.type === 'task' && t.parent === m.id).map((t, ti) => {
              const tp = posOf(t.id)
              if (tp == null) return null
              return h('path', { key: 'te' + mi + '_' + ti, d: edge(mp, tp.x, tp.y + tp.h / 2), stroke: 'var(--pb-line,#cbd5e1)', strokeWidth: 1.2, fill: 'none' })
            }))
        }),
        effNodes.flatMap((t, di) => (t.deps ?? []).map((d, dj) => {
          const a = posOf(t.id)
          const bp = posOf(d)
          if (a == null || bp == null) return null
          return h('path', { key: 'dep' + di + '_' + dj, d: depEdge(bp, a), stroke: '#8b5cf6', strokeWidth: 1.3, strokeDasharray: '5 4', fill: 'none', opacity: .8 })
        })),
        depLine != null ? h('line', { x1: depLine.x1, y1: depLine.y1, x2: depLine.x2, y2: depLine.y2, stroke: '#8b5cf6', strokeWidth: 2, strokeDasharray: '4 3', opacity: .9 }) : null,
        layout.items.map((it, ii) => {
          const isRoot = it.node.id === '__root__'
          const color = STATUS_COLOR[it.node.status] ?? '#94a3b8'
          const ord = data.order[it.node.id]
          const isStation = it.node.id === data.station
          const isEditor = it.node.id === editorId
          const isDirty = dirtyIds.has(it.node.id)
          if (isRoot) {
            return h('g', { key: 'n' + ii },
              h('rect', { x: it.x, y: it.y, width: it.w, height: it.h, rx: 12, fill: 'var(--pb-bg)', stroke: color, strokeWidth: 2 }),
              h('rect', { x: it.x, y: it.y, width: 4, height: it.h, rx: 2, fill: color }),
              h('text', { x: it.x + 12, y: it.y + it.h / 2 + 4, fontSize: 13, fontWeight: 600 }, it.node.title.slice(0, 26)));
          }
          return h('g', {
            key: 'n' + it.node.id,
            className: 'pb-node',
            'data-id': it.node.id,
            onPointerDown: (e: PEv) => { e.stopPropagation(); onNodePointerDown(e, it.node.id, { x: it.x, y: it.y }) },
          },
            isStation ? h('rect', { className: 'pb-station', x: it.x - 4, y: it.y - 4, width: it.w + 8, height: it.h + 8, rx: 12, fill: 'none', stroke: '#f59e0b', strokeWidth: 2 }) : null,
            isEditor ? h('rect', { x: it.x - 6, y: it.y - 6, width: it.w + 12, height: it.h + 12, rx: 12, fill: 'none', stroke: '#8b5cf6', strokeWidth: 2, strokeDasharray: '6 3' }) : null,
            h('rect', { x: it.x, y: it.y, width: it.w, height: it.h, rx: 9, fill: 'var(--pb-bg)', stroke: isEditor ? '#8b5cf6' : color, strokeWidth: 1.5 }),
            h('rect', { x: it.x, y: it.y, width: 4, height: it.h, rx: 2, fill: color }),
            h('text', { x: it.x + 12, y: it.y + it.h / 2 + 4, fontSize: 12, fontWeight: 600 },
              (ord != null ? '#' + ord + ' ' : '') + (isDirty ? '● ' : '') + it.node.title.slice(0, 24)),
            it.node.type === 'task' ? h('text', { x: it.x + it.w - 8, y: it.y + it.h / 2 + 4, fontSize: 10, textAnchor: 'end', fill: color }, it.node.status) : null,
            it.node.type === 'task' ? h('circle', {
              className: 'pb-handle', cx: it.x + it.w + 6, cy: it.y + it.h / 2, r: 5, fill: '#8b5cf6', opacity: .85,
              title: '拖到目标任务 = 目标依赖此任务；再拖一次 = 移除依赖',
              onPointerDown: (e: PEv) => { e.stopPropagation(); onHandlePointerDown(e, it.node.id) },
            }) : null);
        }))));
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
  return h('span', { className: 'pb-modewrap' },
    h('button', {
      className: 'pb-modebtn' + (mode === 'plan' ? ' pb-on' : ''),
      disabled: busy || sid == null,
      'aria-pressed': mode === 'plan',
      title: sid == null
        ? '拿不到会话 id，模式开关不可用'
        : mode === 'plan' ? '计划板模式已开：开发类需求先走计划板（点一下关掉）' : '当前直改：开发类需求直接动手（点一下让需求先走计划板）',
      onClick: () => { void toggle() },
    }, modeLabel(mode)),
    err !== '' ? h('span', { className: 'pb-modeerr', role: 'status', title: err }, clip(err, 36)) : null)
}
function PaneWindow(): ReturnType<typeof h> | null {
  const [open, setOpen] = useState(openState)
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
  // 依赖候选项 = 板子上的节点（提案新增的节点在渲染时再并进来）
  const depOptions = useMemo<DepOption[]>(() => (data?.board.nodes ?? []).map(n => ({ id: n.id, title: n.title, type: n.type })), [data])
  const [view, setView] = useState({ k: 1, tx: 0, ty: 0 })
  const dragRef = useRef<{ kind: 'node'; id: string; sx: number; sy: number; bx: number; by: number; moved: boolean } | { kind: 'dep'; from: string } | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const editorRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const f = (): void => setOpen(openState)
    window.addEventListener('dsh-plan-superagent:toggle', f)
    return () => window.removeEventListener('dsh-plan-superagent:toggle', f)
  }, [])
  useEffect(() => {
    const t = setInterval(() => { const d = appDark(); setMode(prev => (prev === (d ? 'dark' : 'light') ? prev : (d ? 'dark' : 'light'))) }, 2000)
    return () => clearInterval(t)
  }, [])
  useEffect(() => {
    if (!open || !isAbsoluteProject(project)) return
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
      if (!stop) setTimeout(() => { void run() }, 3000)
    };
    void run()
    return () => { stop = true; ctrl.abort() }
  }, [open, project])
  useEffect(() => {
    if (!open || !isAbsoluteProject(project)) return
    localStorage.setItem(PROJECT_KEY, project)
    let stop = false
    const tick = async (): Promise<void> => {
      try {
        const r = await fetch(API + '/state?project=' + encodeURIComponent(project))
        const j = await r.json() as Record<string, unknown>
        if (stop) return
        if (j.ok === true) { setData(j as unknown as BoardData); setErr('') }
        else setErr(String((j.error as { message?: string })?.message ?? '加载失败'))
      } catch (e) { if (!stop) setErr(String(e)) }
    };
    void tick()
    const t = setInterval(tick, POLL_MS)
    return () => { stop = true; clearInterval(t) }
  }, [open, project, nonce])
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
  const layout = useMemo<Layout>(() => {
    let y = 20
    const items: LayoutItem[] = []
    const floating: LayoutItem[] = []
    const mods = effNodes.filter(n => n.type === 'module')
    for (const m of mods) {
      const tasks = effNodes.filter(t => t.type === 'task' && t.parent === m.id)
      const h = MOD_H + tasks.length * ROW + 8
      const mx = m.pos != null ? m.pos.x : 180
      const my = m.pos != null ? m.pos.y : y
      const mi: LayoutItem = { node: m, x: mx, y: my, w: 170, h: MOD_H - 6 }
      if (m.pos != null) floating.push(mi); else items.push(mi)
      let ty = my + MOD_H
      for (const t of tasks) {
        const ti: LayoutItem = { node: t, x: t.pos != null ? t.pos.x : 410, y: t.pos != null ? t.pos.y : ty, w: 260, h: ROW - 6 }
        if (t.pos != null) floating.push(ti); else items.push(ti)
        ty += ROW
      }
      y = (m.pos != null ? my + h : y + h) + 18
    }
    const totalH = Math.max(y + 20, 260)
    // 有 pos 的节点（人手工摆过）脱流：最后绘制 = 盖在最上层，与点击/连线的 DOM 命中序一致
    items.push(...floating)
    items.push({ node: { id: '__root__', type: 'module', parent: null, title: b?.plan.name ?? 'Plan', status: 'planned', deps: [] }, x: 16, y: totalH / 2 - 20, w: 130, h: 40 })
    return { items, totalH }
  }, [effNodes, b]);
  const dirtyIds = useMemo(() => new Set([...Object.keys(drafts), ...added.map(a => a.id), ...removed]), [drafts, added, removed]);
  // 打开编辑卡时优先保住导图可见（不跳屏）；只在卡片标题行整个落在视野外时才滚动一下
  useEffect(() => {
    if (editorId == null) return
    const el = editorRef.current
    if (el == null) return
    if (el.getBoundingClientRect().top > window.innerHeight - 40) el.scrollIntoView({ block: 'nearest' })
  }, [editorId])
  if (!open) return null
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
  const onNodeClick = (id: string): void => { setEditorId(prev => (prev === id ? null : id)); setSaveMsg('') };
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
  const discard = (): void => { setDrafts({}); setAdded([]); setRemoved([]); setEditorId(null); setSaveMsg('') };
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
  return h('div', { className: 'pb-panel', 'data-mode': mode },
    h('div', { className: 'pb-head' },
      h('span', { className: 'pb-title' }, '🗺 PlanBoard'),
      h('input', { className: 'pb-input', value: project, placeholder: '项目根目录绝对路径，如 /path/to/your/project 或 C:\\path\\to\\project', onChange: (e: { target: { value: string } }) => setProject(e.target.value), onBlur: () => { void rememberProject(project) } }),
      h('button', { className: 'pb-btn', onClick: togglePanel }, '收起'),
    ),
    // ===== 顶部常驻区：项目切换 + 一句话生成（不用切到聊天框） =====
    h('div', { className: 'pb-projrow' },
      h('span', {}, '当前项目：'),
      h('span', { className: 'pb-projpath', title: project, onClick: () => setProjListOpen(v => !v) }, project.trim() === '' ? '（未设置）' : project),
      h('span', { className: 'pb-hint', style: { cursor: 'pointer' }, onClick: () => setProjListOpen(v => !v) }, '（点此切换）'),
      recent.slice(0, 12).map(r => h('button', {
        key: r.project,
        className: 'pb-tag' + (r.project === project ? ' pb-on' : ''),
        title: r.project,
        onClick: () => { setProject(r.project); setProjListOpen(false); setSaveMsg(''); void rememberProject(r.project) },
      }, projListOpen ? clip(r.name, 18) + ' · ' + r.project : clip(r.name, 18)))),
    err !== '' ? h('div', { className: 'pb-banner pb-drift' }, '⚠ ' + err) : null,
    b == null ? h('div', { className: 'pb-body' },
      h('div', { className: 'pb-card' },
        h('div', { style: { fontWeight: 700, marginBottom: '4px' } }, project.trim() === '' ? '① 选一个最近打开的项目（或把项目根目录粘到上面的输入框）' : '⚠ 这个项目下还没有 .plan-board/'),
        h('div', { className: 'pb-hint' }, project.trim() === ''
          ? '面板只读+直改规划；任务状态仍走 task_update（L3 证据门）。① 点上面一行里的项目标签切换；② 或直接在顶部输入框写一句话生成导图（服务端自动起板，结构变更先进待批队列，人可改可驳）。'
          : '这个项目下还没有 .plan-board/。不碍事：在顶部输入框写一句话就能生成导图（服务端自动起板 + 进待批队列，人可改内容再确认）；也可以让 Agent 跑 plan_edit init_board 起板。'),
        recent.length > 0 ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '10px' } },
          recent.map(r => h('button', {
            key: r.project, className: 'pb-btn', title: r.project,
            onClick: () => setProject(r.project),
          }, r.name + ' · ' + r.project))) : null,
      )) :
      h('div', { className: 'pb-body' },
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
            onClick: () => { void post('/unblock', { project }).then(() => setNonce(n => n + 1)) },
          }, '解除阻断')) : null,
        (data?.guard?.suspended ? h('div', { className: 'pb-banner pb-hold' },
          '⏸ L7 越界拦截已挂起（仅内存态，重启后自动恢复拦截）',
          h('button', {
            className: 'pb-btn pb-ok', style: { marginLeft: 'auto' },
            onClick: () => { void post('/guard', { project, suspended: false }).then(() => setNonce(n => n + 1)) },
          }, '恢复拦截')) : null),
        ((): ReturnType<typeof h> | null => {
          const blocks = (data?.events ?? []).filter(ev => ev.kind === 'guard_block')
          if (blocks.length === 0 || data?.guard?.suspended) return null
          const last = blocks[blocks.length - 1]
          return h('div', { className: 'pb-banner pb-guard' },
            '🛡 L7 越界拦截 ' + blocks.length + ' 次: ' + (last.payload?.tool ?? '?') + ' → ' + (last.payload?.path ?? '?') + '（任务 ' + (last.payload?.taskId ?? '?') + '）',
            h('button', {
              className: 'pb-btn', style: { marginLeft: 'auto' },
              onClick: () => { void post('/guard', { project, suspended: true }).then(() => setNonce(n => n + 1)) },
            }, '暂停拦截'))
        })(),
        b.pendingApprovals.length > 0 ? h('div', { className: 'pb-banner pb-appr' },
          '⏳ ' + b.pendingApprovals.length + ' 个 plan_edit 待批',
          h('span', { style: { fontWeight: 400, opacity: .85 } }, b.pendingApprovals[0].reason.slice(0, 60))) : null,
        b.pendingApprovals.map(ap => {
          // 每条待批提案单独一份编辑态：原提案 vs 人改过的版本
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
        }),
        h('div', { className: 'pb-sec' }, '任务思维导图 v' + b.version + ' · digest ' + (b.digest ?? '').slice(0, 10) + ' · 拖拽移动 / 点节点编辑 / 紫点拖出连依赖'),
        h(MindMap, { data: data as BoardData, effNodes, layout, dirtyIds, view, setView, dragRef, depLine, setDepLine, editorId, onNodePointerDown, onNodeMove, onNodeClick, onDepDrop, onHandlePointerDown, svgRef } as never),
        editorCard,
        h('div', { className: 'pb-sec' }, '事件时间线'),
        h('div', { className: 'pb-card' },
          (data?.events ?? []).slice(-24).reverse().map(ev => h('div', { className: 'pb-ev', key: ev.seq },
            h('span', {}, new Date(ev.ts).toLocaleTimeString()),
            h('span', { style: { fontWeight: 700 } }, ev.kind),
            h('span', { style: { opacity: .7 } }, ev.actor))))),
  )
}

type SlotsCtx = {
  slots: {
    inject(slot: string, register: () => unknown): void
    register(meta: Record<string, unknown>, component?: unknown): unknown
  }
  effect(fn: () => unknown, label?: string): void
}

export const inject = ['slots']

export function apply(ctx: SlotsCtx): void {
  ctx.effect(() => {
    ctx.slots.inject('shell.overlay', () =>
      ctx.slots.register({ name: 'shell.overlay', id: NS + ':pane', order: 85 }, PaneWindow as unknown as (props: never) => unknown))
    // 计划板模式开关：挂原生输入栏左侧（与权限/计划芯片同一排）。
    // list 型插槽按 id 去重，id 必须全宿主唯一 —— 用 NS 前缀，且不能与旧插件同名。
    // inject 收到的第一个实参就是会话 id（宿主 slots 的 runInject 把 scope 绑定 key 传进来）。
    ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
      name: 'conversation.input.left',
      id: NS + ':mode',
      order: -1,
      inject: (sessionId: string) => ({ sessionId }),
    }, PlanBoardModeChip as unknown as (props: never) => unknown))
    ctx.slots.inject('conversation.session.header.utilities', () =>
      // 槽位 order 梯队（升序，勿与他插件撞值）：billing -2 → android-pane -1 → 本插件 -0.5 → SLog 0 → delete 1。
      // v0.2.0 曾克隆 android-pane 骨架连 -1 一起复制，同槽同值导致「谁最后 reload 谁靠右」乒乓换位（09-16 四次实录）。
      ctx.slots.register({ name: 'conversation.session.header.utilities', id: NS + ':entry', order: -0.5 }, PaneSidebarButton as unknown as (props: never) => unknown))
  }, NS + ':ui')
}