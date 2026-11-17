/**
 * dsh-superagent 契约的**本地结构化副本**（Source 插件侧最小可用集）。
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
/** 定义一个带类型的 KV 键（外部来源插件用这个自己声明键）。 */
export const record = (key) => key;
/** 定义一个键族，键名以 `prefix` 开头。 */
export function family(prefix, format = (...name) => name.join(':')) {
    return Object.assign((...name) => `${prefix}${format(...name)}`, { prefix });
}
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
/** 布尔字段。 */
export function bool(opts = {}) {
    return makeSchema((value) => {
        if (value === undefined) {
            const fallback = defaultOf(opts.default);
            if (fallback === undefined)
                throw new SchemaError('expected a boolean');
            return fallback;
        }
        if (typeof value !== 'boolean')
            throw new SchemaError('expected a boolean');
        return value;
    });
}
/** 枚举字段。 */
export function enumOf(values, opts = {}) {
    return makeSchema((value) => {
        if (value === undefined) {
            const fallback = defaultOf(opts.default);
            if (fallback === undefined)
                throw new SchemaError('expected one of ' + values.join(', '));
            return fallback;
        }
        if (typeof value !== 'string' || !values.includes(value))
            throw new SchemaError('expected one of ' + values.join(', '));
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
//# sourceMappingURL=contract.js.map