// ── LLM Engine ──
// Public API exports
export { countTokens, countMessageTokens, applyChatTemplate, CHAT_TEMPLATES } from './tokenizer';
export { WebGPUEngine, createWebGPUEngine } from './engine';
export { SimulatedEngine, createSimulatedEngine } from './simulated';
/** Factory: auto-detects WebGPU availability and returns appropriate engine */
export async function createEngine(options) {
    if (options?.prefer === 'simulated') {
        const { createSimulatedEngine } = await import('./simulated');
        return createSimulatedEngine();
    }
    // In browser: try WebGPU
    if (typeof navigator !== 'undefined' && 'gpu' in navigator) {
        try {
            const adapter = await navigator.gpu.requestAdapter();
            if (adapter && options?.prefer !== 'wasm') {
                const { createWebGPUEngine } = await import('./engine');
                return createWebGPUEngine();
            }
        }
        catch { /* fall through */ }
    }
    // Fall back to simulated for Node.js / missing WebGPU
    const { createSimulatedEngine } = await import('./simulated');
    return createSimulatedEngine();
}
//# sourceMappingURL=index.js.map