/**
 * HTTP 传输面（host half）：/_dsh/dsh-plan-board/ 前缀路由。
 * 门禁（沿用 dsh-session-manager / dsh-android-pane 实测纪律）：
 * 仅 loopback 对端；变更类 POST 追加同源校验；JSON 体上限 64KB；错误一律 {ok:false,error:{code,message}}。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isIP } from 'node:net'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Board, BoardError, EditOp, newBoard, topoOrder } from './schema.js'
import { PlanStore, StoreOpts } from './store.js'
import { isAbsolutePath } from './pathutil.js'

export const ROUTE_PREFIX = '/_dsh/dsh-plan-board'

/** note 里的子导图指针前缀（消费方据此定位子导图文件；与规划器侧一致）。 */
const DESIGN_POINTER_PREFIX = 'design-graph: '

/** 子导图的任务 id：只允许字母数字与 - _，不许带路径分隔符（不然就是路径穿越）。 */
function isSafeTaskId(taskId: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(taskId)
}

/** 解包子导图：规划器写的是包起来的形状，面板要裸的五字段；裸的就原样返回。 */
function unwrapDesign(parsed: unknown): unknown {
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed
  const inner = (parsed as { design?: unknown }).design
  if (inner != null && typeof inner === 'object' && !Array.isArray(inner)) return inner
  return parsed
}

/** 子导图文件相对项目根的路径（板上用正斜杠写指针，跨平台一致）。 */
function designRelative(designDir: string, taskId: string): string {
  return designDir.replace(/\\/g, '/') + '/' + taskId + '.json'
}
const MAX_JSON_BODY_BYTES = 64 * 1024

export interface GuardLike {
  isSuspended(): boolean
  setSuspended(v: boolean): boolean
  state(): { suspended: boolean; enforceScope: boolean }
}

export class BoardRegistry {
  readonly stateDir: string
  readonly opts: StoreOpts
  readonly subscribers = new Set<(msg: unknown) => void>()
  /** L7 拦截器（index.ts 装配后挂入；路由层负责挂起开关与状态展示）。 */
  guard: GuardLike | null = null
  /** PlanStore 广播入口：事件 → 所有 /stream 订阅者。 */
  readonly onEvent = (project: string, ev: unknown): void => {
    this.broadcast({ kind: 'event', project, event: ev })
  }
  broadcast(msg: unknown): void {
    for (const s of this.subscribers) { try { s(msg) } catch { /* 单订阅者失败不拖垮其他 */ } }
  }
  constructor(stateDir: string, opts: StoreOpts) {
    this.stateDir = stateDir
    this.opts = opts
    mkdirSync(stateDir, { recursive: true })
  }
  projects(): Record<string, { name: string; at: string }> {
    const f = join(this.stateDir, 'projects.json')
    if (!existsSync(f)) return {}
    try { return JSON.parse(readFileSync(f, 'utf8')) as Record<string, { name: string; at: string }> } catch { return {} }
  }
  remember(project: string, name: string): void {
    const all = this.projects()
    const cur = all[project]
    if (cur != null && cur.name === name) return // 幂等：/state 轮询不重复写盘
    all[project] = { name, at: new Date().toISOString() }
    writeFileSync(join(this.stateDir, 'projects.json'), JSON.stringify(all, null, 2))
  }
  /** L7 观测面：非本插件工具调用全量留痕（tool-calls.jsonl，仅名称+agent，不落参数）。 */
  observeToolCall(toolName: string, agent: string): void {
    try {
      const rec = { ts: new Date().toISOString(), tool: toolName, agent }
      appendFileSync(join(this.stateDir, 'tool-calls.jsonl'), JSON.stringify(rec) + '\n')
    } catch { /* fail-soft */ }
  }
}

function isLoopbackPeer(remote: string | undefined): boolean {
  if (remote == null || remote === '') return false
  if (remote === '::1') return true
  const m = /^::ffff:(\d+)\.(\d+)\.(\d+)\.(\d+)$/i.exec(remote)
  if (m != null) return Number(m[1]) === 127
  if (isIP(remote) === 4) return remote.startsWith('127.')
  return false
}

