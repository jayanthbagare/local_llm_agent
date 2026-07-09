// ── SDK: Unified Public API ──
// One import to get the full local LLM agent experience.
// Composes llm-engine, nano-agent, skill-store, and tool-bridge.
import { SimulatedEngine, WebGPUEngine, TransformersEngine } from '@local-llm-agent/llm-engine';
import { NanoAgent } from '@local-llm-agent/nano-agent';
import { SkillStore } from '@local-llm-agent/skill-store';
import { ToolBridge, createToolBridge } from '@local-llm-agent/tool-bridge';
/**
 * Create a complete agent with one call.
 *
 * @example
 * ```ts
 * const agent = await createAgent({
 *   model: 'phi-3-mini-4k',
 *   skills: ['calculator'],
 *   simulated: true, // for testing without WebGPU
 * });
 *
 * for await (const event of agent.run('What is 42 * 2?')) {
 *   if (event.type === 'thinking') console.log('🤔', event.content);
 *   if (event.type === 'tool_call') console.log('🔧', event.tool);
 *   if (event.type === 'done') console.log('✅', event.response);
 * }
 * ```
 */
export async function createAgent(options = {}) {
    // 1. Create or use engine
    let engine;
    if (options.engine) {
        engine = options.engine;
    }
    else if (options.simulated) {
        engine = new SimulatedEngine();
    }
    else {
        // Real in-browser inference via transformers.js (WebGPU, WASM fallback).
        // Fall back to the simulated engine only when no browser runtime exists.
        if (typeof navigator !== 'undefined') {
            engine = new TransformersEngine();
        }
        else {
            engine = new SimulatedEngine();
        }
    }
    // 2. Load model
    if (!engine.isLoaded() && (options.model || options.loadOptions)) {
        await engine.load({
            modelId: options.model || 'phi-3-mini-4k',
            ...options.loadOptions,
        });
    }
    else if (!engine.isLoaded() && !options.engine) {
        // Load simulated by default if no model specified
        await engine.load({ modelId: 'simulated' });
    }
    // 3. Create skill store
    const skillStore = new SkillStore(options.skillStoreOptions);
    // 4. Create tool bridge
    const toolBridge = createToolBridge();
    // 5. Create agent
    const nanoAgentConfig = {
        engine,
        toolBridge,
        systemPrompt: options.systemPrompt,
        maxSteps: options.maxSteps,
        temperature: options.temperature,
        topP: options.topP,
        maxTokens: options.maxTokens,
    };
    const agent = new NanoAgent(nanoAgentConfig);
    // 6. Register custom skills
    if (options.customSkills) {
        agent.registerSkills(options.customSkills);
        for (const skill of options.customSkills) {
            skillStore.registerBuiltin(skill);
        }
    }
    // 7. Register built-in skills from store
    if (options.skills) {
        for (const skillId of options.skills) {
            const skill = skillStore.getBuiltin(skillId);
            if (skill) {
                agent.registerSkill(skill);
            }
            else {
                // Try to fetch from remote
                try {
                    const fetched = await skillStore.fetch(skillId);
                    agent.registerSkill(fetched);
                }
                catch {
                    console.warn(`Skill "${skillId}" not found locally or remotely`);
                }
            }
        }
    }
    // 8. Return unified interface
    return {
        run: (input) => agent.run(input),
        registerSkill: (skill) => agent.registerSkill(skill),
        registerSkills: (skills) => agent.registerSkills(skills),
        fetchSkill: (id) => skillStore.fetch(id),
        getSkills: () => agent.getSkills(),
        getEngine: () => engine,
        abort: () => agent.abort(),
        clearHistory: () => agent.clearHistory(),
        destroy: async () => {
            agent.abort();
            await engine.unload();
        },
    };
}
/** The unified SDK default export */
const SDK = {
    createAgent,
    SimulatedEngine,
    WebGPUEngine,
    TransformersEngine,
    NanoAgent,
    SkillStore,
    ToolBridge,
    createToolBridge,
};
export default SDK;
//# sourceMappingURL=index.js.map