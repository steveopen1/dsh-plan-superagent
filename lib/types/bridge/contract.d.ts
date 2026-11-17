/** 文本在两种界面语言里的说法。 */
export interface Localized {
    zh: string;
    en: string;
}
/** `advanced` 把少改的字段折到卡片的高级区。 */
interface FieldBase {
    key: string;
    label: Localized;
    hint?: Localized;
    advanced?: true;
}
/**
 * 配置字段规格：`rows` 编辑以首列为主键的记录列表，`choose` 从已解析的来源标签里挑，
 * `fact` 展示 `facts` 里的只读值。形状对齐引擎 `src/sources/kind.ts` 的 `FieldSpec`。
 */
export type FieldSpec = FieldBase & {
    type: 'switch';
} | FieldBase & {
    type: 'select';
    options: {
        value: string;
        label: Localized;
    }[];
} | FieldBase & {
    type: 'number';
    min: number;
    max: number;
} | FieldBase & {
    type: 'text';
    pattern?: string;
    readonly?: boolean;
    choose?: Localized;
} | FieldBase & {
    type: 'fact';
    settings?: 'deployment';
} | FieldBase & {
    type: 'rows';
    columns: ({
        key: string;
        label: Localized;
        type: 'text';
        pattern?: string;
        optional?: boolean;
        choose?: Localized;
        refresh?: Localized;
    } | {
        key: string;
        label: Localized;
        type: 'select';
        options: {
            value: string;
            label: Localized;
        }[];
    })[];
};
/** 引擎为某个来源注册的执行环境变量。 */
export interface VariableSpec {
    key: string;
    description: Localized;
}
/** 执行者身份（用来源自己的词汇；策略决定谁能发起工作）。 */
export interface ActorRef {
    source: string;
    id: string;
}
/** 线程身份；由来源决定 id 的推导规则。 */
export interface ThreadRef {
    source: string;
    id: string;
}
/** 线程上的只写地址；地址格式由来源自己定。 */
export interface ChannelRef {
    source: string;
    thread: string;
    address: Record<string, string>;
}
/** 一个不可变事件；`text` 与 `meta` 是**不可信数据**，不是授权。 */
export interface Trigger {
    id: string;
    source: string;
    /** 触发器所属的全部线程；第一个（`threads[0]`）是承载评估的主线程。 */
    threads: ThreadRef[];
    actor: ActorRef;
    /** 来源声明：事件由人写的（不是机器人、CI 或本智能体）。 */
    human: boolean;
    /** 来源声明：发送者确实在跟智能体说话（@ 或私聊）。 */
    addressed?: 'mention' | 'direct';
    at: string;
    text: string;
    channel?: ChannelRef;
    url?: string;
    /** 来源原生细节；核心从不解释它。 */
    meta: Record<string, unknown>;
}
/** 触发器入库后的去向。 */
export type ReceiveResult = 'stored' | 'duplicate' | 'filtered';
/** 监听范围判定结果。 */
export type ScopeResult = {
    listened: true;
    observed: boolean;
    row?: string;
} | {
    listened: false;
    reason: string;
};
/** 出站消息（引擎 Outbox 投递）。 */
export interface OutboundMessage {
    id: string;
    channel: ChannelRef;
    text: string;
    kind: 'acknowledgement' | 'reply' | 'notice';
    ticketId?: string;
}
/** 线程展示信息。 */
export interface ThreadFact {
    label?: string | Localized;
    value: string | Localized;
    problem?: true;
}
export interface ThreadDescription {
    label?: string;
    url?: string;
    facts?: Record<string, ThreadFact | null>;
}
/** 线程聚合。 */
export interface Thread {
    key: string;
    ref: ThreadRef;
    createdAt: string;
    lastAt?: string;
    subscriptions: string[];
    meta: Record<string, unknown>;
}
/** 工单如何结束。 */
export type TicketEndBy = 'executor' | 'human';
export type TicketOutcome = 'completed' | 'merged' | 'closed' | 'dropped' | 'stopped';
/** 执行者的报告状态。 */
export type ReportState = 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped';
/** 工单与一个执行实例的绑定。 */
export interface Assignment {
    id: string;
    state: 'pending' | 'running' | 'ended';
    createdAt: string;
    startedAt?: string;
    endedAt?: string;
    endedReason?: string;
    report?: {
        state: ReportState;
        summary: string;
        at: string;
    };
}
/** 工单（授权过的工作项）。这里只复制桥读得到的字段。 */
export interface Ticket {
    id: string;
    title: string;
    ended?: {
        at: string;
        by: TicketEndBy;
        outcome: TicketOutcome;
        reason?: string;
    };
    assignments: Assignment[];
    execution?: {
        name: string;
        directory: string;
        assignment: string;
    };
    origin: {
        triggerId: string;
        triggerIds: string[];
    };
    mandate: {
        actor: ActorRef;
        strength: 'explicit' | 'inferred';
        scope: string;
    };
    createdAt: string;
    updatedAt: string;
}
/** 线程上下文消息。 */
export interface ContextMessage {
    id: string;
    from: string;
    at: string;
    text: string;
    bot?: true;
    deleted?: true;
    reply_to?: string;
    url?: string;
    path?: string;
    line?: number;
}
export type ContextPartName = 'thread' | 'root' | 'parent';
export interface ContextPart {
    messages: ContextMessage[];
    next?: string | undefined;
    body: Record<string, unknown>;
    status?: string;
}
/** 命令执行口（桥只用到 `run`）。 */
export interface Commands {
    run(command: string, args?: string[]): Promise<string>;
}
/** 引擎的部署信息（桥不读它的字段）。 */
export type Deployment = unknown;
/** 引擎的 KV 键。 */
export type Key<V> = string & {
    readonly __value?: V;
};
/** 同前缀的键族。 */
export type Family<V, A extends unknown[]> = ((...name: A) => Key<V>) & {
    readonly prefix: string;
};
/** 定义一个带类型的 KV 键（外部来源插件用这个自己声明键）。 */
export declare const record: <V>(key: string) => Key<V>;
/** 定义一个键族，键名以 `prefix` 开头。 */
export declare function family<V, A extends unknown[] = [string]>(prefix: string, format?: (...name: A) => string): Family<V, A>;
/** 稳定内容派生 id：同样的输入永远得到同样的 id（引擎 `core/ids.ts` 的 `key()`）。 */
export declare function stableKey(...values: string[]): string;
/** 引擎固定的英文健康文案（`{name}` 占位）；面板按界面语言翻译 `code`。 */
export declare const HEALTH_TEXT: {
    readonly setupPending: "Waiting for the deployment check";
    readonly sourceOff: "Off";
    readonly pollFailures: "{count} consecutive failed polls; last: {error}";
};
export type HealthCode = keyof typeof HEALTH_TEXT;
export type Health = {
    state: 'starting' | 'ready' | 'paused' | 'error';
    detail: string;
    at?: string;
    code?: HealthCode;
    values?: Record<string, string>;
};
/** 按引擎的固定文案生成一条健康状态。 */
export declare function health(state: Health['state'], code: HealthCode, values?: Record<string, string>): Health;
/** schema 校验失败。 */
export declare class SchemaError extends Error {
    constructor(message: string);
}
export type SafeParseResult<T> = {
    success: true;
    data: T;
} | {
    success: false;
    error: Error;
};
/** zod 的最小替身：引擎只需要这两个方法。 */
export interface SchemaLike<T> {
    parse(value: unknown): T;
    safeParse(value: unknown): SafeParseResult<T>;
}
/** 字符串字段。 */
export declare function str(opts?: {
    min?: number;
    max?: number;
    pattern?: RegExp;
    default?: string | (() => string);
}): SchemaLike<string>;
/** 数字字段。 */
export declare function num(opts?: {
    int?: boolean;
    min?: number;
    max?: number;
    default?: number | (() => number);
}): SchemaLike<number>;
/** 布尔字段。 */
export declare function bool(opts?: {
    default?: boolean | (() => boolean);
}): SchemaLike<boolean>;
/** 枚举字段。 */
export declare function enumOf<T extends string>(values: readonly T[], opts?: {
    default?: T | (() => T);
}): SchemaLike<T>;
/** 可选字段：缺省即 undefined，不报错。 */
export declare function opt<T>(schema: SchemaLike<T>): SchemaLike<T | undefined>;
/** 数组字段。 */
export declare function arr<T>(item: SchemaLike<T>, opts?: {
    default?: T[] | (() => T[]);
}): SchemaLike<T[]>;
export type Shape = Record<string, SchemaLike<unknown>>;
export type ShapeOut<S extends Shape> = {
    [K in keyof S]: S[K] extends SchemaLike<infer U> ? U : never;
};
/**
 * 对象字段。`strict`（默认）拒绝未知键；非 strict 时忽略未知键（策略部分用宽松模式，
 * 因为引擎会把整个 `policy.sources.<kind>` 段落连同别的键一起交给它校验）。
 */
