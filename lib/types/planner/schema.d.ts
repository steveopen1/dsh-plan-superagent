/**
 * 「一句话 → 任务树 + 每任务子导图」的数据契约（zod 真 schema，不是提示词里的口头约定）。
 *
 * 三层硬约束：plan（1 个）→ modules[] → tasks[]。modules 里只能有 task，task 里不许再出现子任务
 * —— 这条由 `.strict()` 兜底：模型多写一个 `subtasks` 字段，校验当场失败并进入重试，
 * 而不是被静默吞掉（research/mindmap.md 踩坑点 1/2/4：不要用 markdown 大纲解析任务树，
 * 也不要暴力切 JSON；模型 JSON 必须「真 schema 约束 + 校验 + 失败重试」）。
 *
 * id 规则：最终 id 由生成器统一产出（module `m-1..`、task `t-1..`，跨模块全局唯一）。
 * 模型只提供草稿用的 `key`（RawPlanSchema 会把模型误写的 `id` 归一成 `key`），
 * 最终 Plan 里的 id 一律由生成器分配，deps 只能引用已存在的 task id。
 */
import { z } from 'zod';
/** 规划器统一错误（带 code，便于工具层转成结构化 JSON）。 */
export declare class PlannerError extends Error {
    code: string;
    constructor(code: string, message: string);
}
/** 每个任务的「功能实现子导图」机器形态：够画图（结构化），也够执行（步骤/文件/风险/验证）。 */
export declare const TaskDesignSchema: z.ZodObject<{
    summary: z.ZodString;
    steps: z.ZodArray<z.ZodString, "many">;
    files: z.ZodArray<z.ZodString, "many">;
    risks: z.ZodArray<z.ZodString, "many">;
    tests: z.ZodArray<z.ZodString, "many">;
}, "strict", z.ZodTypeAny, {
    summary: string;
    steps: string[];
    files: string[];
    risks: string[];
    tests: string[];
}, {
    summary: string;
    steps: string[];
    files: string[];
    risks: string[];
    tests: string[];
}>;
export type TaskDesign = z.infer<typeof TaskDesignSchema>;
/** 推导导图的标记：出现在 summary 开头，表示这张不是模型写的（而是按验收标准与范围推导的）。 */
export declare const DERIVED_MARKER = "\uFF08\u81EA\u52A8\u63A8\u5BFC";
/** 最终计划里的 task：id 由生成器统一分配（`t-1..`），deps 只引用 task id。 */
export declare const PlanTaskSchema: z.ZodObject<{
    id: z.ZodString;
    title: z.ZodString;
    acceptance: z.ZodArray<z.ZodString, "many">;
    scope: z.ZodArray<z.ZodString, "many">;
    deps: z.ZodArray<z.ZodString, "many">;
    priority: z.ZodOptional<z.ZodNumber>;
    design: z.ZodObject<{
        summary: z.ZodString;
        steps: z.ZodArray<z.ZodString, "many">;
        files: z.ZodArray<z.ZodString, "many">;
        risks: z.ZodArray<z.ZodString, "many">;
        tests: z.ZodArray<z.ZodString, "many">;
    }, "strict", z.ZodTypeAny, {
        summary: string;
        steps: string[];
        files: string[];
        risks: string[];
        tests: string[];
    }, {
        summary: string;
        steps: string[];
        files: string[];
        risks: string[];
        tests: string[];
    }>;
}, "strict", z.ZodTypeAny, {
    design: {
        summary: string;
        steps: string[];
        files: string[];
        risks: string[];
        tests: string[];
    };
    id: string;
    scope: string[];
    title: string;
    acceptance: string[];
    deps: string[];
    priority?: number | undefined;
}, {
    design: {
        summary: string;
        steps: string[];
        files: string[];
        risks: string[];
        tests: string[];
    };
    id: string;
    scope: string[];
    title: string;
    acceptance: string[];
    deps: string[];
    priority?: number | undefined;
}>;
export type PlanTask = z.infer<typeof PlanTaskSchema>;
export declare const PlanModuleSchema: z.ZodObject<{
    id: z.ZodString;
    title: z.ZodString;
    tasks: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        title: z.ZodString;
        acceptance: z.ZodArray<z.ZodString, "many">;
        scope: z.ZodArray<z.ZodString, "many">;
        deps: z.ZodArray<z.ZodString, "many">;
        priority: z.ZodOptional<z.ZodNumber>;
        design: z.ZodObject<{
            summary: z.ZodString;
            steps: z.ZodArray<z.ZodString, "many">;
            files: z.ZodArray<z.ZodString, "many">;
            risks: z.ZodArray<z.ZodString, "many">;
            tests: z.ZodArray<z.ZodString, "many">;
        }, "strict", z.ZodTypeAny, {
            summary: string;
            steps: string[];
            files: string[];
            risks: string[];
            tests: string[];
        }, {
            summary: string;
            steps: string[];
            files: string[];
            risks: string[];
            tests: string[];
        }>;
    }, "strict", z.ZodTypeAny, {
        design: {
            summary: string;
            steps: string[];
            files: string[];
            risks: string[];
            tests: string[];
        };
        id: string;
        scope: string[];
        title: string;
        acceptance: string[];
        deps: string[];
        priority?: number | undefined;
    }, {
        design: {
            summary: string;
            steps: string[];
            files: string[];
            risks: string[];
            tests: string[];
        };
        id: string;
        scope: string[];
        title: string;
        acceptance: string[];
        deps: string[];
        priority?: number | undefined;
    }>, "many">;
}, "strict", z.ZodTypeAny, {
    id: string;
    title: string;
    tasks: {
        design: {
            summary: string;
            steps: string[];
            files: string[];
            risks: string[];
            tests: string[];
        };
        id: string;
        scope: string[];
        title: string;
        acceptance: string[];
        deps: string[];
        priority?: number | undefined;
    }[];
}, {
    id: string;
    title: string;
    tasks: {
        design: {
            summary: string;
            steps: string[];
            files: string[];
            risks: string[];
            tests: string[];
        };
        id: string;
        scope: string[];
        title: string;
        acceptance: string[];
        deps: string[];
        priority?: number | undefined;
    }[];
}>;
export type PlanModule = z.infer<typeof PlanModuleSchema>;
/** 最终计划形状：plan → modules[] → tasks[]，严格三层。 */
export declare const PlanSchema: z.ZodObject<{
    plan: z.ZodObject<{
        name: z.ZodString;
        goal: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        name: string;
        goal: string;
    }, {
        name: string;
        goal: string;
    }>;
    modules: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        title: z.ZodString;
        tasks: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            title: z.ZodString;
            acceptance: z.ZodArray<z.ZodString, "many">;
            scope: z.ZodArray<z.ZodString, "many">;
            deps: z.ZodArray<z.ZodString, "many">;
            priority: z.ZodOptional<z.ZodNumber>;
            design: z.ZodObject<{
                summary: z.ZodString;
                steps: z.ZodArray<z.ZodString, "many">;
                files: z.ZodArray<z.ZodString, "many">;
                risks: z.ZodArray<z.ZodString, "many">;
                tests: z.ZodArray<z.ZodString, "many">;
            }, "strict", z.ZodTypeAny, {
                summary: string;
                steps: string[];
                files: string[];
                risks: string[];
                tests: string[];
            }, {
                summary: string;
                steps: string[];
                files: string[];
                risks: string[];
                tests: string[];
            }>;
        }, "strict", z.ZodTypeAny, {
            design: {
                summary: string;
                steps: string[];
                files: string[];
                risks: string[];
                tests: string[];
            };
            id: string;
            scope: string[];
            title: string;
            acceptance: string[];
            deps: string[];
            priority?: number | undefined;
        }, {
            design: {
                summary: string;
                steps: string[];
                files: string[];
                risks: string[];
                tests: string[];
            };
            id: string;
            scope: string[];
            title: string;
            acceptance: string[];
            deps: string[];
            priority?: number | undefined;
        }>, "many">;
    }, "strict", z.ZodTypeAny, {
        id: string;
        title: string;
        tasks: {
            design: {
                summary: string;
                steps: string[];
                files: string[];
                risks: string[];
                tests: string[];
            };
            id: string;
            scope: string[];
            title: string;
            acceptance: string[];
            deps: string[];
            priority?: number | undefined;
        }[];
    }, {
        id: string;
        title: string;
        tasks: {
            design: {
                summary: string;
                steps: string[];
                files: string[];
                risks: string[];
                tests: string[];
            };
            id: string;
            scope: string[];
            title: string;
            acceptance: string[];
            deps: string[];
            priority?: number | undefined;
        }[];
    }>, "many">;
}, "strict", z.ZodTypeAny, {
    plan: {
        name: string;
        goal: string;
    };
    modules: {
        id: string;
        title: string;
        tasks: {
            design: {
                summary: string;
                steps: string[];
                files: string[];
                risks: string[];
                tests: string[];
            };
            id: string;
            scope: string[];
            title: string;
            acceptance: string[];
            deps: string[];
            priority?: number | undefined;
        }[];
    }[];
}, {
    plan: {
        name: string;
        goal: string;
    };
    modules: {
        id: string;
        title: string;
        tasks: {
            design: {
                summary: string;
                steps: string[];
                files: string[];
                risks: string[];
                tests: string[];
            };
            id: string;
            scope: string[];
            title: string;
            acceptance: string[];
            deps: string[];
            priority?: number | undefined;
        }[];
    }[];
}>;
export type Plan = z.infer<typeof PlanSchema>;
/**
 * 树阶段的中间形状：任务还没有 design（第二段再补）。
 *
 * 为什么单独一种形状：最终计划里每个 task 都必须带导图（PlanTaskSchema.design 必填），
 * 但树先落地、导图后补，中间态必须允许 design 缺省——否则第一段的产出根本过不了类型。
 */
