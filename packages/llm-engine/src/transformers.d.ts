import type { LLMEngine, LoadOptions, GenerateOptions, GenerateResult, Token, ModelInfo } from './types';
/**
 * The module specifier used to import transformers.js. Overridable so the
 * static demo page (which loads it from a CDN via an import map) and a bundled
 * app can both resolve it.
 */
export declare let TRANSFORMERS_SPECIFIER: string;
/** Override where transformers.js is imported from (e.g. a CDN URL). */
export declare function setTransformersSpecifier(specifier: string): void;
export declare class TransformersEngine implements LLMEngine {
    private generator;
    private _info;
    private _device;
    private _aborted;
    private _contextLength;
    load(options: LoadOptions): Promise<void>;
    isLoaded(): boolean;
    getModelInfo(): ModelInfo | null;
    generate(options: GenerateOptions): Promise<GenerateResult>;
    generateStream(options: GenerateOptions): AsyncIterable<Token>;
    countTokens(text: string): number;
    unload(): Promise<void>;
    abort(): void;
    private _resolveDevice;
    private _toChatMessages;
    private _countPrompt;
    private _parseToolCalls;
}
export declare function createTransformersEngine(): LLMEngine;
//# sourceMappingURL=transformers.d.ts.map