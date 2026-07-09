import type { LLMEngine, LoadOptions, GenerateOptions, GenerateResult, Token, ModelInfo } from './types';
/** Configuration for ONNX LLM models */
export interface OnnxModelConfig {
    modelUrl: string;
    chatTemplate?: string;
    contextLength: number;
    /** Input name in the ONNX model (default: 'input_ids') */
    inputName?: string;
    /** Output name (default: 'logits') */
    outputName?: string;
    /** KV cache input/output names for auto-regressive generation */
    kvCache?: {
        pastKeyNames: string[];
        pastValueNames: string[];
        presentKeyNames: string[];
        presentValueNames: string[];
    };
}
export declare class WebGPUEngine implements LLMEngine {
    private session;
    private config;
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
    private _checkWebGPU;
    private _resolveModelUrl;
    private _getModelConfig;
    private _loadTokenizer;
    private _buildPrompt;
    private _countPrompt;
    private _encodeInput;
    private _parseToolCalls;
}
export declare function createWebGPUEngine(): LLMEngine;
//# sourceMappingURL=engine.d.ts.map