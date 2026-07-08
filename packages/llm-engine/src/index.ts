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

/** Factory: auto-detects WebGPU availability and returns appropriate engine */
export async function createEngine(options?: { prefer?: 'webgpu' | 'wasm' | 'simulated' }): Promise<import('./types').LLMEngine> {
  if (options?.prefer === 'simulated') {
    const { createSimulatedEngine } = await import('./simulated');
    return createSimulatedEngine();
  }

  // In browser: try WebGPU
  if (typeof navigator !== 'undefined' && 'gpu' in navigator) {
    try {
      const adapter = await (navigator as any).gpu.requestAdapter();
      if (adapter && options?.prefer !== 'wasm') {
        const { createWebGPUEngine } = await import('./engine');
        return createWebGPUEngine();
      }
    } catch { /* fall through */ }
  }

  // Fall back to simulated for Node.js / missing WebGPU
  const { createSimulatedEngine } = await import('./simulated');
  return createSimulatedEngine();
}
