/**
 * 桥的自测（独立可跑）：`node scripts/bridge-selftest.mjs`
 *
 * 不引新依赖：先用包内的 typescript 把 `src/bridge/**` 与它用到的几个 `src/board/**`
 * 编译到临时目录，再用 node 直接跑断言。跑完自动清理临时目录。
 *
 * 覆盖的语义（改动这些语义时必须同步改这里的用例）：
 * - L1 单发号：板上两个 ready 只派一个；第一个收卷后才派第二个。
 * - reconcile：板上有 ready、引擎里没有工单且过了宽限期 → 健康提示出现中文文案。
 * - 单向同步：结果回写之后桥不会自己重派（没有 引擎→板→引擎 的回环）。
 * - 幂等与证据门：重复轮询不建第二张单；done 必须带证据；失败落 blocked 不自动重派。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 断言与用例。 */
let failures = 0
function ok(label, cond, extra) {
  if (cond) { console.log('PASS ' + label); return }
  failures += 1
  console.log('FAIL ' + label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)))
}

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
if (!existsSync(tsc)) {
  console.error('自测需要包内的 typescript：先在包根目录执行 `npm install`（或 pnpm install）。')
  process.exit(1)
}

// 编译目录放在系统临时目录：桥的代码不依赖包内 node_modules（没有裸模块导入），
// 放包外可以保证「清理失败也不会把产物留在仓里」。
const out = mkdtempSync(join(tmpdir(), 'plan-bridge-selftest-'))
try {
  writeFileSync(join(out, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8')
  execFileSync(process.execPath, [
    tsc,
    'src/bridge/contract.ts', 'src/bridge/trigger.ts', 'src/bridge/source.ts', 'src/bridge/watch.ts',
    'src/board/schema.ts', 'src/board/store.ts', 'src/board/pathutil.ts', 'src/board/gitwatch.ts',
    '--outDir', out, '--target', 'es2023', '--module', 'nodenext', '--moduleResolution', 'nodenext',
    '--strict', '--skipLibCheck', '--types', 'node', '--esModuleInterop', '--declaration', 'false',
  ], { cwd: root, stdio: 'inherit' })

  const watch = await import(pathToFileURL(join(out, 'bridge', 'watch.js')).href)
  const store = await import(pathToFileURL(join(out, 'board', 'store.js')).href)
  await run(watch, store)
} finally {
  rmSync(out, { recursive: true, force: true })
}
if (failures > 0) {
  console.error('自测失败：' + failures + ' 条用例没过')
  process.exit(1)
}
console.log('自测全部通过')

async function run(watch, store) {
  const { pollPlanboard, describePoll, doingTasks, reconcileUnmatched, KV_DISPATCHED, KV_RECONCILE } = watch
  const { PlanStore } = store

  const now = new Date().toISOString()
  const project = mkdtempSync(join(tmpdir(), 'plan-selftest-'))
  const board = PlanStore.ensure(project, { blockOnDrift: false }, { name: 'selftest', goal: '验桥' })
  board.mutate('selftest', 'setup', {}, (b) => {
    b.nodes.push({ id: 'm-1', type: 'module', parent: null, title: '模块', status: 'planned', deps: [], createdAt: now, updatedAt: now })
    for (const id of ['t-1', 't-2', 't-3', 't-4']) {
      b.nodes.push({ id, type: 'task', parent: 'm-1', title: '任务 ' + id, status: 'planned', deps: [], acceptance: ['做完 ' + id], scope: [], evidence: [], createdAt: now, updatedAt: now })
    }
  })
  const config = { project, actor: 'planboard', designsDir: '.plan-board/designs', pollSeconds: 15 }
  const signal = new AbortController().signal
  const read = () => JSON.parse(readFileSync(join(project, '.plan-board', 'plan.board.json'), 'utf8'))
  const nodeOf = (id) => read().nodes.find((n) => n.id === id)
  const ticketsOf = (taskId) => tickets.filter((t) => t.title === taskId)

  // ---- 假引擎 ----
  const state = new Map()
  const triggers = new Map()
  const tickets = []
  let ticketSeq = 0
  let receiveFails = false
  const ctx = {
    deployment: undefined,
    commands: { run: async () => '' },
    ready: Promise.resolve(),
    configured: () => true,
    config: (kind) => (kind === 'planboard' ? config : undefined),
    receive: async (trigger) => {
      if (receiveFails) throw new Error('engine refused the trigger')
      if (triggers.has(trigger.id)) return 'duplicate'
      triggers.set(trigger.id, trigger)
      ticketSeq += 1
      tickets.push({
        id: 'tk-' + ticketSeq, title: trigger.meta.taskId, ended: undefined,
        assignments: [{ id: 'as-1', state: 'running', createdAt: now, report: { state: 'ready', summary: '干完了\nPR: https://example.com/pr/1', at: now } }],
        execution: { name: 'wt', directory: join(project, '.wt'), assignment: 'do it' },
        origin: { triggerId: trigger.id, triggerIds: [trigger.id] },
        mandate: { actor: trigger.actor, strength: 'explicit', scope: 's' },
        createdAt: now, updatedAt: now,
      })
      return 'stored'
    },
    atomic: (work) => work(),
    state: {
      get: (key) => state.get(key),
      set: (key, value) => { if (value === undefined) state.delete(key); else state.set(key, value) },
      keys: () => [],
    },
    threads: { get: () => undefined, subscribed: () => [], describe: () => {}, patch: () => {} },
    tickets: {
      get: (id) => tickets.find((t) => t.id === id),
      open: () => tickets.filter((t) => t.ended == null),
      bindThread: () => {}, threadClosed: () => {},
    },
    triggers: { get: (id) => triggers.get(id), latest: () => undefined },
    notify: () => {},
    report: () => {},
  }

  // ===== 派单失败 + reconcile（先做：此时板上没有任何 doing，reconcile 才不会被 L1 锁挡住）=====
  receiveFails = true
  const failedRound = await pollPlanboard(ctx, config, signal)
  ok('派单失败：记一次 failed', failedRound.failed === 1, failedRound)
  ok('派单失败：任务没有被硬改成 doing', nodeOf('t-1').status === 'planned', nodeOf('t-1'))
  ok('reconcile：宽限期内不报', failedRound.unmatched === 0, failedRound)
  // 把「首次发现」的时刻往前拨：模拟已经过了宽限期。
  const seen = { ...(state.get(KV_RECONCILE) ?? {}) }
  seen['t-1'] = Date.now() - 120000
  state.set(KV_RECONCILE, seen)
  const staleRound = await pollPlanboard(ctx, config, signal)
  ok('reconcile：过宽限期后报出来', staleRound.unmatched === 1, staleRound)
  ok('reconcile：提示是中文、人看得懂', describePoll(staleRound).includes('板上有 1 个 ready 任务但引擎里没有对应工单，可能派发失败'), describePoll(staleRound))
  receiveFails = false

  // ===== L1 单发号：板上四个 ready 只派一个 =====
  const first = await pollPlanboard(ctx, config, signal)
  ok('L1：只派一个任务', first.dispatched === 1 && first.ready === 4, first)
  ok('L1：派出的任务变 doing', nodeOf('t-1').status === 'doing', nodeOf('t-1'))
  ok('L1：其它 ready 任务没被动', nodeOf('t-2').status === 'planned' && nodeOf('t-3').status === 'planned' && nodeOf('t-4').status === 'planned')
  ok('L1：引擎里只有一张单', tickets.length === 1, tickets.length)

  // 幂等：再来一轮也不会多派
  const again = await pollPlanboard(ctx, config, signal)
  ok('L1：重复轮询不建第二张单', again.dispatched === 0 && tickets.length === 1, again)

  // ===== 第一个 done 之后派第二个 =====
  tickets[0].ended = { at: now, by: 'executor', outcome: 'completed' }
  const settledRound = await pollPlanboard(ctx, config, signal)
  ok('收单：任务落 done', nodeOf('t-1').status === 'done', nodeOf('t-1'))
  ok('收单：证据写回板', (nodeOf('t-1').evidence ?? []).length >= 2, nodeOf('t-1').evidence)
  ok('收单：工单号与 PR 链接都在证据里', JSON.stringify(nodeOf('t-1').evidence).includes('tk-1') && JSON.stringify(nodeOf('t-1').evidence).includes('https://example.com/pr/1'), nodeOf('t-1').evidence)
  ok('L1：第一个 done 后派第二个', settledRound.dispatched === 1 && tickets.length === 2 && nodeOf('t-2').status === 'doing', settledRound)
  ok('L1：其余 ready 任务继续等', nodeOf('t-3').status === 'planned' && nodeOf('t-4').status === 'planned')

  // ===== 失败结局落 blocked，不自动重派 =====
  tickets[1].ended = { at: new Date().toISOString(), by: 'human', outcome: 'stopped', reason: '人叫停' }
  const blockedRound = await pollPlanboard(ctx, config, signal)
  ok('失败：任务落 blocked 等人处置', nodeOf('t-2').status === 'blocked', nodeOf('t-2'))
  ok('失败：证据照样记下来', (nodeOf('t-2').evidence ?? []).length >= 1, nodeOf('t-2').evidence)
  ok('L1：锁释放后派下一个', blockedRound.dispatched === 1 && nodeOf('t-3').status === 'doing', blockedRound)

  // ===== 单向同步：写回之后桥不会自己重派（没有 引擎→板→引擎 的回环）=====
  // 人把正在做的任务放回就绪态（板会拒绝 planned→done 的硬掰），工单这时结束。
  const human = PlanStore.open(project, { blockOnDrift: false })
  human.mutate('human:panel', 'human_edit', {}, (b) => {
    const n = b.nodes.find((x) => x.id === 't-3')
    n.status = 'planned'
    n.updatedAt = new Date().toISOString()
  })
  tickets[2].ended = { at: new Date().toISOString(), by: 'executor', outcome: 'completed' }
  await pollPlanboard(ctx, config, signal)
  ok('回环：状态流转被拒时不硬掰', nodeOf('t-3').status === 'planned', nodeOf('t-3'))
  ok('回环：证据照样记下来', (nodeOf('t-3').evidence ?? []).length >= 1, nodeOf('t-3').evidence)
  ok('回环：不会因为自己写回而重派同一个任务', ticketsOf('t-3').length === 1, tickets.map((t) => t.title))
  await pollPlanboard(ctx, config, signal)
  ok('回环：下一轮也不重派', ticketsOf('t-3').length === 1, tickets.map((t) => t.title))

  // ===== 口径一致性：桥看到的 doing 与板工具看到的是同一个 =====
  const live = PlanStore.open(project, { blockOnDrift: false }).board
  ok('L1 口径：桥的 doingTasks 与板一致', doingTasks(live).length === live.nodes.filter((n) => n.type === 'task' && n.status === 'doing').length)

  // ===== reconcile 的纯函数口径 =====
  ok('reconcile：没有 ready 就不报', reconcileUnmatched(live, {}, [], {}, Date.now()) === 0)
  const seenMap = {}
  const board2 = { nodes: [{ id: 'x', type: 'task', status: 'ready', deps: [] }] }
  ok('reconcile：第一次看见不报', reconcileUnmatched(board2, {}, board2.nodes, seenMap, 1000) === 0)
  ok('reconcile：持续超过宽限期才报', reconcileUnmatched(board2, {}, board2.nodes, seenMap, 1000 + 91_000) === 1)
  ok('reconcile：有 doing（锁被占）时不报', reconcileUnmatched({ nodes: [{ id: 'y', type: 'task', status: 'doing', deps: [] }] }, {}, board2.nodes, {}, 1000) === 0)

  // 台账落在引擎给的 KV 里（桥不自己存盘）
  ok('台账：派单记录写进 ctx.state', typeof state.get(KV_DISPATCHED) === 'object' && Object.keys(state.get(KV_DISPATCHED)).length > 0)
}