/**
 * 计划板模式：按会话记住「开发类需求是否先走计划板」。
 *
 * 开关在原生对话框旁（客户端），状态放在服务端：会话重建、插件重启都不丢。
 * 切换时把一条指令注入那个会话，agent 由此知道「先把需求变成板上的计划树，人批准后再动手」——
 * 这样输入面只有一个（原生对话框），计划板只是计划的落地面。
 */
import type { Context } from '@deepseek-ai/cordis'
import { MessageId, freezeMessage, type ContextFormed } from '@deepseek-ai/dsh-llm'

// The host's message sources are merge-extensible: every producer declares its own kind.
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-plan-superagent': { kind: 'dsh-plan-superagent' } & ContextFormed
  }
}

/** The host's session id type, kept structural so this package needs no session package. */
type SessionId = string
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 计划板模式：'plan' = 开发类需求先走计划板；'direct' = 按常规处理。 */
export type PlanMode = 'plan' | 'direct'

export interface ModeRecord {
  mode: PlanMode
  at: string
}

/** 模式状态：按会话 id 记在板的注册表目录旁（重启不丢）。 */
export class ModeStore {
  constructor(private readonly dir: string) {}
  private file(): string {
    return join(this.dir, 'modes.json')
  }
  all(): Record<string, ModeRecord> {
    try {
      if (!existsSync(this.file())) return {}
      return JSON.parse(readFileSync(this.file(), 'utf8')) as Record<string, ModeRecord>
    } catch {
      return {}
    }
  }
  get(sessionId: string): ModeRecord | undefined {
    return this.all()[sessionId]
  }
  set(sessionId: string, mode: PlanMode): ModeRecord {
    const all = this.all()
    const record: ModeRecord = { mode, at: new Date().toISOString() }
    all[sessionId] = record
    try {
      mkdirSync(this.dir, { recursive: true })
      writeFileSync(this.file(), JSON.stringify(all, null, 2))
    } catch { /* 状态存不下去不算故障：这一轮仍然生效 */ }
    return record
  }
}

/** 切换模式时注入会话的指令。 */
export function modeDirective(mode: PlanMode, project: string): string {
  const where = project === '' ? '（尚未选择项目）' : project
  if (mode === 'plan') {
    return [
      '【计划板模式 · 已开启】',
      '本会话的开发类需求一律先走计划板，不要直接开始改代码。',
      '请调用 plan_generate：把你理解的需求变成「计划 → 模块 → 任务」三层结构，每个任务带一份功能实现子导图（步骤/涉及文件/风险/测试），并连同验收标准与改动范围一起提交待批。',
      '人批准后，再按板上就绪的任务逐个动手。',
      '当前板所在项目：' + where,
    ].join('\n')
  }
  return [
    '【计划板模式 · 已关闭】',
    '按常规方式处理需求：可以直接分析并改代码。需要先做规划时，仍可调用 plan_generate 生成计划树。',
  ].join('\n')
}

/**
 * 把模式指令注入会话。
 *
 * 用 inject（进历史、不唤醒 agent）：下一轮它就在上下文里；若 agent 正在跑，这一轮不会被打断。
 */
export async function announceMode(ctx: Context, sessionId: string, mode: PlanMode, project: string): Promise<boolean> {
  const controller = (ctx as unknown as {
    sessionController?: {
      resolveAgent(id: SessionId): Promise<{ agent: { inject(message: unknown): void } } | { error: unknown }>
    }
  }).sessionController
  if (controller == null) return false
  const resolved = await controller.resolveAgent(sessionId as SessionId)
  if ('error' in resolved) return false
  const id = MessageId('dsh-plan-superagent:mode:' + sessionId + ':' + mode + ':' + Date.now())
  const message = freezeMessage({
    id,
    role: 'user' as const,
    content: [{ type: 'text' as const, text: modeDirective(mode, project) }],
    source: { kind: 'dsh-plan-superagent' as const, form: 'notice' as const, summary: '计划板模式' },
  })
  resolved.agent.inject(message)
  return true
}
