import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "dsh-plan-board";
export interface Config {
    stateDir: string;
    blockOnDrift: boolean;
    observeTools: boolean;
    enforceScope: boolean;
}
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    stateDir: z<string, string, "defined">;
    blockOnDrift: z<boolean, boolean, "defined">;
    observeTools: z<boolean, boolean, "defined">;
    enforceScope: z<boolean, boolean, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    stateDir: z<string, string, "defined">;
    blockOnDrift: z<boolean, boolean, "defined">;
    observeTools: z<boolean, boolean, "defined">;
    enforceScope: z<boolean, boolean, "defined">;
}>>, "plain">;
type HostCtx = Context & {
    webServer?: {
        register(route: {
            kind: 'exact' | 'prefix';
            path: string;
            handler: (req: unknown, res: unknown) => void | Promise<void>;
        }): () => void;
        port?: number;
    };
    tools?: {
        register(tool: unknown): void;
    };
    logger?: {
        info(msg: string): void;
        warn(msg: string): void;
        error(msg: string): void;
    };
};
export declare function apply(ctx: HostCtx, config?: Partial<Config>, deps?: {
    plan?: import('./routes.js').PlanHook;
    mode?: import('./routes.js').ModeDeps;
    isPlanMode?: (agentId: string | undefined) => boolean;
    designDir?: string;
}): () => void;
export {};
