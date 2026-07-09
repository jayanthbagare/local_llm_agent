// ── LLM Engine ──
// Public API exports

export type {
  Message, MessageRole,
  LoadOptions, LoadProgress,
  GenerateOptions, GenerateResult,
  Token, ToolCall, ToolDefinition,
  ModelInfo, LLMEngine,
} from './types';

export { countTokens, countMessageTokens, applyChatTemplate, CHAT_TEMPLATES } from './tokenizer';
export { WebGPUEngine, createWebGPUEngine, type OnnxModelConfig } from './engine';
export { SimulatedEngine, createSimulatedEngine } from './simulated';
export {
  TransformersEngine,
  createTransformersEngine,
  setTransformersSpecifier,
  TRANSFORMERS_SPECIFIER,
} from './transformers';

/** Factory: auto-detects WebGPU availability and returns appropriate engine */
export async function createEngine(options?: { prefer?: 'transformers' | 'webgpu' | 'wasm' | 'simulated' }): Promise<import('./types').LLMEngine> {
  if (options?.prefer === 'simulated') {
    const { createSimulatedEngine } = await import('./simulated');
    return createSimulatedEngine();
  }

  // Real in-browser inference via transformers.js (WebGPU or WASM).
  const hasBrowser = typeof navigator !== 'undefined';
  if (hasBrowser && (options?.prefer === 'transformers' || options?.prefer === undefined || options?.prefer === 'webgpu' || options?.prefer === 'wasm')) {
    const { createTransformersEngine } = await import('./transformers');
    return createTransformersEngine();
  }

  // Fall back to simulated for Node.js / non-browser environments.
  const { createSimulatedEngine } = await import('./simulated');
  return createSimulatedEngine();
}
