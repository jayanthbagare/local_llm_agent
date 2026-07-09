import React, { type ReactNode } from 'react';
import type { Agent, CreateAgentOptions, AgentEvent, SkillDefinition, Message } from '@local-llm-agent/sdk';
interface AgentContextValue {
    agent: Agent | null;
    isReady: boolean;
    isRunning: boolean;
    error: string | null;
    events: AgentEvent[];
    messages: Message[];
    skills: SkillDefinition[];
    run: (input: string) => Promise<void>;
    abort: () => void;
    registerSkill: (skill: SkillDefinition) => void;
    clearHistory: () => void;
}
export interface AgentProviderProps extends CreateAgentOptions {
    children: ReactNode;
    /** Auto-initialize on mount */
    autoInit?: boolean;
}
export declare function AgentProvider({ children, autoInit, ...options }: AgentProviderProps): React.FunctionComponentElement<React.ProviderProps<AgentContextValue | null>>;
export declare function useAgent(): AgentContextValue;
/** Hook that returns only the latest response */
export declare function useAgentResponse(): {
    response: string | null;
    isRunning: boolean;
};
/** Hook that streams tokens from thinking events */
export declare function useAgentThinking(): string;
/** Hook for tool call tracking */
export declare function useAgentTools(): Array<{
    tool: string;
    args: Record<string, unknown>;
    result?: unknown;
}>;
export {};
//# sourceMappingURL=index.d.ts.map