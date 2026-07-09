import type { LLMEngine, Message } from '@local-llm-agent/llm-engine';
import type { SkillDefinition } from '@local-llm-agent/skill-store';
import type { ToolBridge, ToolResult } from '@local-llm-agent/tool-bridge';
/** Events emitted during agent execution */
export type AgentEvent = {
    type: 'thinking';
    content: string;
} | {
    type: 'tool_call';
    tool: string;
    args: Record<string, unknown>;
} | {
    type: 'tool_result';
    tool: string;
    result: ToolResult;
} | {
    type: 'token';
    token: string;
} | {
    type: 'done';
    response: string;
    steps: number;
} | {
    type: 'error';
    error: string;
};
/** Configuration for the NanoAgent */
export interface NanoAgentConfig {
    engine: LLMEngine;
    toolBridge: ToolBridge;
    /** Maximum agent steps (tool call + response cycles) */
    maxSteps?: number;
    /** System prompt prepended to every conversation */
    systemPrompt?: string;
    /** LLM generation options */
    temperature?: number;
    topP?: number;
    maxTokens?: number;
    /** Max context tokens before summarization */
    maxContextTokens?: number;
}
export declare class NanoAgent {
    private engine;
    private toolBridge;
    private config;
    private messages;
    private skills;
    private _aborted;
    constructor(config: NanoAgentConfig);
    /** Register a skill for the agent to use */
    registerSkill(skill: SkillDefinition): void;
    /** Register multiple skills */
    registerSkills(skills: SkillDefinition[]): void;
    /** Get registered skills */
    getSkills(): SkillDefinition[];
    /** Get the current conversation messages */
    getMessages(): Message[];
    /** Set conversation messages (e.g., restore from history) */
    setMessages(messages: Message[]): void;
    /** Clear conversation history */
    clearHistory(): void;
    /** Run the agent on user input */
    run(input: string): AsyncIterable<AgentEvent>;
    /** Abort the current agent run */
    abort(): void;
    private _buildSystemPrompt;
    private _buildToolDefinitions;
    private _skillParamsToOpenAI;
    private _executeTool;
    private _formatToolResult;
    private _trimContext;
}
/** Create a NanoAgent with default configuration */
export declare function createNanoAgent(config: NanoAgentConfig): NanoAgent;
//# sourceMappingURL=agent.d.ts.map