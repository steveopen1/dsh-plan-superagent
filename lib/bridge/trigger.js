/**
 * 板任务 → 引擎 Trigger 的翻译层。
 *
 * 三条硬规矩：
 * 1. **id 稳定且幂等**：同一个 task 反复读只会得到同一个 Trigger id，引擎的
 *    `Engine.receive` 对已存在的 id 返回 `duplicate`，因此重复读板不会建第二张单。
 * 2. **thread 稳定**：thread id = `<project>:<taskId>`（引擎的完整 thread key 形如
 *    `planboard:<project>:<taskId>`），同一任务的后续消息落在同一 thread 上。
 * 3. **text 是简报不是数据**：标题 + 验收 + 范围 + 子导图指针（相对路径 + 要点摘要），
 *    绝不把整个设计 JSON 塞进 text（那是给 worker 自己去读的路径）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { isAbsolutePath } from '../board/pathutil.js';
import { stableKey } from './contract.js';
/** 来源 kind id：同时是 Trigger.source、thread key 前缀与策略段名。 */
export const PLANBOARD_SOURCE = 'planboard';
/** 线程 id：`<project>:<taskId>`（引擎拼上来源前缀后是 `planboard:<project>:<taskId>`）。 */
export function planboardThreadId(project, taskId) {
    return `${project}:${taskId}`;
}
/**
 * Trigger id：sha256 前 32 位（与引擎 `core/ids.ts` 的 `key()` 同构）。
 * 带上 project 是为了多项目共存时互不撞车；同一 (project, task) 永远得到同一个 id。
 */
export function planboardTriggerId(project, taskId, attempt = 0) {
    return stableKey(PLANBOARD_SOURCE, project, taskId, 'attempt:' + attempt);
}
/** 子导图文件的位置：绝对路径给 worker 读，相对路径进简报。 */
export function designFilePaths(project, designsDir, taskId) {
    const dir = isAbsolutePath(designsDir) ? designsDir : join(project, designsDir);
    const absolute = join(dir, `${taskId}.json`);
    const rel = relative(project, absolute);
    return { absolute, relative: rel !== '' && !rel.startsWith('..') ? rel : absolute };
}
/** 导图里可能承载「要点」的字段名（设计 JSON 的格式未固定，故按常见键名兜底）。 */
const HEADING_KEYS = ['title', 'name', 'label', 'heading', 'summary', 'goal', 'step', 'task', 'decision', 'question'];
/**
 * 把任意形状的设计 JSON 压成「要点摘要」：按常见标题键收集短文本，限深限条。
 * 格式未固定（各人写的子导图结构可能不同），所以这里只做保守的字符串抽取，
 * 解析失败一律当作「没有摘要」，绝不抛错打断派单。
 */
export function summarizeDesign(raw, limit = 12) {
    const bullets = [];
    const seen = new Set();
    let title;
    const push = (text) => {
        const flat = text.replace(/\s+/g, ' ').trim();
        if (flat === '' || flat.length > 200 || seen.has(flat))
            return;
        seen.add(flat);
        bullets.push(flat);
    };
    const walk = (value, depth) => {
        if (bullets.length >= limit || depth > 5)
            return;
        if (typeof value === 'string') {
            push(value);
            return;
        }
        if (Array.isArray(value)) {
            for (const item of value)
                walk(item, depth + 1);
            return;
        }
        if (value == null || typeof value !== 'object')
            return;
        const record = value;
        for (const key of HEADING_KEYS) {
            const raw2 = record[key];
            if (typeof raw2 !== 'string')
                continue;
            if (title === undefined && key === 'title')
                title = raw2;
            push(raw2);
        }
        for (const [key, child] of Object.entries(record)) {
            if (HEADING_KEYS.includes(key))
                continue;
            walk(child, depth + 1);
        }
    };
    walk(raw, 0);
    return { ...title === undefined ? {} : { title }, bullets: bullets.slice(0, limit) };
}
/** 读取子导图；文件不存在或不是合法 JSON 时返回 undefined（不打断派单）。 */
export function readDesignSummary(absolutePath) {
    try {
        if (!existsSync(absolutePath))
            return undefined;
        const raw = JSON.parse(readFileSync(absolutePath, 'utf8'));
        const summary = summarizeDesign(raw);
        return summary.bullets.length === 0 && summary.title === undefined ? undefined : summary;
    }
    catch {
        return undefined;
    }
}
/** 任务简报正文：标题 + 验收 + 范围 + 子导图指针（不塞整个 JSON）。 */
export function planboardBrief(input) {
    const task = input.task;
    const lines = [];
    lines.push(`[计划板任务 ${task.id}] ${task.title}`);
    const head = [`板: ${input.planName ?? '(未命名计划)'} v${input.boardVersion}`];
    if (input.goal != null && input.goal !== '')
        head.push(`目标: ${input.goal}`);
    if (task.priority != null && task.priority !== 3)
        head.push(`优先级: P${task.priority}`);
    lines.push(head.join(' · '));
    const acceptance = task.acceptance ?? [];
    if (acceptance.length > 0) {
        lines.push('验收标准:');
        for (const item of acceptance)
            lines.push('- ' + item);
    }
    const scope = task.scope ?? [];
    if (scope.length > 0) {
        lines.push('改动范围:');
        for (const item of scope)
            lines.push('- ' + item);
    }
    if (task.note != null && task.note !== '')
        lines.push('备注: ' + task.note);
    lines.push(`功能实现导图: ${input.design.relative}`);
    if (input.summary === undefined) {
        lines.push('  (未找到子导图文件；按上面的验收标准与范围执行)');
    }
    else {
        if (input.summary.title != null)
            lines.push('  导图标题: ' + input.summary.title);
        for (const bullet of input.summary.bullets)
            lines.push('  - ' + bullet);
    }
    lines.push(`(导图绝对路径: ${input.design.absolute})`);
    return lines.join('\n');
}
/**
 * 板任务 → Trigger。
 *
 * - `actor` 用配置里的发起人 id；`human: true`（板上的条目是人的意图）；
 * - `addressed: 'direct'`：这条触发器就是直接派给智能体的活，不是旁听的群消息；
 * - `meta` 带上 taskId / project / 板版本号，以及子导图路径（worker 与桥都靠它对齐）。
 */
export function planboardTrigger(input) {
    const threadId = planboardThreadId(input.project, input.task.id);
    return {
        id: planboardTriggerId(input.project, input.task.id, input.attempt ?? 0),
        source: PLANBOARD_SOURCE,
        threads: [{ source: PLANBOARD_SOURCE, id: threadId }],
        actor: { source: PLANBOARD_SOURCE, id: input.actor },
        human: true,
        addressed: 'direct',
        at: input.at ?? new Date().toISOString(),
        text: planboardBrief(input),
        channel: {
            source: PLANBOARD_SOURCE,
            thread: `${PLANBOARD_SOURCE}:${threadId}`,
            address: { project: input.project, taskId: input.task.id },
        },
        meta: {
            taskId: input.task.id,
            project: input.project,
            boardVersion: input.boardVersion,
            designPath: input.design.relative,
            designAbs: input.design.absolute,
            thread: threadId,
            title: input.task.title,
            parent: input.task.parent ?? '',
            priority: input.task.priority ?? 3,
            attempt: input.attempt ?? 0,
        },
    };
}
//# sourceMappingURL=trigger.js.map