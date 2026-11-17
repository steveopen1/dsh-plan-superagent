/**
 * L4 git 交叉核对：任务 doing 期间新增 commit 触及的文件 vs 任务声明 scope。
 * scope 条目 = 路径前缀（目录以 / 结尾）；git 缺失/失败返回 null = 无法核对（不误报，记 skip）。
 */
import { execFileSync } from 'node:child_process'

export function changedFilesSince(projectDir: string, sinceIso: string): string[] | null {
  try {
    const out = execFileSync('git', ['-C', projectDir, 'log', '--since=' + sinceIso, '--name-only', '--pretty=format:'], {
      encoding: 'utf8', timeout: 10_000,
    })
    return Array.from(new Set(out.split('\n').map(s => s.trim()).filter(Boolean)))
  } catch {
    return null
  }
}

export function scopeHit(files: string[], scope: string[]): string {
  for (const f of files) {
    // git 恒以 '/' 输出仓库相对路径；scope 条目在 Windows 上可能被写成 '\'，统一归一为 '/' 再比对。
    const fn = f.replace(/\\/g, '/')
    for (const s of scope) {
      const sn = s.replace(/\\/g, '/')
      const p = sn.replace(/\*+$/, '')
      if (sn.endsWith('/') ? fn.startsWith(sn) : (fn === sn || (p !== '' && fn.startsWith(p)))) return f
    }
  }
  return ''
}
