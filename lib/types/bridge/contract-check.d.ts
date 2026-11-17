/** 引擎契约里的一节：必填成员与可选成员。 */
export interface ContractSection {
    required: readonly string[];
    optional?: readonly string[];
}
/** 引擎侧契约的形状：`dsh-superagent/contract` 导出的 `SOURCE_CONTRACT`。 */
export interface EngineContract {
    version: number;
    kind: ContractSection;
    context: ContractSection;
    trigger: ContractSection;
    ticket: ContractSection;
    channel: ContractSection;
    policy: ContractSection;
    threadContext: ContractSection;
    host: ContractSection;
    health: {
        states: readonly string[];
        fields: readonly string[];
        codes: readonly string[];
    };
}
/** 一处对不上。 */
export interface ContractMismatch {
    area: string;
    detail: string;
}
/**
 * 拿桥的副本和引擎的契约逐项比对，返回全部不一致（空数组 = 一致）。
 *
 * 比的不是「字段名完全一样」，而是**桥真正依赖的那部分**：
 * 桥只抄了工单的一部分字段、也没实现引擎所有的可选成员，所以「桥比引擎少」是正常的；
 * 不正常的是「桥依赖的字段引擎没有了」和「引擎要求的字段桥没有」。
 */
export declare function compareBridgeToEngine(engine: EngineContract): ContractMismatch[];
/** 引擎契约的来源。 */
export interface LoadedEngineContract {
    source: string;
    contract: EngineContract;
}
/**
 * 找到引擎的契约并读进来。
 *
 * 来源顺序：环境变量 `DSH_SUPERAGENT_CONTRACT_MODULE`（指向一个模块文件）→ 已安装的依赖
 * `dsh-superagent/contract` → 同机的引擎仓（`<包根>/../dsh-superagent-win/lib/contract.js`，开发时用）。
 *
 * 三条都找不到就**报错**，不静默跳过：一个永远跑不到的比对，等于没有比对。
 *
 * @param root 包根目录，默认当前工作目录（自测在包根运行）。
 */
export declare function loadEngineContract(root?: string): Promise<LoadedEngineContract>;
