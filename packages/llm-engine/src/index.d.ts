export type { Message, MessageRole, LoadOptions, LoadProgress, GenerateOptions, GenerateResult, Token, ToolCall, ToolDefinition, ModelInfo, LLMEngine, } from './types';
export { countTokens, countMessageTokens, applyChatTemplate, CHAT_TEMPLATES } from './tokenizer';
export { WebGPUEngine, createWebGPUEngine, type OnnxModelConfig } from './engine';
export { SimulatedEngine, createSimulatedEngine } from './simulated';
/** Factory: auto-detects WebGPU availability and returns appropriate engine */
export declare function createEngine(options?: {
    prefer?: 'webgpu' | 'wasm' | 'simulated';
}): Promise<import('./types').LLMEngine>;
//# sourceMappingURL=index.d.ts.map