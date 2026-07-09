import { SimulatedEngine, WebGPUEngine } from '@local-llm-agent/llm-engine';
import { NanoAgent } from '@local-llm-agent/nano-agent';
import { SkillStore } from '@local-llm-agent/skill-store';
import { ToolBridge, createToolBridge } from '@local-llm-agent/tool-bridge';
import type { LLMEngine, LoadOptions } from '@local-llm-agent/llm-engine';
import type { AgentEvent } from '@local-llm-agent/nano-agent';
import type { SkillDefinition } from '@local-llm-agent/skill-store';
/** Options for creating a complete agent with createAgent() */
export interface CreateAgentOptions {
    /** Model ID to load (e.g., 'phi-3-mini-4k') */
    model?: string;
    /** Model load options */
    loadOptions?: Partial<LoadOptions>;
    /** Use simulated engine (no WebGPU required) */
    simulated?: boolean;
    /** Custom engine instance */
    engine?: LLMEngine;
    /** System prompt */
    systemPrompt?: string;
    /** Maximum agent steps per query */
    maxSteps?: number;
    /** Temperature for generation */
    temperature?: number;
    /** Top-P for generation */
    topP?: number;
    /** Max tokens per generation */
    maxTokens?: number;
    /** Skill IDs to enable (loads from bundled skills) */
    skills?: string[];
    /** Custom skill definitions */
    customSkills?: SkillDefinition[];
    /** Skill store options */
    skillStoreOptions?: {
        registryUrl?: string;
        allowRemote?: boolean;
        cacheTTL?: number;
    };
}
/** The complete agent instance returned by createAgent */
export interface Agent {
    /** Run the agent with a user query */
    run(input: string): AsyncIterable<AgentEvent>;
    /** Register a new skill at runtime */
    registerSkill(skill: SkillDefinition): void;
    /** Register multiple skills */
    registerSkills(skills: SkillDefinition[]): void;
    /** Fetch a skill from remote registry */
    fetchSkill(id: string): Promise<SkillDefinition>;
    /** Get all registered skills */
    getSkills(): SkillDefinition[];
    /** Get engine info */
    getEngine(): LLMEngine;
    /** Abort current execution */
    abort(): void;
    /** Clear conversation history */
    clearHistory(): void;
    /** Unload the model and free resources */
    destroy(): Promise<void>;
}
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
export declare function createAgent(options?: CreateAgentOptions): Promise<Agent>;
/** The unified SDK default export */
declare const SDK: {
    createAgent: typeof createAgent;
    SimulatedEngine: typeof SimulatedEngine;
    WebGPUEngine: typeof WebGPUEngine;
    TransformersEngine: any;
    NanoAgent: typeof NanoAgent;
    SkillStore: typeof SkillStore;
    ToolBridge: typeof ToolBridge;
    createToolBridge: typeof createToolBridge;
};
export default SDK;
export type { LLMEngine, LoadOptions, Message, GenerateOptions, GenerateResult, Token, ToolCall, ToolDefinition, ModelInfo, } from '@local-llm-agent/llm-engine';
export type { NanoAgentConfig, AgentEvent, } from '@local-llm-agent/nano-agent';
export type { SkillDefinition, SkillTool, SkillTrigger, SkillParameter, } from '@local-llm-agent/skill-store';
export type { ToolResult, TransportHandler, } from '@local-llm-agent/tool-bridge';
//# sourceMappingURL=index.d.ts.map