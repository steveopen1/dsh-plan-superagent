import { isIP } from 'node:net';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BoardError, topoOrder } from './schema.js';
import { PlanStore } from './store.js';
import { isAbsolutePath } from './pathutil.js';
export const ROUTE_PREFIX = '/_dsh/dsh-plan-board';
const MAX_JSON_BODY_BYTES = 64 * 1024;
export class BoardRegistry {
    stateDir;
    opts;
    subscribers = new Set();
    /** L7 拦截器（index.ts 装配后挂入；路由层负责挂起开关与状态展示）。 */
    guard = null;
    /** PlanStore 广播入口：事件 → 所有 /stream 订阅者。 */
    onEvent = (project, ev) => {
        this.broadcast({ kind: 'event', project, event: ev });
    };
    broadcast(msg) {
        for (const s of this.subscribers) {
            try {
                s(msg);
            }
            catch { /* 单订阅者失败不拖垮其他 */ }
        }
    }
    constructor(stateDir, opts) {
        this.stateDir = stateDir;
        this.opts = opts;
        mkdirSync(stateDir, { recursive: true });
    }
    projects() {
        const f = join(this.stateDir, 'projects.json');
        if (!existsSync(f))
            return {};
        try {
            return JSON.parse(readFileSync(f, 'utf8'));
        }
        catch {
            return {};
        }
    }
    remember(project, name) {
        const all = this.projects();
        const cur = all[project];
        if (cur != null && cur.name === name)
            return; // 幂等：/state 轮询不重复写盘
        all[project] = { name, at: new Date().toISOString() };
        writeFileSync(join(this.stateDir, 'projects.json'), JSON.stringify(all, null, 2));
    }
    /** L7 观测面：非本插件工具调用全量留痕（tool-calls.jsonl，仅名称+agent，不落参数）。 */
    observeToolCall(toolName, agent) {
        try {
            const rec = { ts: new Date().toISOString(), tool: toolName, agent };
            appendFileSync(join(this.stateDir, 'tool-calls.jsonl'), JSON.stringify(rec) + '\n');
        }
        catch { /* fail-soft */ }
    }
}
function isLoopbackPeer(remote) {
    if (remote == null || remote === '')
        return false;
    if (remote === '::1')
        return true;
    const m = /^::ffff:(\d+)\.(\d+)\.(\d+)\.(\d+)$/i.exec(remote);
    if (m != null)
        return Number(m[1]) === 127;
    if (isIP(remote) === 4)
        return remote.startsWith('127.');
    return false;
}
function sameOriginHost(req) {
    const origin = req.headers.origin;
    if (origin == null)
        return true;
    const host = req.headers.host;
    if (typeof origin !== 'string' || typeof host !== 'string' || host.trim() === '')
        return false;
    try {
        return new URL(origin).host.trim().toLowerCase() === host.trim().toLowerCase();
    }
    catch {
        return false;
    }
}
function sendJson(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
}
function sendErr(res, status, code, message) {
    sendJson(res, status, { ok: false, error: { code, message } });
}
function readJsonBody(req) {
    return new Promise((resolve) => {
        const chunks = [];
        let size = 0;
        let aborted = false;
        req.on('data', (d) => {
            if (aborted)
                return;
            size += d.length;
            if (size > MAX_JSON_BODY_BYTES) {
                aborted = true;
                req.pause();
                resolve(null);
                return;
            }
            chunks.push(d);
        });
        req.on('end', () => {
            if (aborted)
                return;
            try {
                const text = Buffer.concat(chunks).toString('utf8');
                const parsed = text.trim() === '' ? {} : JSON.parse(text);
                if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed))
                    resolve(null);
                else
                    resolve(parsed);
            }
            catch {
                resolve(null);
            }
        });
        req.on('error', () => resolve(null));
    });
}
function stationOf(b) {
    const doing = b.nodes.filter(n => n.type === 'task' && n.status === 'doing');
    return doing.length > 0 ? doing[doing.length - 1].id : null;
}
/** What an op touches, so an edited proposal can be checked against the original one. */
function opTarget(op) {
    if (op == null || typeof op !== 'object')
        return '';
    const o = op;
    if (o.op === 'add_node')
        return 'add:' + String(o.node?.id ?? '');
    if (o.op === 'init_board')
        return 'init';
    return String(o.op ?? '') + ':' + String(o.id ?? '');
}
/**
 * Check the ops a person edited before they are applied.
 *
 * The panel may change a proposal's content or drop a row, but not invent work the agent never
 * proposed: every submitted op has to match a proposed one, and unknown op kinds are refused.
 * The board's own lint stays the second line of defence.
 */
