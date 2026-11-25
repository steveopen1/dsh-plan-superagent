/**
 * 规划器的自测（独立可跑）：`node scripts/planner-selftest.mjs`
 *
 * 不引新依赖：先用包内的 typescript 把 `src/planner/**` 与它用到的 `src/board/**`
 * 编译到包内临时目录，再用 node 跑断言。
 * 编译目录放在包内是有意的——zod 目前只装在用户级 node_modules，放到包外会解析不到。
 * 跑完自动清理临时目录。
 *
 * 覆盖的语义（改动这些语义时必须同步改这里的用例）：
 * - 两段式：树阶段不带 design（RawPlanSchema 允许 design 缺省），子导图逐任务单独生成。
 * - 并发：子导图是并发跑的（同时在飞 > 1），且并发数有上限（保守 3）。
 * - 预算：树阶段最多吃总预算的 55%，剩下的必须留给子导图阶段。
 * - 降级：单张导图失败不废掉整棵计划，退化成按验收标准与范围推导的一份，且不编造 scope 之外的文件。
 * - 透传：树阶段与子导图阶段都必须带上调用方指定的 provider/model。
 * - 如实汇报：子导图文件带 source（model/derived），别让人以为拿到的全是真导图。
 */

/** 断言与用例。 */
let failures = 0
function ok(label, cond, extra) {
  if (cond) { console.log('PASS ' + label); return }
  failures += 1
  console.log('FAIL ' + label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)))
}

/** 一棵不含 design 的树（模型第一段就该只给这些）。 */
function treeRaw(taskCount = 2) {
  const tasks = []
  for (let i = 1; i <= taskCount; i++) {
    tasks.push({
      key: 't' + i,
      title: '任务 ' + i,
      acceptance: ['验收 ' + i],
      scope: ['src/file' + i + '.ts'],
      deps: i > 1 ? ['t' + (i - 1)] : [],
    })
  }
  return {
    plan: { name: '导出功能', goal: '给插件加一个把任务导出成 Markdown 的命令' },
    modules: [{ key: 'm1', title: '命令与渲染', tasks }],
  }
}

/** 一张子导图（模型第二段就该只给这些）。 */
const DESIGN_RAW = {
  summary: '读板子渲染成 markdown 大纲',
  steps: ['读板子', '渲染大纲'],
  files: ['src/export.ts'],
  risks: ['大板子渲染慢'],
  tests: ['node scripts/export.test.mjs'],
}

const { execFileSync } = await import('node:child_process')
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { dirname, join } = await import('node:path')
const { fileURLToPath, pathToFileURL } = await import('node:url')

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
if (!existsSync(tsc)) {
  console.error('自测需要包内的 typescript：先在包根目录执行 `npm install`（或 pnpm install）。')
  process.exit(1)
}

const out = join(root, '.planner-selftest-tmp')
rmSync(out, { recursive: true, force: true })
try {
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8')
  execFileSync(process.execPath, [
    tsc,
    'src/planner/schema.ts', 'src/planner/prompt.ts', 'src/planner/llm.ts', 'src/planner/generate.ts', 'src/planner/apply.ts',
    'src/board/schema.ts', 'src/board/store.ts', 'src/board/pathutil.ts', 'src/board/gitwatch.ts',
    '--outDir', out, '--target', 'es2023', '--module', 'nodenext', '--moduleResolution', 'nodenext',
    '--strict', '--skipLibCheck', '--types', 'node', '--esModuleInterop', '--declaration', 'false',
  ], { cwd: root, stdio: 'inherit' })

  const schema = await import(pathToFileURL(join(out, 'planner', 'schema.js')).href)
  const prompt = await import(pathToFileURL(join(out, 'planner', 'prompt.js')).href)
  const gen = await import(pathToFileURL(join(out, 'planner', 'generate.js')).href)
  const apply = await import(pathToFileURL(join(out, 'planner', 'apply.js')).href)
  await run(schema, prompt, gen, apply)
} finally {
  rmSync(out, { recursive: true, force: true })
}
if (failures > 0) {
  console.error('自测失败：' + failures + ' 条用例没过')
  process.exit(1)
}
console.log('自测全部通过')

/**
 * 假模型：按提示词形态决定回树还是回导图（不靠调用顺序，顺序会骗人）。
 * state.inFlight / state.maxInFlight 用来断言并发度。
 */
