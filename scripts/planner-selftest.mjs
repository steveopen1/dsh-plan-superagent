/**
 * 规划器的自测（独立可跑）：`node scripts/planner-selftest.mjs`
 *
 * 不引新依赖：先用包内的 typescript 把 `src/planner/**` 编译到包内临时目录，再用 node 跑断言。
 * 编译目录放在包内是有意的——zod 目前只装在用户级 node_modules，放到包外会解析不到。
 * 跑完自动清理临时目录。
 *
 * 覆盖的语义（改动这些语义时必须同步改这里的用例）：
 * - 两段式：树阶段不带 design（RawPlanSchema 允许 design 缺省），子导图逐任务单独生成。
 * - 降级：单张导图失败不废掉整棵计划，退化成按验收标准与范围推导的一份，且不编造 scope 之外的文件。
 * - 透传：树阶段与子导图阶段都必须带上调用方指定的 provider/model。
 */

/** 断言与用例。 */
let failures = 0
function ok(label, cond, extra) {
  if (cond) { console.log('PASS ' + label); return }
  failures += 1
  console.log('FAIL ' + label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)))
}

/** 一棵不含 design 的树（模型第一段就该只给这些）。 */
function treeRaw() {
  return {
    plan: { name: '导出功能', goal: '给插件加一个把任务导出成 Markdown 的命令' },
    modules: [
      {
        key: 'm1',
        title: '命令与渲染',
        tasks: [
          { key: 't1', title: '实现 export 命令', acceptance: ['输入路径能生成 .md'], scope: ['src/export.ts'], deps: [], priority: 2 },
          { key: 't2', title: '补导出测试', acceptance: ['测试通过'], scope: ['test/export.test.mjs'], deps: ['t1'] },
        ],
      },
    ],
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
const { existsSync, mkdirSync, rmSync, writeFileSync } = await import('node:fs')
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
    'src/planner/schema.ts', 'src/planner/prompt.ts', 'src/planner/llm.ts', 'src/planner/generate.ts',
    '--outDir', out, '--target', 'es2023', '--module', 'nodenext', '--moduleResolution', 'nodenext',
    '--strict', '--skipLibCheck', '--types', 'node', '--esModuleInterop', '--declaration', 'false',
  ], { cwd: root, stdio: 'inherit' })

  const schema = await import(pathToFileURL(join(out, 'schema.js')).href)
  const prompt = await import(pathToFileURL(join(out, 'prompt.js')).href)
  const gen = await import(pathToFileURL(join(out, 'generate.js')).href)
  await run(schema, prompt, gen)
} finally {
  rmSync(out, { recursive: true, force: true })
}
if (failures > 0) {
  console.error('自测失败：' + failures + ' 条用例没过')
  process.exit(1)
}
console.log('自测全部通过')

/** 假模型：按提示词形态决定回树还是回导图（不靠调用顺序，顺序会骗人）。 */
function fakeModel(calls, opts) {
  const o = opts ?? {}
  return {
    get(key) {
      if (key === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'host-provider', model: 'host-model' }) }
      if (key === 'llm') {
        return {
          prepareCall: async (options) => {
            calls.push(options)
            return {
              config: {},
              stream: async function* (payload) {
                const idx = calls.length - 1
                const user = payload.messages[0].content[0].text
                calls[idx].user = user
                const isDesign = user.includes('字段固定五个')
                let text = isDesign ? JSON.stringify(DESIGN_RAW) : JSON.stringify(treeRaw())
                if (o.breakDesigns && isDesign) text = '这不是 JSON'
                calls[idx].text = text
                yield { type: 'text-delta', text }
                yield { type: 'finish', reason: { kind: o.breakDesigns && isDesign ? 'error' : 'stop', failure: { message: 'boom' } } }
              },
            }
          },
        }
      }
      return undefined
    },
  }
}

async function run(schema, prompt, gen) {
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
  const plan = await gen.generatePlan({ ctx: fakeModel(calls), sentence: '给插件加一个把任务导出成 Markdown 的命令', provider: 'p-x', model: 'm-x' })
  ok('③ 树 + 每张子导图都调用了模型', calls.length === 3, calls.map((c) => c.text))
  ok('③ provider/model 两段都透传', calls.every((c) => c.provider === 'p-x' && c.model === 'm-x'), calls.map((c) => c.provider + '/' + c.model))
  ok('③ 子导图阶段用小 maxTokens', calls.slice(1).every((c) => c.maxTokens === 2000), calls.map((c) => c.maxTokens))
  ok('③ 树阶段的提示词不含 design', calls.length > 0 && !calls[0].user.includes('task.design'))
  ok('③ 子导图阶段的提示词带任务标题', calls.length > 1 && calls[1].user.includes('实现 export 命令'))

  const tasks = plan.modules.flatMap((m) => m.tasks)
  ok('③ 最终计划每个任务都有导图', tasks.length === 2 && tasks.every((t) => t.design != null), tasks.map((t) => t.design))
  ok('③ 最终计划能过 PlanSchema', schema.PlanSchema.safeParse(plan).success)
  ok('③ 模型给的导图被采纳（不是推导的）', tasks.every((t) => t.design.summary === DESIGN_RAW.summary), tasks.map((t) => t.design.summary))

  // ===== ④ 子导图阶段全挂 → 降级而不是整棵作废 =====
  const brokenCalls = []
  const degraded = await gen.generatePlan({ ctx: fakeModel(brokenCalls, { breakDesigns: true }), sentence: 'x' })
  const dTasks = degraded.modules.flatMap((m) => m.tasks)
  ok('④ 子导图全失败仍拿到计划', dTasks.length === 2 && dTasks.every((t) => t.design != null))
  ok('④ 降级的导图写明是自动推导', dTasks.every((t) => t.design.summary.includes('自动推导')), dTasks.map((t) => t.design.summary))
  ok('④ 子导图失败也只重试 2 次', brokenCalls.length === 1 + 2 * 2, brokenCalls.length)

  // ===== ⑤ designs:false = 不花模型调用，直接推导 =====
  const noDesignCalls = []
  const quick = await gen.generatePlan({ ctx: fakeModel(noDesignCalls), sentence: 'x', designs: false })
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
}

