/**
 * 平台感知的绝对路径判定。
 * Windows 认盘符根（`C:\x`、`C:/x`）与根相对（`\x`）；POSIX 只认 `/` 开头。
 */
export declare function isAbsolutePath(p: string): boolean;
/**
 * 归一路径分隔符为平台分隔符。
 * 用户手输的 scope 条目可能斜杠/反斜杠混用（`src\a` 与 `src/a` 同义）。
 * POSIX 上反斜杠是合法文件名字符，故只在 Windows 上做替换。
 */
export declare function normalizeSeparators(p: string): string;
