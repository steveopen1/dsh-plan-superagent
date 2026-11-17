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
import { createHash } from 'node:crypto';
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
];
/** 定义一个带类型的 KV 键（外部来源插件用这个自己声明键）。 */
export const record = (key) => key;
/** 稳定内容派生 id：同样的输入永远得到同样的 id（引擎 `core/ids.ts` 的 `key()`）。 */
export function stableKey(...values) {
    return createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 32);
}
/* ------------------------------------------------------------------ *
 * 健康条目
 * ------------------------------------------------------------------ */
/** 引擎固定的英文健康文案（`{name}` 占位）；面板按界面语言翻译 `code`。 */
export const HEALTH_TEXT = {
    setupPending: 'Waiting for the deployment check',
    sourceOff: 'Off',
    pollFailures: '{count} consecutive failed polls; last: {error}',
};
function fill(template, values) {
    return template.replace(/\{(\w+)\}/g, (whole, name) => values[name] ?? whole);
}
/** 按引擎的固定文案生成一条健康状态。 */
export function health(state, code, values = {}) {
    return { state, detail: fill(HEALTH_TEXT[code], values), code, ...Object.keys(values).length ? { values } : {} };
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
    constructor(message) { super(message); this.name = 'SchemaError'; }
}
function makeSchema(parse) {
    return {
        parse,
        safeParse(value) {
            try {
                return { success: true, data: parse(value) };
            }
            catch (error) {
                return { success: false, error: error instanceof Error ? error : new Error(String(error)) };
            }
        },
    };
}
function defaultOf(value) {
    return typeof value === 'function' ? value() : value;
}
/** 字符串字段。 */
export function str(opts = {}) {
    return makeSchema((value) => {
        if (value === undefined) {
            const fallback = defaultOf(opts.default);
            if (fallback === undefined)
                throw new SchemaError('expected a string');
            return fallback;
        }
        if (typeof value !== 'string')
            throw new SchemaError('expected a string');
        if (opts.min != null && value.length < opts.min)
            throw new SchemaError(`expected at least ${opts.min} characters`);
        if (opts.max != null && value.length > opts.max)
            throw new SchemaError(`expected at most ${opts.max} characters`);
        if (opts.pattern != null && !opts.pattern.test(value))
            throw new SchemaError(`does not match ${opts.pattern}`);
        return value;
    });
}
/** 数字字段。 */
export function num(opts = {}) {
    return makeSchema((value) => {
        if (value === undefined) {
            const fallback = defaultOf(opts.default);
            if (fallback === undefined)
                throw new SchemaError('expected a number');
            return fallback;
        }
        if (typeof value !== 'number' || !Number.isFinite(value))
            throw new SchemaError('expected a number');
        if (opts.int === true && !Number.isInteger(value))
            throw new SchemaError('expected an integer');
        if (opts.min != null && value < opts.min)
            throw new SchemaError(`expected at least ${opts.min}`);
        if (opts.max != null && value > opts.max)
            throw new SchemaError(`expected at most ${opts.max}`);
        return value;
    });
}
/** 可选字段：缺省即 undefined，不报错。 */
export function opt(schema) {
    return makeSchema((value) => value === undefined ? undefined : schema.parse(value));
}
/** 数组字段。 */
export function arr(item, opts = {}) {
    return makeSchema((value) => {
        if (value === undefined) {
            const fallback = defaultOf(opts.default);
            if (fallback === undefined)
                throw new SchemaError('expected an array');
            return fallback;
        }
        if (!Array.isArray(value))
            throw new SchemaError('expected an array');
        return value.map((entry, index) => {
            try {
                return item.parse(entry);
            }
            catch (error) {
                throw new SchemaError(`[${index}]: ${error instanceof Error ? error.message : String(error)}`);
            }
        });
    });
}
/**
 * 对象字段。`strict`（默认）拒绝未知键；非 strict 时忽略未知键（策略部分用宽松模式，
 * 因为引擎会把整个 `policy.sources.<kind>` 段落连同别的键一起交给它校验）。
 */
export function obj(shape, opts = {}) {
    const strict = opts.strict !== false;
    return makeSchema((value) => {
        if (typeof value !== 'object' || value === null || Array.isArray(value))
            throw new SchemaError('expected an object');
        const input = value;
        const out = {};
        for (const key of Object.keys(shape))
            out[key] = shape[key].parse(input[key]);
        if (strict) {
            const extra = Object.keys(input).filter((key) => !(key in shape));
            if (extra.length > 0)
                throw new SchemaError('unknown key(s): ' + extra.join(', '));
        }
        return out;
    });
}
/** 在既有 schema 上加一条自定义校验（返回字符串即错误原因）。 */
export function refine(schema, check) {
    return makeSchema((value) => {
        const parsed = schema.parse(value);
        const result = check(parsed);
        if (result === false)
            throw new SchemaError('failed the check');
        if (typeof result === 'string')
            throw new SchemaError(result);
        return parsed;
    });
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
];
/** 桥这份副本认识的 SourceContext 成员。 */
export const BRIDGE_SOURCE_CONTEXT_FIELDS = [
    'deployment', 'commands', 'ready', 'configured', 'config', 'receive', 'atomic',
    'state', 'threads', 'tickets', 'triggers', 'notify', 'report',
];
/** 桥这份副本认识的 Trigger 字段。 */
export const BRIDGE_TRIGGER_FIELDS = [
    'id', 'source', 'threads', 'actor', 'human', 'addressed', 'at', 'text', 'channel', 'url', 'meta',
];
/** 桥这份副本认识的 Ticket 字段（只抄了桥读得到的那些）。 */
export const BRIDGE_TICKET_FIELDS = [
    'id', 'title', 'ended', 'assignments', 'execution', 'origin', 'mandate', 'createdAt', 'updatedAt',
];
/** 桥这份副本认识的外发通道字段。 */
export const BRIDGE_CHANNEL_FIELDS = ['allowed', 'send', 'link'];
/** 桥这份副本认识的策略段字段。 */
export const BRIDGE_POLICY_FIELDS = ['schema', 'fields', 'explicit', 'unnamed', 'rows'];
/** 桥这份副本认识的线程上下文字段。 */
export const BRIDGE_THREAD_CONTEXT_FIELDS = ['messageId', 'read'];
/** 健康状态。 */
export const BRIDGE_HEALTH_STATES = ['starting', 'ready', 'paused', 'error'];
/** 桥用的健康码（引擎还有飞书专用的两个，桥用不到）。 */
export const BRIDGE_HEALTH_CODES = ['setupPending', 'sourceOff', 'pollFailures'];
/** 健康条目的字段。 */
export const BRIDGE_HEALTH_FIELDS = ['state', 'detail', 'at', 'code', 'values'];
/** 桥在运行时真正用到的 SourceContext 成员：这些名字在引擎里一改，桥就读到 undefined，而编译期看不出来。 */
export const BRIDGE_USED_CONTEXT_MEMBERS = [
    'ready', 'configured', 'report', 'config', 'state', 'receive', 'threads', 'tickets', 'triggers',
];
/** 桥在运行时真正读到的 Ticket 字段。 */
export const BRIDGE_USED_TICKET_FIELDS = ['id', 'ended', 'assignments', 'execution', 'origin'];
/** 桥在运行时真正读到的 Trigger 字段。 */
export const BRIDGE_USED_TRIGGER_FIELDS = ['id', 'threads', 'meta', 'channel'];
//# sourceMappingURL=contract.js.map