function sameOriginHost(req: Pick<IncomingMessage, 'headers'>): boolean {
  const origin = req.headers.origin
  if (origin == null) return true
  const host = req.headers.host
  if (typeof origin !== 'string' || typeof host !== 'string' || host.trim() === '') return false
  try { return new URL(origin).host.trim().toLowerCase() === host.trim().toLowerCase() } catch { return false }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function sendErr(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { ok: false, error: { code, message } })
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let aborted = false
    req.on('data', (d: Buffer) => {
      if (aborted) return
      size += d.length
      if (size > MAX_JSON_BODY_BYTES) { aborted = true; req.pause(); resolve(null); return }
      chunks.push(d)
    })
    req.on('end', () => {
      if (aborted) return
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        const parsed = text.trim() === '' ? {} : (JSON.parse(text) as unknown)
        if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) resolve(null)
        else resolve(parsed as Record<string, unknown>)
      } catch { resolve(null) }
    })
    req.on('error', () => resolve(null))
  })
}

function stationOf(b: Board): string | null {
  const doing = b.nodes.filter(n => n.type === 'task' && n.status === 'doing')
  return doing.length > 0 ? doing[doing.length - 1].id : null
}

/** What an op touches, so an edited proposal can be checked against the original one. */
function opTarget(op: unknown): string {
  if (op == null || typeof op !== 'object') return ''
  const o = op as { op?: unknown; id?: unknown; node?: { id?: unknown } }
  if (o.op === 'add_node') return 'add:' + String(o.node?.id ?? '')
  if (o.op === 'init_board') return 'init'
  return String(o.op ?? '') + ':' + String(o.id ?? '')
}

/**
 * Check the ops a person edited before they are applied.
 *
 * The panel may change a proposal's content or drop a row, but not invent work the agent never
 * proposed: every submitted op has to match a proposed one, and unknown op kinds are refused.
 * The board's own lint stays the second line of defence.
 */
function validateEditedOps(proposed: EditOp[], edited: EditOp[]): string | undefined {
  const kinds = new Set(proposed.map(op => String((op as { op?: unknown }).op ?? '')))
  for (const op of edited) {
    const kind = String((op as { op?: unknown }).op ?? '')
    if (!kinds.has(kind)) return '提案里没有这种操作: ' + kind
  }
  const targets = new Set(proposed.map(opTarget))
  for (const op of edited) {
    if (!targets.has(opTarget(op))) return '提案里没有这一项: ' + opTarget(op)
  }
  return undefined
}

/** One sentence in, a pending proposal out. The planner lives in the host half; the board only routes it. */
export interface PlanHook {
  (input: { project: string; sentence: string; timeoutMs?: number; maxAttempts?: number; provider?: string; model?: string }): Promise<Record<string, unknown>>
}

/** The plan-mode store and the announcer that tells a Session its mode changed. */
export interface ModeDeps {
  store: { get(sessionId: string): { mode: 'plan' | 'direct'; at: string } | undefined; set(sessionId: string, mode: 'plan' | 'direct'): { mode: 'plan' | 'direct'; at: string } }
  announce: (sessionId: string, mode: 'plan' | 'direct', project: string) => Promise<boolean>
  /** The configured project, used when the panel has not opened one yet. */
  project?: string
}


/**
 * 子导图来源统计：几张是模型写的（model）、几张是推导的（derived）。
 *
 * 为什么在路由侧算：规划器在宿主那半，板子不该反向依赖它。
 * 契约是子导图文件里的 source 字段，而 note 里带着它的相对路径——这两样就够了。
 */
function designQualityOf(project: string, ops: EditOp[]): { model: number; derived: number; total: number } | null {
  let model = 0
  let derived = 0
  let total = 0
  for (const op of ops) {
    if (op.op !== 'update_node') continue
    const note = op.fields.note
    if (typeof note !== 'string') continue
    const m = /^design-graph:\s*(.+)$/.exec(note)
    if (m == null) continue
    const file = join(project, ...m[1].split('/').filter((p) => p !== '' && p !== '.'))
    let source = 'model'
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { source?: string }
      source = typeof parsed.source === 'string' ? parsed.source : 'model'
    } catch { source = 'model' }
    total += 1
    if (source === 'derived') derived += 1
    else model += 1
  }
  return total > 0 ? { model, derived, total } : null
}

