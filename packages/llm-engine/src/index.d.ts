export type { Message, MessageRole, LoadOptions, LoadProgress, GenerateOptions, GenerateResult, Token, ToolCall, ToolDefinition, ModelInfo, LLMEngine, } from './types';
export { countTokens, countMessageTokens, applyChatTemplate, CHAT_TEMPLATES } from './tokenizer';
export { WebGPUEngine, createWebGPUEngine, type OnnxModelConfig } from './engine';
export { SimulatedEngine, createSimulatedEngine } from './simulated';
export { TransformersEngine, createTransformersEngine, setTransformersSpecifier, TRANSFORMERS_SPECIFIER, } from './transformers';
/** Factory: auto-detects WebGPU availability and returns appropriate engine */
export declare function createEngine(options?: {
    prefer?: 'transformers' | 'webgpu' | 'wasm' | 'simulated';
}): Promise<import('./types').LLMEngine>;
//# sourceMappingURL=index.d.ts.map