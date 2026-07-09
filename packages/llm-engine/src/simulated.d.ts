import type { LLMEngine, LoadOptions, GenerateOptions, GenerateResult, Token, ModelInfo } from './types';
export declare class SimulatedEngine implements LLMEngine {
    private _loaded;
    private _info;
    private _aborted;
    private _device;
    load(options: LoadOptions): Promise<void>;
    isLoaded(): boolean;
    getModelInfo(): ModelInfo | null;
    generate(options: GenerateOptions): Promise<GenerateResult>;
    generateStream(options: GenerateOptions): AsyncIterable<Token>;
    countTokens(text: string): number;
    unload(): Promise<void>;
    abort(): void;
    private _simulateProgress;
    private _generate;
    private _respond;
    private _tryToolCall;
    private _parseToolCalls;
    private _getLastUserMessage;
    private _countPromptTokens;
}
export declare function createSimulatedEngine(): LLMEngine;
//# sourceMappingURL=simulated.d.ts.map