export declare const TreeTaskSchema: z.ZodObject<{
    id: z.ZodString;
    title: z.ZodString;
    acceptance: z.ZodArray<z.ZodString, "many">;
    scope: z.ZodArray<z.ZodString, "many">;
    deps: z.ZodArray<z.ZodString, "many">;
    priority: z.ZodOptional<z.ZodNumber>;
    design: z.ZodOptional<z.ZodObject<{
        summary: z.ZodString;
        steps: z.ZodArray<z.ZodString, "many">;
        files: z.ZodArray<z.ZodString, "many">;
        risks: z.ZodArray<z.ZodString, "many">;
        tests: z.ZodArray<z.ZodString, "many">;
    }, "strict", z.ZodTypeAny, {
        summary: string;
        steps: string[];
        files: string[];
        risks: string[];
        tests: string[];
    }, {
        summary: string;
        steps: string[];
        files: string[];
        risks: string[];
        tests: string[];
    }>>;
}, "strict", z.ZodTypeAny, {
    id: string;
    scope: string[];
    title: string;
    acceptance: string[];
    deps: string[];
    design?: {
        summary: string;
        steps: string[];
        files: string[];
        risks: string[];
        tests: string[];
    } | undefined;
    priority?: number | undefined;
}, {
    id: string;
    scope: string[];
    title: string;
    acceptance: string[];
    deps: string[];
    design?: {
        summary: string;
        steps: string[];
        files: string[];
        risks: string[];
        tests: string[];
    } | undefined;
    priority?: number | undefined;
}>;
export declare const TreeModuleSchema: z.ZodObject<{
    id: z.ZodString;
    title: z.ZodString;
    tasks: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        title: z.ZodString;
        acceptance: z.ZodArray<z.ZodString, "many">;
        scope: z.ZodArray<z.ZodString, "many">;
        deps: z.ZodArray<z.ZodString, "many">;
        priority: z.ZodOptional<z.ZodNumber>;
        design: z.ZodOptional<z.ZodObject<{
            summary: z.ZodString;
            steps: z.ZodArray<z.ZodString, "many">;
            files: z.ZodArray<z.ZodString, "many">;
            risks: z.ZodArray<z.ZodString, "many">;
            tests: z.ZodArray<z.ZodString, "many">;
        }, "strict", z.ZodTypeAny, {
            summary: string;
            steps: string[];
            files: string[];
            risks: string[];
            tests: string[];
        }, {
            summary: string;
            steps: string[];
            files: string[];
            risks: string[];
            tests: string[];
        }>>;
    }, "strict", z.ZodTypeAny, {
        id: string;
        scope: string[];
        title: string;
        acceptance: string[];
        deps: string[];
        design?: {
            summary: string;
            steps: string[];
            files: string[];
            risks: string[];
            tests: string[];
        } | undefined;
        priority?: number | undefined;
    }, {
        id: string;
        scope: string[];
        title: string;
        acceptance: string[];
        deps: string[];
        design?: {
            summary: string;
            steps: string[];
            files: string[];
            risks: string[];
            tests: string[];
        } | undefined;
        priority?: number | undefined;
    }>, "many">;
}, "strict", z.ZodTypeAny, {
    id: string;
    title: string;
    tasks: {
        id: string;
        scope: string[];
        title: string;
        acceptance: string[];
        deps: string[];
        design?: {
            summary: string;
            steps: string[];
            files: string[];
            risks: string[];
            tests: string[];
        } | undefined;
        priority?: number | undefined;
    }[];
}, {
    id: string;
    title: string;
    tasks: {
        id: string;
        scope: string[];
        title: string;
        acceptance: string[];
        deps: string[];
        design?: {
            summary: string;
            steps: string[];
            files: string[];
            risks: string[];
            tests: string[];
        } | undefined;
        priority?: number | undefined;
    }[];
}>;
export declare const TreeSchema: z.ZodObject<{
    plan: z.ZodObject<{
        name: z.ZodString;
        goal: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        name: string;
        goal: string;
    }, {
        name: string;
        goal: string;
    }>;
    modules: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        title: z.ZodString;
        tasks: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            title: z.ZodString;
            acceptance: z.ZodArray<z.ZodString, "many">;
            scope: z.ZodArray<z.ZodString, "many">;
            deps: z.ZodArray<z.ZodString, "many">;
            priority: z.ZodOptional<z.ZodNumber>;
            design: z.ZodOptional<z.ZodObject<{
                summary: z.ZodString;
                steps: z.ZodArray<z.ZodString, "many">;
                files: z.ZodArray<z.ZodString, "many">;
                risks: z.ZodArray<z.ZodString, "many">;
                tests: z.ZodArray<z.ZodString, "many">;
            }, "strict", z.ZodTypeAny, {
                summary: string;
                steps: string[];
                files: string[];
                risks: string[];
                tests: string[];
            }, {
                summary: string;
                steps: string[];
                files: string[];
                risks: string[];
                tests: string[];
            }>>;
        }, "strict", z.ZodTypeAny, {
            id: string;
            scope: string[];
            title: string;
            acceptance: string[];
            deps: string[];
            design?: {
                summary: string;
                steps: string[];
                files: string[];
                risks: string[];
                tests: string[];
            } | undefined;
            priority?: number | undefined;
        }, {
            id: string;
            scope: string[];
            title: string;
            acceptance: string[];
            deps: string[];
            design?: {
                summary: string;
                steps: string[];
                files: string[];
                risks: string[];
                tests: string[];
            } | undefined;
            priority?: number | undefined;
        }>, "many">;
    }, "strict", z.ZodTypeAny, {
        id: string;
        title: string;
        tasks: {
            id: string;
            scope: string[];
            title: string;
            acceptance: string[];
            deps: string[];
            design?: {
                summary: string;
                steps: string[];
                files: string[];
                risks: string[];
                tests: string[];
            } | undefined;
            priority?: number | undefined;
        }[];
    }, {
        id: string;
        title: string;
        tasks: {
            id: string;
            scope: string[];
            title: string;
            acceptance: string[];
            deps: string[];
            design?: {
                summary: string;
                steps: string[];
                files: string[];
                risks: string[];
                tests: string[];
            } | undefined;
            priority?: number | undefined;
        }[];
    }>, "many">;
}, "strict", z.ZodTypeAny, {
    plan: {
        name: string;
        goal: string;
    };
    modules: {
        id: string;
        title: string;
        tasks: {
            id: string;
            scope: string[];
            title: string;
            acceptance: string[];
            deps: string[];
            design?: {
                summary: string;
                steps: string[];
                files: string[];
                risks: string[];
                tests: string[];
            } | undefined;
            priority?: number | undefined;
        }[];
    }[];
}, {
    plan: {
        name: string;
        goal: string;
    };
    modules: {
        id: string;
        title: string;
        tasks: {
            id: string;
            scope: string[];
            title: string;
            acceptance: string[];
            deps: string[];
            design?: {
                summary: string;
                steps: string[];
                files: string[];
                risks: string[];
                tests: string[];
            } | undefined;
            priority?: number | undefined;
        }[];
    }[];
}>;
export type TreePlan = z.infer<typeof TreeSchema>;
export type TreeTask = z.infer<typeof TreeTaskSchema>;
/** 草稿 key：模型侧用的临时编号（模块 m1/m2、任务 t1/t2…），全局唯一。 */
export declare const KEY_PATTERN: RegExp;
export declare const KeySchema: z.ZodString;
/** 模型侧 task（草稿 key 版）。 */
export declare const RawTaskSchema: z.ZodEffects<z.ZodObject<{
    key: z.ZodString;
    title: z.ZodString;
    acceptance: z.ZodArray<z.ZodString, "many">;
    scope: z.ZodArray<z.ZodString, "many">;
    deps: z.ZodArray<z.ZodString, "many">;
    priority: z.ZodOptional<z.ZodNumber>;
    design: z.ZodOptional<z.ZodObject<{
        summary: z.ZodString;
        steps: z.ZodArray<z.ZodString, "many">;
        files: z.ZodArray<z.ZodString, "many">;
        risks: z.ZodArray<z.ZodString, "many">;
        tests: z.ZodArray<z.ZodString, "many">;
    }, "strict", z.ZodTypeAny, {
        summary: string;
        steps: string[];
        files: string[];
        risks: string[];
        tests: string[];
    }, {
        summary: string;
        steps: string[];
        files: string[];
        risks: string[];
        tests: string[];
    }>>;
}, "strict", z.ZodTypeAny, {
    scope: string[];
    title: string;
    acceptance: string[];
    deps: string[];
    key: string;
    design?: {
        summary: string;
        steps: string[];
        files: string[];
        risks: string[];
        tests: string[];
    } | undefined;
    priority?: number | undefined;
}, {
    scope: string[];
    title: string;
    acceptance: string[];
    deps: string[];
    key: string;
    design?: {
        summary: string;
        steps: string[];
        files: string[];
        risks: string[];
        tests: string[];
    } | undefined;
    priority?: number | undefined;
}>, {
    scope: string[];
    title: string;
    acceptance: string[];
    deps: string[];
    key: string;
    design?: {
        summary: string;
        steps: string[];
        files: string[];
        risks: string[];
        tests: string[];
    } | undefined;
    priority?: number | undefined;
}, unknown>;
/** 模型侧 module（草稿 key 版）：里面只有 tasks，没有第四层。 */
export declare const RawModuleSchema: z.ZodEffects<z.ZodObject<{
    key: z.ZodString;
    title: z.ZodString;
    tasks: z.ZodArray<z.ZodEffects<z.ZodObject<{
        key: z.ZodString;
        title: z.ZodString;
        acceptance: z.ZodArray<z.ZodString, "many">;
        scope: z.ZodArray<z.ZodString, "many">;
        deps: z.ZodArray<z.ZodString, "many">;
        priority: z.ZodOptional<z.ZodNumber>;
        design: z.ZodOptional<z.ZodObject<{
            summary: z.ZodString;
            steps: z.ZodArray<z.ZodString, "many">;
            files: z.ZodArray<z.ZodString, "many">;
            risks: z.ZodArray<z.ZodString, "many">;
            tests: z.ZodArray<z.ZodString, "many">;
        }, "strict", z.ZodTypeAny, {
            summary: string;
            steps: string[];
            files: string[];
            risks: string[];
            tests: string[];
        }, {
            summary: string;
            steps: string[];
            files: string[];
            risks: string[];
            tests: string[];
        }>>;
    }, "strict", z.ZodTypeAny, {
        scope: string[];
        title: string;
        acceptance: string[];
        deps: string[];
        key: string;
        design?: {
            summary: string;
            steps: string[];
            files: string[];
            risks: string[];
            tests: string[];
        } | undefined;
        priority?: number | undefined;
    }, {
        scope: string[];
        title: string;
        acceptance: string[];
        deps: string[];
        key: string;
        design?: {
            summary: string;
            steps: string[];
            files: string[];
            risks: string[];
            tests: string[];
        } | undefined;
        priority?: number | undefined;
    }>, {
        scope: string[];
        title: string;
        acceptance: string[];
        deps: string[];
        key: string;
        design?: {
            summary: string;
            steps: string[];
            files: string[];
            risks: string[];
            tests: string[];
        } | undefined;
        priority?: number | undefined;
    }, unknown>, "many">;
}, "strict", z.ZodTypeAny, {
    title: string;
    tasks: {
        scope: string[];
        title: string;
        acceptance: string[];
        deps: string[];
        key: string;
        design?: {
            summary: string;
            steps: string[];
            files: string[];
            risks: string[];
            tests: string[];
        } | undefined;
        priority?: number | undefined;
    }[];
    key: string;
}, {
    title: string;
    tasks: unknown[];
    key: string;
}>, {
    title: string;
    tasks: {
        scope: string[];
        title: string;
        acceptance: string[];
        deps: string[];
        key: string;
        design?: {
            summary: string;
            steps: string[];
            files: string[];
            risks: string[];
            tests: string[];
        } | undefined;
        priority?: number | undefined;
    }[];
    key: string;
}, unknown>;
/** 模型侧整体形状：顶层只有 plan 与 modules。 */
export declare const RawPlanSchema: z.ZodObject<{
    plan: z.ZodObject<{
        name: z.ZodString;
        goal: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        name: string;
        goal: string;
    }, {
        name: string;
        goal: string;
    }>;
    modules: z.ZodArray<z.ZodEffects<z.ZodObject<{
        key: z.ZodString;
        title: z.ZodString;
        tasks: z.ZodArray<z.ZodEffects<z.ZodObject<{
            key: z.ZodString;
            title: z.ZodString;
            acceptance: z.ZodArray<z.ZodString, "many">;
            scope: z.ZodArray<z.ZodString, "many">;
            deps: z.ZodArray<z.ZodString, "many">;
            priority: z.ZodOptional<z.ZodNumber>;
            design: z.ZodOptional<z.ZodObject<{
                summary: z.ZodString;
                steps: z.ZodArray<z.ZodString, "many">;
                files: z.ZodArray<z.ZodString, "many">;
                risks: z.ZodArray<z.ZodString, "many">;
                tests: z.ZodArray<z.ZodString, "many">;
            }, "strict", z.ZodTypeAny, {
                summary: string;
                steps: string[];
                files: string[];
                risks: string[];
                tests: string[];
            }, {
                summary: string;
                steps: string[];
                files: string[];
                risks: string[];
                tests: string[];
            }>>;
        }, "strict", z.ZodTypeAny, {
            scope: string[];
            title: string;
            acceptance: string[];
            deps: string[];
            key: string;
            design?: {
                summary: string;
                steps: string[];
                files: string[];
                risks: string[];
                tests: string[];
            } | undefined;
            priority?: number | undefined;
        }, {
            scope: string[];
            title: string;
            acceptance: string[];
            deps: string[];
            key: string;
            design?: {
                summary: string;
                steps: string[];
                files: string[];
                risks: string[];
                tests: string[];
            } | undefined;
            priority?: number | undefined;
        }>, {
            scope: string[];
            title: string;
            acceptance: string[];
            deps: string[];
            key: string;
            design?: {
                summary: string;
                steps: string[];
                files: string[];
                risks: string[];
                tests: string[];
            } | undefined;
            priority?: number | undefined;
        }, unknown>, "many">;
    }, "strict", z.ZodTypeAny, {
        title: string;
        tasks: {
            scope: string[];
            title: string;
            acceptance: string[];
            deps: string[];
            key: string;
            design?: {
                summary: string;
                steps: string[];
                files: string[];
                risks: string[];
                tests: string[];
            } | undefined;
            priority?: number | undefined;
        }[];
        key: string;
    }, {
        title: string;
        tasks: unknown[];
        key: string;
    }>, {
        title: string;
        tasks: {
            scope: string[];
            title: string;
            acceptance: string[];
            deps: string[];
            key: string;
            design?: {
                summary: string;
                steps: string[];
                files: string[];
                risks: string[];
                tests: string[];
            } | undefined;
            priority?: number | undefined;
        }[];
        key: string;
    }, unknown>, "many">;
}, "strict", z.ZodTypeAny, {
    plan: {
        name: string;
        goal: string;
    };
    modules: {
        title: string;
        tasks: {
            scope: string[];
            title: string;
            acceptance: string[];
            deps: string[];
            key: string;
            design?: {
                summary: string;
                steps: string[];
                files: string[];
                risks: string[];
                tests: string[];
            } | undefined;
            priority?: number | undefined;
        }[];
        key: string;
    }[];
}, {
    plan: {
        name: string;
        goal: string;
    };
    modules: unknown[];
}>;
export type RawPlan = z.infer<typeof RawPlanSchema>;
export type RawModule = z.infer<typeof RawModuleSchema>;
export type RawTask = z.infer<typeof RawTaskSchema>;
/** 结构化错误（不依赖 zod 版本的具体类型，v3/v4 通用）。 */
export interface IssueLike {
    path: ReadonlyArray<PropertyKey>;
    message: string;
    code?: string;
}
/** 把 zod 报错压成给模型看的具名清单（重试时原样回灌）。 */
export declare function formatIssues(err: {
    issues: ReadonlyArray<IssueLike>;
}): string[];
