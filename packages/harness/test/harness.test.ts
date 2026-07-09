// ── Harness Orchestrator Tests ──
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentHarness } from '../src/harness';
import type { LLMEngine, GenerateResult } from '@local-llm-agent/llm-engine';
import type { HarnessEvent } from '../src/types';

// Minimal fake engine: returns a fixed reply after a small async delay.
function makeFakeEngine(reply = 'ok', delayMs = 0): LLMEngine {
  let aborted = false;
  return {
    async load() {},
    isLoaded: () => true,
    getModelInfo: () => ({ id: 'fake', name: 'fake', contextLength: 4096, isLoaded: true, device: 'wasm' }),
    async generate(): Promise<GenerateResult> {
      aborted = false;
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return {
        text: aborted ? '' : reply,
        tokens: [{ text: reply }],
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    },
    async *generateStream() {
      yield { text: reply };
    },
    countTokens: () => 1,
    async unload() {},
    abort() {
      aborted = true;
    },
  };
}

function collect(harness: AgentHarness): HarnessEvent[] {
  const events: HarnessEvent[] = [];
  harness.on((e) => events.push(e));
  return events;
}

describe('AgentHarness — manual trigger', () => {
  it('runs a task on runTask() and emits done', async () => {
    const harness = new AgentHarness({ engine: makeFakeEngine('hello') });
    const events = collect(harness);
    harness.addTask({ id: 'greet', systemPrompt: 'x', trigger: { type: 'manual' }, enabled: true });
    harness.start();
    harness.runTask('greet', 'hi');

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'task_done')).toBe(true);
    });
    const done = events.find((e) => e.type === 'task_done') as Extract<HarnessEvent, { type: 'task_done' }>;
    expect(done.taskId).toBe('greet');
    expect(done.response).toBe('hello');
    expect(events.some((e) => e.type === 'task_triggered')).toBe(true);
  });

  it('uses the manual promptTemplate when no prompt is given', async () => {
    const harness = new AgentHarness({ engine: makeFakeEngine() });
    const events = collect(harness);
    harness.addTask({ id: 't', systemPrompt: 'x', trigger: { type: 'manual', promptTemplate: 'default prompt' } });
    harness.start();
    harness.runTask('t');
    await vi.waitFor(() => expect(events.some((e) => e.type === 'task_triggered')).toBe(true));
    const trig = events.find((e) => e.type === 'task_triggered') as Extract<HarnessEvent, { type: 'task_triggered' }>;
    expect(trig.prompt).toBe('default prompt');
  });

  it('rejects invalid and duplicate tasks', () => {
    const harness = new AgentHarness({ engine: makeFakeEngine() });
    expect(() => harness.addTask({ id: 'Bad Id', trigger: { type: 'manual' } })).toThrow();
    harness.addTask({ id: 'dup', trigger: { type: 'manual' } });
    expect(() => harness.addTask({ id: 'dup', trigger: { type: 'manual' } })).toThrow(/Duplicate/);
  });
});

describe('AgentHarness — concurrency', () => {
  it('queue policy runs re-triggers sequentially', async () => {
    const harness = new AgentHarness({ engine: makeFakeEngine('r', 30), concurrency: 'queue' });
    const events = collect(harness);
    harness.addTask({ id: 't', systemPrompt: 'x', trigger: { type: 'manual' } });
    harness.start();
    harness.runTask('t', 'a');
    harness.runTask('t', 'b'); // queued while first runs

    await vi.waitFor(
      () => {
        const dones = events.filter((e) => e.type === 'task_done');
        expect(dones.length).toBe(2);
      },
      { timeout: 2000 },
    );
    expect(events.some((e) => e.type === 'task_skipped')).toBe(false);
  });

  it('skip policy drops re-triggers while running', async () => {
    const harness = new AgentHarness({ engine: makeFakeEngine('r', 40), concurrency: 'skip' });
    const events = collect(harness);
    harness.addTask({ id: 't', systemPrompt: 'x', trigger: { type: 'manual' } });
    harness.start();
    harness.runTask('t', 'a');
    harness.runTask('t', 'b'); // should be skipped

    await vi.waitFor(
      () => expect(events.filter((e) => e.type === 'task_done').length).toBe(1),
      { timeout: 2000 },
    );
    expect(events.some((e) => e.type === 'task_skipped')).toBe(true);
  });
});

describe('AgentHarness — event trigger integration', () => {
  it('fires a task when a mocked event dispatches', async () => {
    // Fake target injected through triggerDeps.
    const listeners: Record<string, ((e: unknown) => void)[]> = {};
    const target = {
      addEventListener: (t: string, l: (e: unknown) => void) => {
        (listeners[t] ??= []).push(l);
      },
      removeEventListener: () => {},
    };
    const harness = new AgentHarness({
      engine: makeFakeEngine('done'),
      triggerDeps: { event: { resolveTarget: () => target } },
    });
    const events = collect(harness);
    harness.addTask({
      id: 'watch',
      systemPrompt: 'x',
      trigger: { type: 'event', target: '#f', on: 'change', debounceMs: 0, promptTemplate: 'val {{value}}' },
    });
    harness.start();
    listeners['change'][0]({ target: { value: '7' } });

    await vi.waitFor(() => expect(events.some((e) => e.type === 'task_done')).toBe(true));
    const trig = events.find((e) => e.type === 'task_triggered') as Extract<HarnessEvent, { type: 'task_triggered' }>;
    expect(trig.prompt).toBe('val 7');
  });
});

describe('AgentHarness — schedule trigger integration', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires a task on the interval', async () => {
    const harness = new AgentHarness({
      engine: makeFakeEngine('tick'),
      triggerDeps: { schedule: { isHidden: () => false } },
    });
    const events: HarnessEvent[] = [];
    harness.on((e) => events.push(e));
    harness.addTask({
      id: 'cron',
      systemPrompt: 'x',
      trigger: { type: 'schedule', interval: '1s', promptTemplate: 'go' },
    });
    harness.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(events.some((e) => e.type === 'task_triggered')).toBe(true);
    harness.stop();
  });
});