function fakeModel(calls, opts) {
  const o = opts ?? {}
  const state = { inFlight: 0, maxInFlight: 0 }
  const ctx = {
    get(key) {
      if (key === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'host-provider', model: 'host-model' }) }
      if (key === 'llm') {
        return {
          prepareCall: async (options) => {
            const idx = calls.length
            calls.push(options)
            return {
              config: {},
              stream: async function* (payload) {
                const user = payload.messages[0].content[0].text
                calls[idx].user = user
                const isDesign = user.includes('字段固定五个')
                state.inFlight += 1
                if (state.inFlight > state.maxInFlight) state.maxInFlight = state.inFlight
                try {
                  const delay = isDesign ? (o.designDelayMs ?? 60) : (o.treeDelayMs ?? 0)
                  if (delay > 0) await new Promise((r) => setTimeout(r, delay))
                  let text = isDesign ? JSON.stringify(DESIGN_RAW) : JSON.stringify(o.treeTasks ? treeRaw(o.treeTasks) : treeRaw())
                  if (o.breakDesigns && isDesign) text = '这不是 JSON'
                  calls[idx].text = text
                  yield { type: 'text-delta', text }
                  yield { type: 'finish', reason: { kind: (o.breakDesigns && isDesign) ? 'error' : 'stop', failure: { message: 'boom' } } }
                } finally {
                  state.inFlight -= 1
                }
              },
            }
          },
        }
      }
      return undefined
    },
  }
  return { ctx, state }
}