/** 把 designQuality 挂到 /plan 的返回体上（板子还没有就原样返回）。 */
function withDesignQuality(
  project: string,
  result: Record<string, unknown>,
  registry: BoardRegistry,
): Record<string, unknown> {
  try {
    const store = PlanStore.open(project, registry.opts, registry.onEvent)
    const apId = typeof result.approvalId === 'string' ? result.approvalId : ''
    const ap = store.board.pendingApprovals.find(x => x.id === apId)
      ?? store.board.pendingApprovals[store.board.pendingApprovals.length - 1]
    const q = ap != null ? designQualityOf(project, ap.ops) : null
    if (q != null) return { ...result, designQuality: q }
  } catch { /* 板还没有就算了，不影响主结果 */ }
  return result
}

export function mountRoutes(

  webServer: { register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void },
  registry: BoardRegistry,
  plan?: PlanHook,
  mode?: ModeDeps,
  designDir = '.plan-board/designs',
): () => void {
  const unregister = webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      try {
        if (!isLoopbackPeer(req.socket.remoteAddress)) { sendErr(res, 403, 'FORBIDDEN', '仅限本机访问'); return }
        const u = new URL(req.url ?? '/', 'http://localhost')
        const sub = u.pathname.slice(ROUTE_PREFIX.length) || '/'
        if (req.method === 'GET') {
          if (sub === '/stream') {
            const project = u.searchParams.get('project') ?? ''
            if (!isAbsolutePath(project)) { sendErr(res, 400, 'BAD_PROJECT', 'project 必须是绝对路径'); return }
            res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' })
            const send = (obj: unknown): void => { try { res.write(JSON.stringify(obj) + '\n') } catch { /* 连接已断 */ } }
            send({ kind: 'hello', project, at: new Date().toISOString() })
            const subFn = (msg: unknown): void => { send(msg) }
            registry.subscribers.add(subFn)
            const hb = setInterval(() => send({ kind: 'ping', at: new Date().toISOString() }), 15000)
            res.on('close', () => { clearInterval(hb); registry.subscribers.delete(subFn) })
            return
          }
          if (sub === '/state') {
            const project = u.searchParams.get('project') ?? ''
            if (!isAbsolutePath(project)) { sendErr(res, 400, 'BAD_PROJECT', 'project 必须是绝对路径'); return }
            const store = PlanStore.open(project, registry.opts, registry.onEvent)
            registry.remember(project, store.board.plan.name)
            const order: Record<string, number> = {}
            for (const [k, v] of topoOrder(store.board)) order[k] = v
            sendJson(res, 200, {
              ok: true, project, board: store.board, order,
              station: stationOf(store.board), events: store.eventsTail(60),
              guard: registry.guard?.state() ?? { suspended: false, enforceScope: false },
            })
            return
          }
          if (sub === '/projects') { sendJson(res, 200, { ok: true, projects: registry.projects() }); return }
          if (sub === '/design') {
            // 子导图在磁盘上（designs/<taskId>.json），面板要能读它、也能写回去。
            // project 在这里要自己取：/state、/stream 里的 project 是各自块内的局部变量，这里够不着。
            const project = u.searchParams.get('project') ?? ''
            if (!isAbsolutePath(project)) { sendErr(res, 400, 'BAD_PROJECT', 'project 必须是绝对路径'); return }
            const taskId = u.searchParams.get('taskId') ?? ''
            if (!isSafeTaskId(taskId)) { sendErr(res, 400, 'BAD_TASK_ID', 'taskId 只能包含字母数字与 - _'); return }
            const file = join(project, designDir, taskId + '.json')
            let design: unknown = null
            if (existsSync(file)) {
              let parsed: unknown
              try { parsed = JSON.parse(readFileSync(file, 'utf8')) }
              catch { sendErr(res, 400, 'BAD_DESIGN', '子导图文件不是合法 JSON'); return }
              // 规划器写的是包起来的形状（{taskId, …, design:{…}}），面板要的是裸的五字段；读时解包。
              design = unwrapDesign(parsed)
            }
            sendJson(res, 200, { ok: true, taskId, design, relative: designRelative(designDir, taskId), path: file })
            return
          }
          if (sub === '/mode') {
            const sessionId = u.searchParams.get('sessionId') ?? ''
            if (sessionId === '') { sendErr(res, 400, 'NO_SESSION', 'sessionId 不能为空'); return }
            if (mode == null) { sendErr(res, 501, 'NO_MODE', '计划板模式未装配'); return }
            const record = mode.store.get(sessionId)
            sendJson(res, 200, { ok: true, sessionId, mode: record?.mode ?? 'direct', at: record?.at })
            return
          }
          sendErr(res, 404, 'NOT_FOUND', '未知路径 ' + sub)
          return
        }
        if (req.method === 'POST') {
          if (!sameOriginHost(req)) { sendErr(res, 403, 'SAME_ORIGIN', '跨站请求被拒绝'); return }
          const body = await readJsonBody(req)
          if (body == null) { sendErr(res, 400, 'BAD_JSON', 'JSON 体缺失或非法（上限 64KB）'); return }
          // The mode belongs to a Session, not to a project: answer it before the project check.
          if (sub === '/mode') {
            const sessionId = String(body.sessionId ?? '')
            const wanted = String(body.mode ?? '')
            if (sessionId === '') { sendErr(res, 400, 'NO_SESSION', 'sessionId 不能为空'); return }
            if (wanted !== 'plan' && wanted !== 'direct') { sendErr(res, 400, 'BAD_MODE', 'mode 必须是 plan|direct'); return }
            if (mode == null) { sendErr(res, 501, 'NO_MODE', '计划板模式未装配'); return }
            const record = mode.store.set(sessionId, wanted)
            // Tell the Session: the agent reads this as its working instruction for the next turn.
            const latest = Object.entries(registry.projects()).sort((a, b) => (b[1].at ?? '').localeCompare(a[1].at ?? ''))[0]
            const announced = await mode.announce(sessionId, wanted, latest?.[0] ?? mode.project ?? '')
            sendJson(res, 200, { ok: true, sessionId, mode: record.mode, at: record.at, announced })
            return
          }
          if (sub === '/design') {
            // 子导图写盘。放在 project/board 检查之前：没有板的项目也要能存子导图
            // （指针补不上就跳过，文件照样写成功），否则面板存图会先撞上 404。
            const designProject = String(body.project ?? '')
            if (!isAbsolutePath(designProject)) { sendErr(res, 400, 'BAD_PROJECT', 'project 必须是绝对路径'); return }
            const taskId = String(body.taskId ?? '')
            if (!isSafeTaskId(taskId)) { sendErr(res, 400, 'BAD_TASK_ID', 'taskId 只能包含字母数字与 - _'); return }
            const design = body.design
            if (design == null || typeof design !== 'object' || Array.isArray(design)) { sendErr(res, 400, 'BAD_DESIGN', 'design 必须是对象'); return }
            const dir = join(designProject, designDir)
            mkdirSync(dir, { recursive: true })
            const file = join(dir, taskId + '.json')
            // 写盘用与规划器同构的形状（包一层），读时再解包 —— 盘上只有一种格式。
            writeFileSync(file, JSON.stringify({ taskId, generatedAt: new Date().toISOString(), design }, null, 2))
            // 给任务补上子导图指针，面板才知道这个任务有导图（● 指示器）。
            try {
              const store = PlanStore.open(designProject, registry.opts, registry.onEvent)
              const node = store.board.nodes.find(n => n.id === taskId)
              const pointer = DESIGN_POINTER_PREFIX + designRelative(designDir, taskId)
              if (node != null) {
                // 指针要幂等：note 里已有的 design-graph 行替换掉（反复保存不会攒成三份），
                // 其余备注原样保留 —— update_node 的 note 是整体覆盖，不带上的话会被抹掉。
                const old = String(node.note ?? '')
                const kept = old.split('\n').filter(l => l.trim() !== '' && !l.trim().startsWith(DESIGN_POINTER_PREFIX))
                const note = kept.length === 0 ? pointer : kept.join('\n') + '\n' + pointer
                if (note !== old) {
                  const now = new Date().toISOString()
                  store.mutate('human:panel', 'plan_edit_info', { reason: '新建子导图指针' }, (b) => {
                    store.applyEditOps([{ op: 'update_node', id: taskId, fields: { note } }], now)
                  })
                }
              }
            } catch { /* 指针写不进去也不影响子导图文件本身 */ }
            sendJson(res, 200, { ok: true, taskId, design, relative: designRelative(designDir, taskId), path: file })
            return
          }
          if (sub === '/propose') {
            // 提案分支要能在「还没有板」的新项目上工作，所以自己取 project、自己开板，
            // 不走下面那段通用 PlanStore.open（没有板时它会先抛 PLAN_NOT_FOUND，提案分支根本走不到）。
            const proposeProject = String(body.project ?? '')
            if (!isAbsolutePath(proposeProject)) { sendErr(res, 400, 'BAD_PROJECT', 'project 必须是绝对路径'); return }
            // A plan that did not come from the model: the same human-approval gate as plan_edit,
            // but without an LLM in the loop.
            const ops = body.ops
            if (!Array.isArray(ops)) { sendErr(res, 400, 'BAD_OPS', 'ops 必须是数组'); return }
            const reason = String(body.reason ?? '').trim()
            if (reason === '') { sendErr(res, 400, 'REASON_REQUIRED', '必须带 reason（审计留痕）'); return }
            const list = ops as EditOp[]
            const initOp = list.find(op => op.op === 'init_board') as { name?: unknown; goal?: unknown } | undefined
            // 新项目还没有板：先建一个空板（不依赖 PlanStore.ensure 的兜底分支，那个分支在打包后
            // 可能因为错误类型不是同一个类而失效）。
            const boardFile = join(proposeProject, '.plan-board', 'plan.board.json')
            if (!existsSync(boardFile)) {
              mkdirSync(join(proposeProject, '.plan-board'), { recursive: true })
              writeFileSync(boardFile, JSON.stringify(newBoard(
                String(initOp?.name ?? '未命名计划'),
                String(initOp?.goal ?? ''),
              ), null, 2))
            }
            const proposeStore = PlanStore.open(proposeProject, registry.opts, registry.onEvent)
            const structural = list.filter(op => op.op === 'init_board' || op.op === 'add_node' || op.op === 'remove_node' || op.op === 'set_deps' ||
              (op.op === 'update_node' && (op.fields.priority != null || op.fields.parent !== undefined)))
            const info = list.filter(op => op.op === 'update_node' && !structural.includes(op))
            const actor = String(body.by ?? 'human:panel')
            const now = new Date().toISOString()
            let appliedInfo = 0
            let approvalId: string | null = null
            if (info.length > 0) {
              proposeStore.mutate(actor, 'plan_edit_info', { reason, ops: info }, (b) => { proposeStore.applyEditOps(info, now) })
              appliedInfo = info.length
            }
            if (structural.length > 0) {
              proposeStore.mutate(actor, 'plan_edit_proposed', { reason, ops: structural }, (b) => {
                b.apSeq += 1
                const id = 'ap-' + b.apSeq
                b.pendingApprovals.push({ id, reason, ops: structural, by: actor, proposedAt: now })
                approvalId = id
              })
            }
            sendJson(res, 200, { ok: true, appliedInfo, approvalId, pendingApproval: approvalId != null, opCount: list.length })
            return
          }
          const project = String(body.project ?? '')
          if (!isAbsolutePath(project)) { sendErr(res, 400, 'BAD_PROJECT', 'project 必须是绝对路径'); return }
          // 这三个分支不依赖板：守卫的挂起/恢复、一句话生成、项目登记在「还没有板」时也要能用，
          // 所以它们排在打开板之前（板不存在时 /remember 依然要能登记项目，桥才跟得上面板选的项目）。
          if (sub === '/guard') {
            if (registry.guard == null) { sendErr(res, 501, 'NO_GUARD', '拦截器未装配'); return }
            const suspended = body.suspended
            if (typeof suspended !== 'boolean') { sendErr(res, 400, 'BAD_SUSPENDED', 'suspended 必须是布尔'); return }
            registry.guard.setSuspended(suspended)
            // 人类挂起/恢复动作落板留痕（板不存在时跳过事件，不失败）
            try {
              const store2 = PlanStore.open(project, registry.opts, registry.onEvent)
              store2.addEvent(suspended ? 'guard_suspend' : 'guard_resume', 'human:panel', { by: 'panel' })
            } catch { /* 无板项目只切全局态 */ }
            sendJson(res, 200, { ok: true, suspended: registry.guard.isSuspended() })
            return
          }
          if (sub === '/plan') {
            if (plan == null) { sendErr(res, 501, 'NO_PLANNER', '规划器未装配'); return }
            const sentence = String(body.sentence ?? '').trim()
            if (sentence === '') { sendErr(res, 400, 'EMPTY_SENTENCE', '请先写一句需求'); return }
            try {
              const result = await plan({
                project,
                sentence,

                timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : 420_000,

                maxAttempts: typeof body.maxAttempts === 'number' ? body.maxAttempts : 3,
                provider: typeof body.provider === 'string' ? body.provider : undefined,
                model: typeof body.model === 'string' ? body.model : undefined,
              })
              // 如实汇报子导图来源：几张是模型写的、几张是推导的。
              // 静默降级过一次（8 张全是推导的，用户却以为拿到了真导图），所以必须写出来。
              sendJson(res, 200, withDesignQuality(project, result, registry))
            } catch (e) {
              // The planner reports its own problem (no model, invalid output); the panel shows it.
              sendJson(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) })
            }
            return
          }
          if (sub === '/remember') {
            // Register the project the panel is looking at, so the bridge can follow it even
            // before the project has a board (the registry is otherwise written only on /state).
            const name = String(body.name ?? '')
            registry.remember(project, name !== '' ? name : project)
            sendJson(res, 200, { ok: true, project, projects: registry.projects() })
            return
          }
          const store = PlanStore.open(project, registry.opts, registry.onEvent)
          if (sub === '/approve') {
            const approvalId = String(body.approvalId ?? '')
            const decision = String(body.decision ?? '')
            const ap = store.board.pendingApprovals.find(x => x.id === approvalId)
            if (ap == null) { sendErr(res, 404, 'NO_APPROVAL', '待批项不存在: ' + approvalId); return }
            if (decision === 'approve') {
              // The person may have edited the proposal in the panel; their ops win over the proposed ones.
              let ops = ap.ops
              if (Array.isArray(body.ops)) {
                const edited = body.ops as EditOp[]
                const problem = validateEditedOps(ap.ops, edited)
                if (problem != null) { sendErr(res, 400, 'BAD_EDITED_OPS', problem); return }
                ops = edited
              }
              const now = new Date().toISOString()
              store.mutate('human:panel', 'plan_edit_approved', { approvalId, ops }, (b) => {
                store.applyEditOps(ops, now)
                b.pendingApprovals = b.pendingApprovals.filter(x => x.id !== approvalId)
              })
              sendJson(res, 200, { ok: true, decision, approvalId })
              return
            }
            if (decision === 'reject') {
              store.mutate('human:panel', 'plan_edit_rejected', { approvalId, reason: String(body.reason ?? '') }, (b) => {
                b.pendingApprovals = b.pendingApprovals.filter(x => x.id !== approvalId)
              })
              sendJson(res, 200, { ok: true, decision, approvalId })
              return
            }
            sendErr(res, 400, 'BAD_DECISION', 'decision 必须是 approve|reject')
            return
          }
          if (sub === '/unblock') {
            if (store.board.driftBlock == null) { sendJson(res, 200, { ok: true, unblocked: false }); return }
            store.mutate('human:panel', 'drift_unblocked', { cleared: store.board.driftBlock }, (b) => { b.driftBlock = null })
            sendJson(res, 200, { ok: true, unblocked: true })
            return
          }
          if (sub === '/edit') {
            const ops = body.ops
            if (!Array.isArray(ops)) { sendErr(res, 400, 'BAD_OPS', 'ops 必须是数组'); return }
            const now = new Date().toISOString()
            const changed = store.mutate('human:panel', 'human_edit', { ops, note: body.note ?? null }, (b) => {
              store.applyEditOps(ops as EditOp[], now)
            })
            sendJson(res, 200, { ok: true, version: changed.version, changed: changed.nodes.length })
            return
          }
          sendErr(res, 404, 'NOT_FOUND', '未知路径 ' + sub)
          return
        }
        sendErr(res, 405, 'METHOD', '仅支持 GET/POST')
      } catch (e) {
        if (e instanceof BoardError) sendErr(res, e.code === 'PLAN_NOT_FOUND' ? 404 : 400, e.code, e.message)
        else sendErr(res, 500, 'INTERNAL', e instanceof Error ? e.message : String(e))
      }
    },
  })
  return unregister
}
