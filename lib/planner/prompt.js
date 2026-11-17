/**
 * 中文结构化提示词：一句话 + 可选仓库上下文 → 严格符合 schema 的 JSON。
 *
 * 关键纪律（research/mindmap.md 踩坑点 3/6）：
 * - 层级写死三层（plan → modules → tasks），并明确「task 里不许再有子任务」；
 * - 明确「不要输出 Markdown 代码围栏」（模型的 ```json 包裹会让严格 JSON.parse 直接失败）；
 * - key 只做草稿编号（最终 m-1/t-1 由生成器统一分配），deps 只引用任务 key；
 * - 给出结构示例，降低首轮不合规率（不合规就靠重试循环兜底）。
 */
/** 系统提示词：只输出 JSON。 */
/**
 * 系统提示词：只输出 JSON。
 *
 * 这一轮**只出树**（plan → modules → tasks）：子导图由后面逐任务的独立调用补。
 * 一次输出整棵树加全部子导图会把模型的流打断（实测 Anthropic 兼容流半路断）。
 */
export const PLAN_SYSTEM_PROMPT = [
    '你是一个资深技术规划器。你把用户的一句话需求拆成「计划 → 模块 → 任务」三层结构。',
    '这一轮只要任务树：每个任务给出标题、可判定的验收标准、允许改动的范围、依赖与优先级；不要写 design 字段。',
    '硬规则：只输出一个 JSON 对象；不要输出 Markdown 代码围栏（不要 ```json）；',
    '不要在 JSON 前后写任何解释、寒暄或思考过程；所有字符串用双引号，不要出现裸换行。',
].join('\n');
/** 结构示例（字段名一字不差，模型照抄这个骨架就不会跑偏）。 */
const SHAPE_EXAMPLE = `{
  "plan": { "name": "计划名", "goal": "一句话说清要达成什么" },
  "modules": [
    {
      "key": "m1",
      "title": "模块标题",
      "tasks": [
        {
          "key": "t1",
          "title": "任务标题",
          "acceptance": ["可判定的验收标准"],
          "scope": ["src/xxx.ts"],
          "deps": [],
          "priority": 3,
          "design": {
            "summary": "一两句话讲清怎么实现",
            "steps": ["第一步", "第二步"],
            "files": ["src/xxx.ts"],
            "risks": ["可能的风险与对策"],
            "tests": ["怎么验证它真的做完了"]
          }
        }
      ]
    }
  ]
}`;
/** 只出树、不出子导图时的结构示例。 */
const SHAPE_EXAMPLE_TREE = `{
  "plan": { "name": "计划名", "goal": "一句话说清要达成什么" },
  "modules": [
    {
      "key": "m1",
      "title": "模块标题",
      "tasks": [
        {
          "key": "t1",
          "title": "任务标题",
          "acceptance": ["可判定的验收标准"],
          "scope": ["src/xxx.ts"],
          "deps": [],
          "priority": 3
        }
      ]
    }
  ]
}`;
/** 组装 user 提示词。 */
export function buildUserPrompt(input) {
    const withDesigns = input.includeDesigns !== false;
    const lines = [];
    lines.push('【用户的一句话需求】');
    lines.push(String(input.sentence ?? '').trim());
    lines.push('');
    lines.push('【目标仓库上下文（可选，只用来对齐路径与命名，不要照抄成任务）】');
    const ctx = String(input.context ?? '').trim();
    lines.push(ctx === '' ? '（无）' : ctx);
    lines.push('');
    lines.push('【输出结构：严格三层，一个字段都不许多一个】');
    lines.push('顶层只有两个字段：plan、modules。');
    lines.push('层级固定：plan（1 个）→ modules（2~4 个）→ tasks（每个 module 1~4 个）。');
    lines.push('modules 里每个元素是「模块」，模块里只有 tasks；task 里不允许再出现子任务（不要 subtasks / children / items 这类字段）。');
    lines.push('不要为了凑数加第四层。');
    lines.push('');
    lines.push('【字段含义】');
    lines.push('- plan.name：计划名，短，10 个字以内。');
    lines.push('- plan.goal：计划目标，一句话说清要达成什么。');
    lines.push('- module.key：模块的草稿唯一编号；module.title：这组任务要解决什么。');
    lines.push('- task.key：任务的草稿唯一编号（在整个 JSON 内唯一，不能和模块 key 重复）。');
    lines.push('- task.title：任务标题，动宾短语，20 个字以内。');
    lines.push('- task.acceptance：验收标准数组，至少 1 条，每条都是可判定、可验证的完成条件（能写成测试或人工检查步骤）。禁止写「完成开发」这种废话。');
    lines.push('- task.scope：本任务允许改动的文件或目录范围（相对仓库根的路径），没有就写空数组。');
    lines.push('- task.deps：依赖的任务 key 数组。只能填「任务 key」，不能填模块 key，不能填不存在的 key，不能填自己，不能形成环；允许跨模块依赖；没有依赖写空数组。');
    lines.push('- task.priority：1~5 的整数，1 最急、5 最不急；可省略。');
    if (withDesigns) {
        lines.push('- task.design：这个任务的「功能实现子导图」，字段固定五个：');
        lines.push('  · summary：一两句话讲清怎么实现；');
        lines.push('  · steps：有序的实现步骤，1~6 条；');
        lines.push('  · files：预计要新建或修改的文件（相对仓库根），1~6 条，尽量具体；');
        lines.push('  · risks：风险与对策，0~4 条，没有就写空数组；');
        lines.push('  · tests：怎么验证它真的做完了，1~4 条（测试命令 / 验收动作）。');
    }
    else {
        lines.push('- 这一轮**不要**输出 design 字段：子导图会由后续的单独一次调用逐个生成。');
    }
    lines.push('');
    lines.push('【id 规则】');
    lines.push('你写的 key 只是草稿编号（建议 m1/m2、t1/t2/t3…），最终编号由系统统一重排为 m-1、m-2、t-1、t-2…；');
    lines.push('你只负责两件事：key 全局唯一、deps 只引用任务 key。');
    lines.push('');
    lines.push('【输出示例（结构示意，字段名一字不差）】');
    lines.push(withDesigns ? SHAPE_EXAMPLE : SHAPE_EXAMPLE_TREE);
    lines.push('');
    lines.push('【硬性要求】');
    lines.push('1. 只输出一个 JSON 对象；不要 Markdown 代码围栏；不要任何前后说明文字。');
    lines.push('2. 数组里的每一项都必须是非空字符串；不要出现空字符串、注释、尾逗号。');
    lines.push('3. 字符串里不要出现未转义的换行或双引号。');
    const feedback = String(input.feedback ?? '').trim();
    if (feedback !== '') {
        lines.push('');
        lines.push('【上一次输出的问题（这次必须改掉）】');
        lines.push(feedback);
    }
    return lines.join('\n');
}
/** 为单个任务写子导图时的系统提示词。 */
export const DESIGN_SYSTEM_PROMPT = [
    '你是一个资深技术规划师，负责为**一个**任务写「功能实现子导图」。',
    '硬规则：只输出一个 JSON 对象；不要输出 Markdown 代码围栏（不要 ```json）；',
    '不要在 JSON 前后写任何解释、寒暄或思考过程。',
].join('\n');
/** 单个任务的子导图提示词：只要五个字段的 JSON。 */
export function buildDesignPrompt(input) {
    const lines = [];
    lines.push('【计划目标】');
    lines.push(String(input.goal ?? '').trim());
    lines.push('');
    lines.push('【这个任务】');
    lines.push('标题：' + String(input.title ?? '').trim());
    lines.push('验收标准：');
    for (const a of input.acceptance)
        lines.push('  - ' + a);
    lines.push('允许改动的范围：');
    if (input.scope.length === 0)
        lines.push('  （未限定）');
    for (const s of input.scope)
        lines.push('  - ' + s);
    lines.push('');
    lines.push('【目标仓库上下文（可选，只用来对齐路径与命名）】');
    const ctx = String(input.context ?? '').trim();
    lines.push(ctx === '' ? '（无）' : ctx);
    lines.push('');
    lines.push('【输出：一个 JSON 对象，字段固定五个，不许多一个】');
    lines.push('{"summary":"一两句话讲清怎么实现","steps":["第一步","第二步"],"files":["src/xxx.ts"],"risks":["可能的风险与对策"],"tests":["怎么验证它真的做完了"]}');
    lines.push('steps 1~6 条；files 1~6 条（相对仓库根，尽量具体）；risks 0~4 条（没有就写空数组）；tests 1~4 条。');
    lines.push('');
    lines.push('只输出这个 JSON 对象，不要任何前后说明文字。');
    const feedback = String(input.feedback ?? '').trim();
    if (feedback !== '') {
        lines.push('');
        lines.push('【上一次输出的问题（这次必须改掉）】');
        lines.push(feedback);
    }
    return lines.join('\n');
}
//# sourceMappingURL=prompt.js.map