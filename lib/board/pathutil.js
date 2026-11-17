/**
 * 跨平台路径语义（Windows / POSIX 同构）。
 *
 * 上游原实现用 startsWith('/') 判「绝对路径」，那是 POSIX 专属判定：Windows 上
 * `C:\Users\me\project` 不以 '/' 开头，于是每一个项目路径都被判成 BAD_PROJECT，
 * 插件在 Windows 上完全不可用（面板填不进路径、5 个工具全部拒收 project 参数）。
 * 这里统一改走 node:path 的平台感知判定，并给 scope 前缀匹配提供分隔符归一。
 */
import { isAbsolute, sep } from 'node:path';
/**
 * 平台感知的绝对路径判定。
 * Windows 认盘符根（`C:\x`、`C:/x`）与根相对（`\x`）；POSIX 只认 `/` 开头。
 */
export function isAbsolutePath(p) {
    return isAbsolute(p);
}
/**
 * 归一路径分隔符为平台分隔符。
 * 用户手输的 scope 条目可能斜杠/反斜杠混用（`src\a` 与 `src/a` 同义）。
 * POSIX 上反斜杠是合法文件名字符，故只在 Windows 上做替换。
 */
export function normalizeSeparators(p) {
    return sep === '/' ? p : p.replace(/\//g, '\\');
}
//# sourceMappingURL=pathutil.js.map