// ── React Bindings ──
// React hooks and provider for the Local LLM Agent SDK.

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useMemo,
  type ReactNode,
} from 'react';

// We import types from the SDK package
import type {
  Agent,
  CreateAgentOptions,
  AgentEvent,
  SkillDefinition,
  Message,
} from '@local-llm-agent/sdk';
import { createAgent } from '@local-llm-agent/sdk';

// ── Context ──

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

const AgentContext = createContext<AgentContextValue | null>(null);

// ── Provider ──

export interface AgentProviderProps extends CreateAgentOptions {
  children: ReactNode;
  /** Auto-initialize on mount */
  autoInit?: boolean;
}

export function AgentProvider({ children, autoInit = true, ...options }: AgentProviderProps) {
  const [agent, setAgent] = useState<Agent | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [skills, setSkills] = useState<SkillDefinition[]>([]);
  // Initialize agent
  useEffect(() => {
    if (!autoInit) return;

    let cancelled = false;

    (async () => {
      try {
        const a = await createAgent(options);
        if (cancelled) {
          await a.destroy();
          return;
        }
        setAgent(a);
        setIsReady(true);
        setSkills(a.getSkills());
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();

    return () => {
      cancelled = true;
      agent?.destroy();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const run = useCallback(async (input: string) => {
    if (!agent) {
      setError('Agent not initialized');
      return;
    }

    setIsRunning(true);
    setError(null);
    const newEvents: AgentEvent[] = [];

    try {
      for await (const event of agent.run(input)) {
        newEvents.push(event);
        setEvents([...newEvents]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsRunning(false);
    }
  }, [agent]);

  const abort = useCallback(() => {
    agent?.abort();
    setIsRunning(false);
  }, [agent]);

  const registerSkill = useCallback((skill: SkillDefinition) => {
    agent?.registerSkill(skill);
    setSkills(agent?.getSkills() || []);
  }, [agent]);

  const clearHistory = useCallback(() => {
    agent?.clearHistory();
    setEvents([]);
  }, [agent]);

  const value = useMemo<AgentContextValue>(() => ({
    agent,
    isReady,
    isRunning,
    error,
    events,
    messages: agent ? [] : [],
    skills,
    run,
    abort,
    registerSkill,
    clearHistory,
  }), [agent, isReady, isRunning, error, events, skills, run, abort, registerSkill, clearHistory]);

  return React.createElement(AgentContext.Provider, { value }, children);
}

// ── Hook ──

export function useAgent(): AgentContextValue {
  const ctx = useContext(AgentContext);
  if (!ctx) {
    throw new Error('useAgent must be used within an <AgentProvider>');
  }
  return ctx;
}

// ── Optional hook variants ──

/** Hook that returns only the latest response */
export function useAgentResponse(): { response: string | null; isRunning: boolean } {
  const { events, isRunning } = useAgent();
  let doneEvent: AgentEvent | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'done') {
      doneEvent = events[i];
      break;
    }
  }
  return {
    response: doneEvent?.type === 'done' ? doneEvent.response : null,
    isRunning,
  };
}

/** Hook that streams tokens from thinking events */
export function useAgentThinking(): string {
  const { events } = useAgent();
  return events
    .filter((e) => e.type === 'thinking')
    .map((e) => e.content)
    .join('\n');
}

/** Hook for tool call tracking */
export function useAgentTools(): Array<{ tool: string; args: Record<string, unknown>; result?: unknown }> {
  const { events } = useAgent();
  const calls: Array<{ tool: string; args: Record<string, unknown>; result?: unknown }> = [];
  let pendingCall: { tool: string; args: Record<string, unknown> } | null = null;

  for (const event of events) {
    if (event.type === 'tool_call') {
      pendingCall = { tool: event.tool, args: event.args };
    } else if (event.type === 'tool_result' && pendingCall?.tool === event.tool) {
      calls.push({ ...pendingCall, result: event.result });
      pendingCall = null;
    }
  }

  return calls;
}