function validateEditedOps(proposed, edited) {
    const kinds = new Set(proposed.map(op => String(op.op ?? '')));
    for (const op of edited) {
        const kind = String(op.op ?? '');
        if (!kinds.has(kind))
            return '提案里没有这种操作: ' + kind;
    }
    const targets = new Set(proposed.map(opTarget));
    for (const op of edited) {
        if (!targets.has(opTarget(op)))
            return '提案里没有这一项: ' + opTarget(op);
    }
    return undefined;
}
export function mountRoutes(webServer, registry, plan, mode) {
    const unregister = webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
            try {
                if (!isLoopbackPeer(req.socket.remoteAddress)) {
                    sendErr(res, 403, 'FORBIDDEN', '仅限本机访问');
                    return;
                }
                const u = new URL(req.url ?? '/', 'http://localhost');
                const sub = u.pathname.slice(ROUTE_PREFIX.length) || '/';
                if (req.method === 'GET') {
                    if (sub === '/stream') {
                        const project = u.searchParams.get('project') ?? '';
                        if (!isAbsolutePath(project)) {
                            sendErr(res, 400, 'BAD_PROJECT', 'project 必须是绝对路径');
                            return;
                        }
                        res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
                        const send = (obj) => { try {
                            res.write(JSON.stringify(obj) + '\n');
                        }
                        catch { /* 连接已断 */ } };
                        send({ kind: 'hello', project, at: new Date().toISOString() });
                        const subFn = (msg) => { send(msg); };
                        registry.subscribers.add(subFn);
                        const hb = setInterval(() => send({ kind: 'ping', at: new Date().toISOString() }), 15000);
                        res.on('close', () => { clearInterval(hb); registry.subscribers.delete(subFn); });
                        return;
                    }
                    if (sub === '/state') {
                        const project = u.searchParams.get('project') ?? '';
                        if (!isAbsolutePath(project)) {
                            sendErr(res, 400, 'BAD_PROJECT', 'project 必须是绝对路径');
                            return;
                        }
                        const store = PlanStore.open(project, registry.opts, registry.onEvent);
                        registry.remember(project, store.board.plan.name);
                        const order = {};
                        for (const [k, v] of topoOrder(store.board))
                            order[k] = v;
                        sendJson(res, 200, {
                            ok: true, project, board: store.board, order,
                            station: stationOf(store.board), events: store.eventsTail(60),
                            guard: registry.guard?.state() ?? { suspended: false, enforceScope: false },
                        });
                        return;
                    }
                    if (sub === '/projects') {
                        sendJson(res, 200, { ok: true, projects: registry.projects() });
                        return;
                    }
                    if (sub === '/mode') {
                        const sessionId = u.searchParams.get('sessionId') ?? '';
                        if (sessionId === '') {
                            sendErr(res, 400, 'NO_SESSION', 'sessionId 不能为空');
                            return;
                        }
                        if (mode == null) {
                            sendErr(res, 501, 'NO_MODE', '计划板模式未装配');
                            return;
                        }
                        const record = mode.store.get(sessionId);
                        sendJson(res, 200, { ok: true, sessionId, mode: record?.mode ?? 'direct', at: record?.at });
                        return;
                    }
                    sendErr(res, 404, 'NOT_FOUND', '未知路径 ' + sub);
                    return;
                }
                if (req.method === 'POST') {
                    if (!sameOriginHost(req)) {
                        sendErr(res, 403, 'SAME_ORIGIN', '跨站请求被拒绝');
                        return;
                    }
                    const body = await readJsonBody(req);
                    if (body == null) {
                        sendErr(res, 400, 'BAD_JSON', 'JSON 体缺失或非法（上限 64KB）');
                        return;
                    }
                    // The mode belongs to a Session, not to a project: answer it before the project check.
                    if (sub === '/mode') {
                        const sessionId = String(body.sessionId ?? '');
                        const wanted = String(body.mode ?? '');
                        if (sessionId === '') {
                            sendErr(res, 400, 'NO_SESSION', 'sessionId 不能为空');
                            return;
                        }
                        if (wanted !== 'plan' && wanted !== 'direct') {
                            sendErr(res, 400, 'BAD_MODE', 'mode 必须是 plan|direct');
                            return;
                        }
                        if (mode == null) {
                            sendErr(res, 501, 'NO_MODE', '计划板模式未装配');
                            return;
                        }
                        const record = mode.store.set(sessionId, wanted);
                        // Tell the Session: the agent reads this as its working instruction for the next turn.
                        const latest = Object.entries(registry.projects()).sort((a, b) => (b[1].at ?? '').localeCompare(a[1].at ?? ''))[0];
                        const announced = await mode.announce(sessionId, wanted, latest?.[0] ?? '');
                        sendJson(res, 200, { ok: true, sessionId, mode: record.mode, at: record.at, announced });
                        return;
                    }
                    const project = String(body.project ?? '');
                    if (!isAbsolutePath(project)) {
                        sendErr(res, 400, 'BAD_PROJECT', 'project 必须是绝对路径');
                        return;
                    }
                    const store = PlanStore.open(project, registry.opts, registry.onEvent);
                    if (sub === '/approve') {
                        const approvalId = String(body.approvalId ?? '');
                        const decision = String(body.decision ?? '');
                        const ap = store.board.pendingApprovals.find(x => x.id === approvalId);
                        if (ap == null) {
                            sendErr(res, 404, 'NO_APPROVAL', '待批项不存在: ' + approvalId);
                            return;
                        }
                        if (decision === 'approve') {
                            // The person may have edited the proposal in the panel; their ops win over the proposed ones.
                            let ops = ap.ops;
                            if (Array.isArray(body.ops)) {
                                const edited = body.ops;
                                const problem = validateEditedOps(ap.ops, edited);
                                if (problem != null) {
                                    sendErr(res, 400, 'BAD_EDITED_OPS', problem);
                                    return;
                                }
                                ops = edited;
                            }
                            const now = new Date().toISOString();
                            store.mutate('human:panel', 'plan_edit_approved', { approvalId, ops }, (b) => {
                                store.applyEditOps(ops, now);
                                b.pendingApprovals = b.pendingApprovals.filter(x => x.id !== approvalId);
                            });
                            sendJson(res, 200, { ok: true, decision, approvalId });
                            return;
                        }
                        if (decision === 'reject') {
                            store.mutate('human:panel', 'plan_edit_rejected', { approvalId, reason: String(body.reason ?? '') }, (b) => {
                                b.pendingApprovals = b.pendingApprovals.filter(x => x.id !== approvalId);
                            });
                            sendJson(res, 200, { ok: true, decision, approvalId });
                            return;
                        }
                        sendErr(res, 400, 'BAD_DECISION', 'decision 必须是 approve|reject');
                        return;
                    }
                    if (sub === '/unblock') {
                        if (store.board.driftBlock == null) {
                            sendJson(res, 200, { ok: true, unblocked: false });
                            return;
                        }
                        store.mutate('human:panel', 'drift_unblocked', { cleared: store.board.driftBlock }, (b) => { b.driftBlock = null; });
                        sendJson(res, 200, { ok: true, unblocked: true });
                        return;
                    }
                    if (sub === '/guard') {
                        if (registry.guard == null) {
                            sendErr(res, 501, 'NO_GUARD', '拦截器未装配');
                            return;
                        }
                        const suspended = body.suspended;
                        if (typeof suspended !== 'boolean') {
                            sendErr(res, 400, 'BAD_SUSPENDED', 'suspended 必须是布尔');
                            return;
                        }
                        registry.guard.setSuspended(suspended);
                        // 人类挂起/恢复动作落板留痕（板不存在时跳过事件，不失败）
                        try {
                            const store2 = PlanStore.open(project, registry.opts, registry.onEvent);
                            store2.addEvent(suspended ? 'guard_suspend' : 'guard_resume', 'human:panel', { by: 'panel' });
                        }
                        catch { /* 无板项目只切全局态 */ }
                        sendJson(res, 200, { ok: true, suspended: registry.guard.isSuspended() });
                        return;
                    }
                    if (sub === '/plan') {
                        if (plan == null) {
                            sendErr(res, 501, 'NO_PLANNER', '规划器未装配');
                            return;
                        }
                        const sentence = String(body.sentence ?? '').trim();
                        if (sentence === '') {
                            sendErr(res, 400, 'EMPTY_SENTENCE', '请先写一句需求');
                            return;
                        }
                        try {
                            const result = await plan({ project, sentence });
                            sendJson(res, 200, result);
                        }
                        catch (e) {
                            // The planner reports its own problem (no model, invalid output); the panel shows it.
                            sendJson(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
                        }
                        return;
                    }
                    if (sub === '/remember') {
                        // Register the project the panel is looking at, so the bridge can follow it even
                        // before the project has a board (the registry is otherwise written only on /state).
                        const name = String(body.name ?? '');
                        registry.remember(project, name !== '' ? name : project);
                        sendJson(res, 200, { ok: true, project, projects: registry.projects() });
                        return;
                    }
                    if (sub === '/edit') {
                        const ops = body.ops;
                        if (!Array.isArray(ops)) {
                            sendErr(res, 400, 'BAD_OPS', 'ops 必须是数组');
                            return;
                        }
                        const now = new Date().toISOString();
                        const changed = store.mutate('human:panel', 'human_edit', { ops, note: body.note ?? null }, (b) => {
                            store.applyEditOps(ops, now);
                        });
                        sendJson(res, 200, { ok: true, version: changed.version, changed: changed.nodes.length });
                        return;
                    }
                    sendErr(res, 404, 'NOT_FOUND', '未知路径 ' + sub);
                    return;
                }
                sendErr(res, 405, 'METHOD', '仅支持 GET/POST');
            }
            catch (e) {
                if (e instanceof BoardError)
                    sendErr(res, e.code === 'PLAN_NOT_FOUND' ? 404 : 400, e.code, e.message);
                else
                    sendErr(res, 500, 'INTERNAL', e instanceof Error ? e.message : String(e));
            }
        },
    });
    return unregister;
}
//# sourceMappingURL=routes.js.map