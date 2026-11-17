/**
 * 副本一致性自测（独立可跑）：`node scripts/bridge-contract-selftest.mjs`
 *
 * 不引新依赖：先用包内的 typescript 把 `src/bridge/**` 编译到临时目录，再用 node 直接跑断言。
 *
 * 它回答一个问题：**桥按旧副本写的那份实现，在现在的引擎上还成立吗？**
 *
 * 覆盖的语义（改动这些语义时必须同步改这里的用例）：
 * - 桥抄的契约与引擎现在承诺的契约逐项一致（引擎改名 → 这里红）；
 * - 桥那个 kind 的实现满足引擎现在的要求（引擎要求的字段都有，桥多出来的字段引擎也认）；
 * - 桥的 mini-schema 与引擎依赖的语义一致（填默认值、拒绝未知键、safeParse 不抛）；
 * - 反向对照：把契约改坏（模拟引擎升版改名）时，比对必须**报出来**，否则上面的"绿"没有意义。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

const out = mkdtempSync(join(tmpdir(), 'plan-bridge-contract-'))
try {
  writeFileSync(join(out, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8')
  execFileSync(process.execPath, [
    tsc,
    'src/bridge/contract.ts', 'src/bridge/contract-check.ts', 'src/bridge/trigger.ts', 'src/bridge/source.ts',
    'src/board/schema.ts', 'src/board/store.ts', 'src/board/pathutil.ts', 'src/board/gitwatch.ts',
    '--outDir', out, '--target', 'es2023', '--module', 'nodenext', '--moduleResolution', 'nodenext',
    '--strict', '--skipLibCheck', '--types', 'node', '--esModuleInterop', '--declaration', 'false',
  ], { cwd: root, stdio: 'inherit' })

  const check = await import(pathToFileURL(join(out, 'bridge', 'contract-check.js')).href)
  const contract = await import(pathToFileURL(join(out, 'bridge', 'contract.js')).href)
  const source = await import(pathToFileURL(join(out, 'bridge', 'source.js')).href)
  await run(check, contract, source)
} finally {
  rmSync(out, { recursive: true, force: true })
}
if (failures > 0) {
  console.error('自测失败：' + failures + ' 条用例没过')
  process.exit(1)
}
console.log('自测全部通过')

async function run(check, contract, source) {
  const { compareBridgeToEngine, loadEngineContract } = check
  const { obj, str, BRIDGE_SOURCE_KIND_FIELDS } = contract
  const { planboardKind } = source

  // ===== 找到引擎的契约 =====
  let loaded
  try {
    loaded = await loadEngineContract(root)
  } catch (error) {
    console.error('找不到引擎的契约模块：' + String(error))
    failures += 1
    return
  }
  console.log('引擎契约来源：' + loaded.source + '（版本 ' + loaded.contract.version + '）')
  const engine = loaded.contract

  // ===== 桥的副本与引擎的契约一致 =====
  const mismatches = compareBridgeToEngine(engine)
  ok('副本一致：桥抄的契约与引擎现在承诺的一致', mismatches.length === 0, mismatches)

  // ===== 反向对照：改坏契约时必须报出来 =====
  // 不然上面的"绿"只是比对函数永远返回空——那是自欺欺人。
  const broken = JSON.parse(JSON.stringify(engine))
  broken.kind.optional = broken.kind.optional.filter(name => name !== 'scope')
  const found = compareBridgeToEngine(broken)
  ok('反向对照：引擎改了字段名时比对报得出来', found.some(item => item.detail.includes('scope')), found)
  const brokenTrigger = JSON.parse(JSON.stringify(engine))
  brokenTrigger.trigger.required = brokenTrigger.trigger.required.filter(name => name !== 'threads')
  ok('反向对照：引擎改了触发器字段名时比对报得出来',
    compareBridgeToEngine(brokenTrigger).some(item => item.area === 'trigger'), compareBridgeToEngine(brokenTrigger))

  // ===== 桥那个 kind 的实现，在新引擎上还成立吗 =====
  const engineKind = [...engine.kind.required, ...(engine.kind.optional ?? [])]
  const missing = engine.kind.required.filter(name => planboardKind[name] === undefined)
  ok('kind 实现：引擎要求的字段桥都实现了', missing.length === 0, missing)
  const extra = Object.keys(planboardKind).filter(name => !engineKind.includes(name))
  ok('kind 实现：桥多出来的字段引擎也认', extra.length === 0, extra)
  // 可选成员桥可以不实现（引擎只在存在时调用），但 kind 上不能有副本没声明的成员。
  const undeclared = Object.keys(planboardKind).filter(name => !BRIDGE_SOURCE_KIND_FIELDS.includes(name))
  ok('kind 实现：kind 上没有副本没声明的成员', undeclared.length === 0, undeclared)

  // ===== 桥的 mini-schema 与引擎依赖的语义一致 =====
  // 引擎对 kind 的 schema 只用 parse/safeParse，并依赖「填默认值」与「拒绝未知键」两件事。
  const schema = obj({ token: str({ default: 't' }) }, { strict: true })
  ok('schema：缺省字段取默认值', schema.parse({}).token === 't')
  ok('schema：未知键被拒绝', (() => { try { schema.parse({ token: 'x', extra: 1 }); return false } catch { return true } })())
  ok('schema：safeParse 对未知键不抛', schema.safeParse({ extra: 1 }).success === false)
  ok('schema：合法值通过', schema.parse({ token: 'x' }).token === 'x')
}