async function run(schema, prompt, gen, apply) {
  // ===== ① 树阶段不含 design 也能通过 schema =====
  const parsedTree = schema.RawPlanSchema.safeParse(treeRaw())
  ok('① 树（无 design）能过 RawPlanSchema', parsedTree.success, parsedTree.success ? undefined : parsedTree.error.issues)
  const treeOnly = prompt.buildUserPrompt({ sentence: 'x', includeDesigns: false })
  ok('① 树提示词不提 design 字段', !treeOnly.includes('task.design') && treeOnly.includes('不要**输出 design 字段'))
  const withDesigns = prompt.buildUserPrompt({ sentence: 'x' })
  ok('① 默认提示词仍讲 design（单测用）', withDesigns.includes('task.design'))
  ok('① 树阶段的 system 提示词说清不写 design', prompt.PLAN_SYSTEM_PROMPT.includes('不要写 design'))

  // ===== ② derivedDesign 的形状合法且不编造 scope 之外的文件 =====
  const task = { title: '实现 export 命令', acceptance: ['输入路径能生成 .md', '生成的 md 含全部 task'], scope: ['src/export.ts'] }
  const derived = gen.derivedDesign(task)
  const derivedOk = schema.TaskDesignSchema.safeParse(derived)
  ok('② 推导的导图形状合法', derivedOk.success, derivedOk.success ? undefined : derivedOk.error.issues)
  ok('② 推导的导图只碰 scope 里的文件', derived.files.every((f) => task.scope.includes(f)), derived.files)
  ok('② 推导的导图写明是自动推导', derived.summary.includes('自动推导'), derived.summary)
  ok('② 推导的导图步骤/验证来自验收标准', derived.steps.length === task.acceptance.length && derived.tests.length === task.acceptance.length, derived)
  const noScope = gen.derivedDesign({ title: 'T', acceptance: ['a'], scope: [] })
  ok('② scope 为空时不编造文件', noScope.files.length === 0 && schema.TaskDesignSchema.safeParse(noScope).success, noScope)

  // ===== ③ 两段之间 provider/model 透传 =====
  const calls = []
  const plan = await gen.generatePlan({ ctx: fakeModel(calls).ctx, sentence: '给插件加一个把任务导出成 Markdown 的命令', provider: 'p-x', model: 'm-x' })
  ok('③ 树 + 每张子导图都调用了模型', calls.length === 3, calls.map((c) => c.text))
  ok('③ provider/model 两段都透传', calls.every((c) => c.provider === 'p-x' && c.model === 'm-x'), calls.map((c) => c.provider + '/' + c.model))
  ok('③ 子导图阶段用小 maxTokens', calls.slice(1).every((c) => c.maxTokens === 2000), calls.map((c) => c.maxTokens))
  ok('③ 树阶段的提示词不含 design', calls.length > 0 && !calls[0].user.includes('task.design'))
  ok('③ 子导图阶段的提示词带任务标题', calls.length > 1 && calls[1].user.includes('任务 1'))

  const tasks = plan.modules.flatMap((m) => m.tasks)
  ok('③ 最终计划每个任务都有导图', tasks.length === 2 && tasks.every((t) => t.design != null), tasks.map((t) => t.design))
  ok('③ 最终计划能过 PlanSchema', schema.PlanSchema.safeParse(plan).success)
  ok('③ 模型给的导图被采纳（不是推导的）', tasks.every((t) => t.design.summary === DESIGN_RAW.summary), tasks.map((t) => t.design.summary))

  // ===== ④ 子导图阶段全挂 → 降级而不是整棵作废 =====
  const brokenCalls = []
  const degraded = await gen.generatePlan({ ctx: fakeModel(brokenCalls, { breakDesigns: true }).ctx, sentence: 'x' })
  const dTasks = degraded.modules.flatMap((m) => m.tasks)
  ok('④ 子导图全失败仍拿到计划', dTasks.length === 2 && dTasks.every((t) => t.design != null))
  ok('④ 降级的导图写明是自动推导', dTasks.every((t) => t.design.summary.includes('自动推导')), dTasks.map((t) => t.design.summary))

  // ===== ⑤ designs:false = 不花模型调用，直接推导 =====
  const noDesignCalls = []
  const quick = await gen.generatePlan({ ctx: fakeModel(noDesignCalls).ctx, sentence: 'x', designs: false })
  ok('⑤ designs:false 只调一次模型（树）', noDesignCalls.length === 1, noDesignCalls.length)
  ok('⑤ designs:false 仍有导图（推导的）', quick.modules.flatMap((m) => m.tasks).every((t) => t.design != null))

  // ===== ⑥ 树阶段的流断了会重试（抗断流） =====
  let treeCalls = 0
  const flakyCtx = {
    get(key) {
      if (key === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      if (key === 'llm') {
        return {
          prepareCall: async () => ({
            config: {},
            stream: async function* (payload) {
              const user = payload.messages[0].content[0].text
              if (user.includes('字段固定五个')) {
                yield { type: 'text-delta', text: JSON.stringify(DESIGN_RAW) }
                yield { type: 'finish', reason: { kind: 'stop' } }
                return
              }
              treeCalls += 1
              if (treeCalls === 1) {
                yield { type: 'finish', reason: { kind: 'error', failure: { message: 'stream broke' } } }
                return
              }
              yield { type: 'text-delta', text: JSON.stringify(treeRaw()) }
              yield { type: 'finish', reason: { kind: 'stop' } }
            },
          }),
        }
      }
      return undefined
    },
  }
  const retried = await gen.generatePlan({ ctx: flakyCtx, sentence: 'x' })
  ok('⑥ 树阶段的流断了会重试', treeCalls === 2, treeCalls)
  ok('⑥ 重试后仍拿到完整计划', retried.modules.flatMap((m) => m.tasks).every((t) => t.design != null))

  // ===== ⑦ 树阶段第一次 ABORTED（上游把流中止了）→ 会重试 =====
  let abortCalls = 0
  const abortCtx = {
    get(key) {
      if (key === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      if (key === 'llm') {
        return {
          prepareCall: async () => ({
            config: {},
            stream: async function* (payload) {
              const user = payload.messages[0].content[0].text
              if (user.includes('字段固定五个')) {
                yield { type: 'text-delta', text: JSON.stringify(DESIGN_RAW) }
                yield { type: 'finish', reason: { kind: 'stop' } }
                return
              }
              abortCalls += 1
              if (abortCalls === 1) {
                yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'This operation was aborted' } } }
                return
              }
              yield { type: 'text-delta', text: JSON.stringify(treeRaw()) }
              yield { type: 'finish', reason: { kind: 'stop' } }
            },
          }),
        }
      }
      return undefined
    },
  }
  const afterAbort = await gen.generatePlan({ ctx: abortCtx, sentence: 'x' })
  ok('⑦ 树阶段第一次 ABORTED 会重试（不是立刻失败）', abortCalls === 2, abortCalls)
  ok('⑦ 重试后拿到完整计划', afterAbort.modules.flatMap((m) => m.tasks).every((t) => t.design != null))

  // ===== ⑧ 预算耗尽 → 报错要可行动 =====
  let burnCalls = 0
  const burnCtx = {
    get(key) {
      if (key === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      if (key === 'llm') {
        return {
          prepareCall: async () => ({
            config: {},
            stream: async function* () {
              burnCalls += 1
              await new Promise((r) => setTimeout(r, 1200))
              yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'This operation was aborted' } } }
            },
          }),
        }
      }
      return undefined
    },
  }
  let burnErr = null
  try {
    await gen.generatePlan({ ctx: burnCtx, sentence: 'x', timeoutMs: 10000, maxAttempts: 20 })
  } catch (e) { burnErr = e }
  ok('⑧ 预算耗尽会抛错', burnErr != null)
  ok('⑧ 报错有可行动的中文提示', burnErr != null && burnErr.message.includes('再点一次') && burnErr.message.includes('换一个更快的模型'), burnErr && burnErr.message)
  ok('⑧ 报错带实际尝试次数', burnErr != null && /尝试 \d+ 次/.test(burnErr.message), burnErr && burnErr.message)
  ok('⑧ 报错不是裸的 aborted', burnErr != null && !/aborted/i.test(burnErr.message), burnErr && burnErr.message)
  ok('⑧ 报错带最后一次失败原因', burnErr != null && burnErr.message.includes('响应流中断'), burnErr && burnErr.message)

  // ===== ⑨ 子导图是并发跑的（同时在飞 > 1），且并发数有上限 =====
  const concCalls = []
  const conc = fakeModel(concCalls, { treeTasks: 4, designDelayMs: 80 })
  const concPlan = await gen.generatePlan({ ctx: conc.ctx, sentence: 'x' })
  ok('⑨ 子导图并发执行（同时在飞 > 1）', conc.state.maxInFlight > 1, conc.state.maxInFlight)
  ok('⑨ 并发数有上限（不超过 3）', conc.state.maxInFlight <= 3, conc.state.maxInFlight)
  ok('⑨ 4 张子导图都出了', concPlan.modules.flatMap((m) => m.tasks).length === 4)

  // ===== ⑩ 树阶段吃不满总预算：剩下的留给子导图 =====
  const budgetCalls = []
  const budget = fakeModel(budgetCalls, { treeTasks: 4, designDelayMs: 20 })
  await gen.generatePlan({ ctx: budget.ctx, sentence: 'x', timeoutMs: 10000 })
  ok('⑩ 树很快返回时子导图仍有预算（都跑了）', budgetCalls.length === 5, budgetCalls.length)

  // 树很慢时：树的尝试被总预算的 55% 截断（不是让它吃光预算）
  const slowCalls = []
  const slow = fakeModel(slowCalls, { treeTasks: 2, treeDelayMs: 8000 })
  const t0 = Date.now()
  let slowErr = null
  try {
    await gen.generatePlan({ ctx: slow.ctx, sentence: 'x', timeoutMs: 10000 })
  } catch (e) { slowErr = e }
  const elapsed = Date.now() - t0
  ok('⑩ 树阶段被 55% 的预算截断（没吃光总预算）', elapsed < 7500, elapsed)
  ok('⑩ 截断后给出可行动的报错', slowErr != null && slowErr.message.includes('再点一次'), slowErr && slowErr.message)

  // ===== ⑪ 子导图文件带 source（model / derived）：别静默降级 =====
  const project = mkdtempSync(join(tmpdir(), 'planner-selftest-'))
  const modelPlan = {
    plan: { name: 'N', goal: 'G' },
    modules: [{ id: 'm-1', title: 'M', tasks: [{ id: 't-1', title: 'T', acceptance: ['a'], scope: [], deps: [], design: DESIGN_RAW }] }],
  }
  const applied = apply.applyPlanToBoard({ plan: modelPlan, project, opts: { blockOnDrift: true }, actor: 'selftest' })
  const file = JSON.parse(readFileSync(applied.designFiles[0].path, 'utf8'))
  ok('⑪ 模型写的导图标记 source=model', file.source === 'model', file.source)
  ok('⑪ 返回体带 designQuality 统计', applied.designQuality.model === 1 && applied.designQuality.derived === 0, applied.designQuality)

  const derivedPlan = {
    plan: { name: 'N', goal: 'G' },
    modules: [{ id: 'm-1', title: 'M', tasks: [{ id: 't-1', title: 'T', acceptance: ['a'], scope: ['src/x.ts'], deps: [], design: gen.derivedDesign({ title: 'T', acceptance: ['a'], scope: ['src/x.ts'] }) }] }],
  }
  const applied2 = apply.applyPlanToBoard({ plan: derivedPlan, project, opts: { blockOnDrift: true }, actor: 'selftest' })
  const file2 = JSON.parse(readFileSync(applied2.designFiles[0].path, 'utf8'))
  ok('⑪ 推导的导图标记 source=derived', file2.source === 'derived', file2.source)
  ok('⑪ 统计能分清 model / derived', applied2.designQuality.derived === 1 && applied2.designQuality.model === 0, applied2.designQuality)
  rmSync(project, { recursive: true, force: true })
}
