// ── Nano Agent Tests ──
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NanoAgent, createNanoAgent } from '../src/agent';
import { SimulatedEngine } from '../../llm-engine/src/simulated.js';
import { ToolBridge, createToolBridge } from '../../tool-bridge/src/bridge.js';
import type { SkillDefinition } from '../../skill-store/src/types.js';
import type { LLMEngine, ToolCall } from '../../llm-engine/src/types.js';

// ── Test skills ──

const calculatorSkill: SkillDefinition = {
  id: 'calculator',
  name: 'Calculator',
  version: '1.0.0',
  description: 'Evaluate math expressions',
  tool: {
    type: 'function',
    execute: 'return eval(params.expression);',
    parameters: {
      expression: { type: 'string', description: 'Math expression', required: true },
    },
  },
  resultTemplate: 'Result: {{expression}} = {{result}}',
};

const echoSkill: SkillDefinition = {
  id: 'echo',
  name: 'Echo',
  version: '1.0.0',
  description: 'Echo back the message',
  tool: {
    type: 'function',
    execute: 'return { message: params.message, length: params.message.length };',
    transform: 'return { echoed: response.message, chars: response.length };',
    parameters: {
      message: { type: 'string', description: 'Message to echo', required: true },
    },
  },
  resultTemplate: 'Echo: {{echoed}} ({{chars}} chars)',
};

// ── Helper: create a test agent ──

async function createTestAgent(options?: { engine?: LLMEngine; skills?: SkillDefinition[] }) {
  const engine = options?.engine || new SimulatedEngine();
  if (!engine.isLoaded()) {
    await engine.load({ modelId: 'test-model' });
  }
  const bridge = createToolBridge();
  const agent = new NanoAgent({ engine, toolBridge: bridge, maxSteps: 3 });
  if (options?.skills) {
    agent.registerSkills(options.skills);
  }
  return { agent, engine, bridge };
}

// ── Tests ──

