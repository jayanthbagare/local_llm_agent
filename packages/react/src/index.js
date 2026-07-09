// ── React Bindings ──
// React hooks and provider for the Local LLM Agent SDK.
import React, { createContext, useContext, useState, useCallback, useEffect, useMemo, } from 'react';
import { createAgent } from '@local-llm-agent/sdk';
const AgentContext = createContext(null);
export function AgentProvider({ children, autoInit = true, ...options }) {
    const [agent, setAgent] = useState(null);
    const [isReady, setIsReady] = useState(false);
    const [isRunning, setIsRunning] = useState(false);
    const [error, setError] = useState(null);
    const [events, setEvents] = useState([]);
    const [skills, setSkills] = useState([]);
    // Initialize agent
    useEffect(() => {
        if (!autoInit)
            return;
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
            }
            catch (err) {
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
    const run = useCallback(async (input) => {
        if (!agent) {
            setError('Agent not initialized');
            return;
        }
        setIsRunning(true);
        setError(null);
        const newEvents = [];
        try {
            for await (const event of agent.run(input)) {
                newEvents.push(event);
                setEvents([...newEvents]);
            }
        }
        catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
        finally {
            setIsRunning(false);
        }
    }, [agent]);
    const abort = useCallback(() => {
        agent?.abort();
        setIsRunning(false);
    }, [agent]);
    const registerSkill = useCallback((skill) => {
        agent?.registerSkill(skill);
        setSkills(agent?.getSkills() || []);
    }, [agent]);
    const clearHistory = useCallback(() => {
        agent?.clearHistory();
        setEvents([]);
    }, [agent]);
    const value = useMemo(() => ({
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
export function useAgent() {
    const ctx = useContext(AgentContext);
    if (!ctx) {
        throw new Error('useAgent must be used within an <AgentProvider>');
    }
    return ctx;
}
// ── Optional hook variants ──
/** Hook that returns only the latest response */
export function useAgentResponse() {
    const { events, isRunning } = useAgent();
    let doneEvent;
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
export function useAgentThinking() {
    const { events } = useAgent();
    return events
        .filter((e) => e.type === 'thinking')
        .map((e) => e.content)
        .join('\n');
}
/** Hook for tool call tracking */
export function useAgentTools() {
    const { events } = useAgent();
    const calls = [];
    let pendingCall = null;
    for (const event of events) {
        if (event.type === 'tool_call') {
            pendingCall = { tool: event.tool, args: event.args };
        }
        else if (event.type === 'tool_result' && pendingCall?.tool === event.tool) {
            calls.push({ ...pendingCall, result: event.result });
            pendingCall = null;
        }
    }
    return calls;
}
//# sourceMappingURL=index.js.map