export declare function obj<S extends Shape>(shape: S, opts?: {
    strict?: boolean;
}): SchemaLike<ShapeOut<S>>;
/** 在既有 schema 上加一条自定义校验（返回字符串即错误原因）。 */
export declare function refine<T>(schema: SchemaLike<T>, check: (value: T) => boolean | string): SchemaLike<T>;
/** 接收范围在策略里的行视图。 */
export interface AdmissionRowView {
    id: string;
    label: Localized | string;
    note: Localized;
    cells: {
        listedUnaddressed: boolean;
        unlistedAddressed: boolean;
        unlistedUnaddressed: boolean;
    };
}
/** 来源自己的策略段：允许的发送者、准入表行、可选的外部名册同步。 */
export interface SourcePolicyPart<P extends Record<string, unknown>> {
    schema: SchemaLike<P>;
    fields: FieldSpec[];
    explicit: Localized;
    unnamed?: {
        person: Localized;
        bot: Localized;
    };
    rows?(config: Record<string, unknown>): AdmissionRowView[];
}
/** 出站消息适配器。 */
export interface SourceChannel<C> {
    allowed?(address: Record<string, string>, config: C): boolean;
    /** 按消息 id 幂等发送；目标永远收不到时返回 `'gone'`。 */
    send(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'>;
    link(address: Record<string, string>, links: Record<string, unknown>): {
        url: string;
        label: Localized;
        triggerId?: string;
    };
}
/** 评估用的线程上下文读取器。 */
export interface ThreadContext<C> {
    messageId(trigger: Trigger): string;
    read(commands: Commands, trigger: Trigger, part: ContextPartName, cursor: string | undefined, config: C): Promise<ContextPart>;
}
/** 来源插件描述符。 */
export interface SourceKind<C extends Record<string, unknown> = Record<string, unknown>> {
    kind: string;
    title: Localized;
    description: Localized;
    facts?(deployment: Deployment): Record<string, Localized | string>;
    schema: SchemaLike<C>;
    fields: FieldSpec[];
    /** 本来源在 `health[...]` 下拥有的条目名。 */
    health: string[];
    scope?(input: {
        meta: Record<string, unknown>;
    }, config: C): ScopeResult;
    channel?: SourceChannel<C>;
    threadContext?: ThreadContext<C>;
    find?(query: string): {
        threads: string[];
        terms: string[];
    };
    repliesTo?(trigger: Trigger): string | undefined;
    policy?: SourcePolicyPart<Record<string, unknown> & {
        allowed: {
            id: string;
            name?: string;
        }[];
    }>;
    refreshLabels?(host: SourceHost, signal?: AbortSignal): Promise<Record<string, string>>;
    environment?: {
        variables: readonly VariableSpec[];
        values(input: {
            deployment: Deployment;
            config: C;
            trigger?: Trigger;
        }): Record<string, string>;
    };
}
/** 注册表（桥只用 `register`）。 */
export interface SourceRegistryLike {
    register<C extends Record<string, unknown>>(kind: SourceKind<C>): () => void;
}
/** 来源上下文：引擎暴露给来源插件的能力。 */
export interface SourceContext {
    readonly deployment: Deployment;
    readonly commands: Commands;
    readonly ready: Promise<void>;
    /** 部署检查是否已完成；未完成前来源不读数据。 */
    configured(): boolean;
    /** 某来源的配置；来源关闭时为 undefined。 */
    config<C extends Record<string, unknown>>(kind: string): C | undefined;
    /** 把触发器交给引擎；调用方应 await 完成后再推进读取游标。 */
    receive(trigger: Trigger): ReceiveResult | Promise<ReceiveResult>;
    atomic<T>(work: () => T): T;
    /** 来源私有的 KV 记录；写 undefined 即删除。 */
    state: {
        get<V>(key: Key<V>): V | undefined;
        set<V>(key: Key<V>, value: V | undefined): void;
        keys<V>(family: Family<V, never>): Key<V>[];
    };
    threads: {
        get(key: string): Thread | undefined;
        subscribed(source: string): Thread[];
        describe(key: string, description: ThreadDescription): void;
        patch(key: string, meta: Record<string, unknown>): void;
    };
    tickets: {
        get(id: string): Ticket | undefined;
        /** 未结束的工单，新的在前。 */
        open(): Ticket[];
        bindThread(id: string, thread: ThreadRef, own: boolean): void;
        threadClosed(thread: ThreadRef, outcome: 'merged' | 'closed', at: string): void;
    };
    triggers: {
        get(id: string): Trigger | undefined;
        latest(thread: string): Trigger | undefined;
    };
    notify(message: OutboundMessage): void;
    /** 报告本来源声明过的健康条目；未声明的名字会抛错。 */
    report(entry: string, health: Health): void;
}
/** 引擎暴露给来源插件的服务。 */
export interface SourceHost {
    readonly sources: SourceRegistryLike;
    /** 某个来源的上下文；它的 `report` 只会写该来源声明过的健康条目。 */
    context(kind: {
        kind: string;
        health: readonly string[];
    }): SourceContext;
}
export {};