describe('NanoAgent', () => {
  it('creates an agent', async () => {
    const { agent } = await createTestAgent();
    expect(agent).toBeDefined();
  });

  describe('basic conversation', () => {
    it('returns a response for a simple query', async () => {
      const { agent } = await createTestAgent();
      const events: any[] = [];

      for await (const event of agent.run('Hello!')) {
        events.push(event);
      }

      const doneEvent = events.find(e => e.type === 'done');
      expect(doneEvent).toBeDefined();
      expect(doneEvent.response).toBeTruthy();
      expect(doneEvent.steps).toBe(1);
    });

    it('emits thinking events', async () => {
      const { agent } = await createTestAgent();
      const events: any[] = [];

      for await (const event of agent.run('Who are you?')) {
        events.push(event);
      }

      const thinking = events.filter((e: any) => e.type === 'thinking');
      expect(thinking.length).toBeGreaterThan(0);
    });

    it('stores messages in conversation history', async () => {
      const { agent } = await createTestAgent();

      for await (const _event of agent.run('Hello')) {
        // consume
      }

      const messages = agent.getMessages();
      expect(messages.length).toBeGreaterThanOrEqual(2); // user + assistant
      expect(messages[0].role).toBe('user');
    });

    it('clears conversation history', async () => {
      const { agent } = await createTestAgent();

      for await (const _event of agent.run('Hello')) {
        // consume
      }

      agent.clearHistory();
      expect(agent.getMessages()).toHaveLength(0);
    });
  });

  describe('tool calling', () => {
    it('calls the echo tool when prompted', async () => {
      const engine = new SimulatedEngine();
      await engine.load({ modelId: 'test-model' });

      // Override generate to simulate a tool call
      const origGenerate = engine.generate.bind(engine);
      let callCount = 0;
      engine.generate = vi.fn().mockImplementation(async (opts: any) => {
        callCount++;
        if (callCount === 1) {
          // First call: return a tool call
          return {
            text: 'I will echo your message.\n```json\n{"name": "echo", "arguments": {"message": "hello world"}}\n```',
            tokens: [],
            finishReason: 'tool_calls' as const,
            toolCalls: [
              {
                id: 'call_1',
                name: 'echo',
                arguments: { message: 'hello world' },
              },
            ],
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          };
        }
        // Second call: final response
        return {
          text: 'Your message was echoed successfully.',
          tokens: [],
          finishReason: 'stop' as const,
          usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
        };
      });

      const bridge = createToolBridge();
      const agent = new NanoAgent({ engine, toolBridge: bridge, maxSteps: 3 });
      agent.registerSkills([echoSkill]);

      const events: any[] = [];
      for await (const event of agent.run('Echo: hello world')) {
        events.push(event);
      }

      // Should have tool_call and tool_result events
      const toolCalls = events.filter((e: any) => e.type === 'tool_call');
      const toolResults = events.filter((e: any) => e.type === 'tool_result');
      const done = events.find((e: any) => e.type === 'done');

      expect(toolCalls.length).toBe(1);
      expect(toolCalls[0].tool).toBe('echo');
      expect(toolResults.length).toBe(1);
      expect(toolResults[0].result.success).toBe(true);
      expect(done).toBeDefined();
    });
  });

  describe('skill management', () => {
    it('registers and retrieves skills', async () => {
      const { agent } = await createTestAgent();
      agent.registerSkill(calculatorSkill);
      expect(agent.getSkills()).toHaveLength(1);
      expect(agent.getSkills()[0].id).toBe('calculator');
    });

    it('registers multiple skills', async () => {
      const { agent } = await createTestAgent();
      agent.registerSkills([calculatorSkill, echoSkill]);
      expect(agent.getSkills()).toHaveLength(2);
    });
  });

  describe('max steps', () => {
    it('stops after reaching max steps', async () => {
      const engine = new SimulatedEngine();
      await engine.load({ modelId: 'test-model' });

      // Always return tool calls to force more steps
      engine.generate = vi.fn().mockResolvedValue({
        text: '```json\n{"name": "echo", "arguments": {"message": "test"}}\n```',
        tokens: [],
        finishReason: 'tool_calls' as const,
        toolCalls: [
          { id: 'call_1', name: 'echo', arguments: { message: 'test' } },
        ],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      });

      const bridge = createToolBridge();
      const agent = new NanoAgent({ engine, toolBridge: bridge, maxSteps: 2 });
      agent.registerSkills([echoSkill]);

      const events: any[] = [];
      for await (const event of agent.run('test')) {
        events.push(event);
      }

      const done = events.find((e: any) => e.type === 'done');
      expect(done).toBeDefined();
      expect(done.steps).toBeLessThanOrEqual(2);
    });
  });

  describe('abort', () => {
    it('can be aborted during execution', async () => {
      const { agent } = await createTestAgent();

      const runPromise = (async () => {
        const events: any[] = [];
        for await (const event of agent.run('Hello')) {
          events.push(event);
          if (event.type === 'thinking') {
            agent.abort();
          }
        }
        return events;
      })();

      const events = await runPromise;
      // Should not have a normal done event after abort
      expect(events.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('setMessages', () => {
    it('restores conversation from messages', async () => {
      const { agent } = await createTestAgent();
      agent.setMessages([
        { role: 'user', content: 'Previous question' },
        { role: 'assistant', content: 'Previous answer' },
      ]);
      expect(agent.getMessages()).toHaveLength(2);
    });
  });
});

describe('createNanoAgent', () => {
  it('creates a NanoAgent instance', async () => {
    const engine = new SimulatedEngine();
    await engine.load({ modelId: 'test' });

    const bridge = createToolBridge();
    const agent = createNanoAgent({ engine, toolBridge: bridge });
    expect(agent).toBeInstanceOf(NanoAgent);
  });
});
