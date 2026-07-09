// ── Agent Harness ──
// Loads multiple agent files (tasks), builds a NanoAgent per task sharing one
// LLM engine, wires each task's trigger, and runs the agent loop when triggers
// fire. Emits a unified event stream tagged by taskId.
//
// Because a single engine can only generate one stream at a time, ALL runs are
// serialized through one global lock. Per-task concurrency policy controls what
// happens when the same task is triggered again while busy.

import { NanoAgent } from '@local-llm-agent/nano-agent';
import { createToolBridge } from '@local-llm-agent/tool-bridge';
import { SkillStore, BUILTIN_SKILLS } from '@local-llm-agent/skill-store';
import type { SkillDefinition } from '@local-llm-agent/skill-store';
import type { LLMEngine } from '@local-llm-agent/llm-engine';

import type { AgentFile, ConcurrencyPolicy, HarnessEvent } from './types';
import { validateAgentFile } from './agent-file';
import { createTrigger, type TriggerController, type TriggerDeps } from './triggers';

export interface HarnessOptions {
  /** Shared engine used by every task (load it before start()). */
  engine: LLMEngine;
  /** Default system prompt for tasks that don't specify one. */
  defaultSystemPrompt?: string;
  /** What to do when a task is re-triggered while running (default 'queue'). */
  concurrency?: ConcurrencyPolicy;
  /** Extra dependency injection for triggers (used in tests). */
  triggerDeps?: TriggerDeps;
  /** Skill store options / extra built-ins. */
  extraSkills?: SkillDefinition[];
}

export type HarnessSubscriber = (event: HarnessEvent) => void;

interface Task {
  file: AgentFile;
  agent: NanoAgent;
  toolBridge: ReturnType<typeof createToolBridge>;
  trigger: TriggerController;
  running: boolean;
  queue: string[]; // pending prompts (concurrency: 'queue')
  abort?: () => void;
}

export class AgentHarness {
  private engine: LLMEngine;
  private options: Required<Pick<HarnessOptions, 'concurrency'>> & HarnessOptions;
  private tasks = new Map<string, Task>();
  private subscribers = new Set<HarnessSubscriber>();
  private started = false;
  /** Global generation lock: only one task generates at a time. */
  private engineBusy = false;

  constructor(options: HarnessOptions) {
    this.engine = options.engine;
    this.options = { concurrency: options.concurrency ?? 'queue', ...options };
  }

  /** Subscribe to harness events. Returns an unsubscribe function. */
  on(cb: HarnessSubscriber): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  private emit(event: HarnessEvent): void {
    for (const cb of this.subscribers) {
      try {
        cb(event);
      } catch {
        /* subscriber errors must not break the harness */
      }
    }
  }

  /** Register a task from an agent file. Throws if invalid. */
  addTask(file: AgentFile): void {
    const validation = validateAgentFile(file);
    if (!validation.valid) {
      throw new Error(`Invalid agent file "${file.id}": ${validation.errors.join('; ')}`);
    }
    if (this.tasks.has(file.id)) {
      throw new Error(`Duplicate task id: ${file.id}`);
    }

    // Build a dedicated agent (own tool bridge + skills) for this task.
    const toolBridge = createToolBridge();
    const store = new SkillStore();
    store.registerBuiltins(BUILTIN_SKILLS);
    if (this.options.extraSkills) store.registerBuiltins(this.options.extraSkills);

    const agent = new NanoAgent({
      engine: this.engine,
      toolBridge,
      systemPrompt: file.systemPrompt ?? this.options.defaultSystemPrompt,
      maxSteps: file.maxSteps,
      maxTokens: file.maxTokens,
      temperature: file.temperature,
    });

    // Register requested skills.
    for (const id of file.skills ?? []) {
      const skill = store.getBuiltin(id);
      if (skill) agent.registerSkill(skill);
      else console.warn(`[harness] task "${file.id}": unknown skill "${id}"`);
    }
    for (const custom of file.customSkills ?? []) {
      agent.registerSkill(custom as SkillDefinition);
    }

    const trigger = createTrigger(file.trigger, this.options.triggerDeps);

    const task: Task = { file, agent, toolBridge, trigger, running: false, queue: [] };
    this.tasks.set(file.id, task);

    // If the harness is already running, arm the new task immediately.
    if (this.started && file.enabled !== false) {
      this.armTask(task);
    }
  }

  /** Pre-authorize a directory for the file tools across all tasks. */
  setFileSystemRoot(handle: unknown): void {
    for (const task of this.tasks.values()) {
      task.toolBridge.setFileSystemRoot(handle);
    }
  }

  /** Arm all enabled task triggers. */
  start(): void {
    if (this.started) return;
    this.started = true;
    for (const task of this.tasks.values()) {
      if (task.file.enabled !== false) this.armTask(task);
    }
  }

  /** Disarm all triggers and abort running tasks. */
  stop(): void {
    this.started = false;
    for (const task of this.tasks.values()) {
      task.trigger.stop();
      task.abort?.();
      task.queue = [];
    }
  }

  private armTask(task: Task): void {
    task.trigger.start((prompt) => this.trigger(task.file.id, prompt));
  }

  /** List registered task ids. */
  listTasks(): string[] {
    return [...this.tasks.keys()];
  }

  /** Manually run a task (used for manual triggers or on-demand runs). */
  runTask(id: string, prompt?: string): void {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Unknown task: ${id}`);
    const p =
      prompt ??
      (task.file.trigger.type === 'manual'
        ? task.file.trigger.promptTemplate ?? ''
        : '');
    this.trigger(id, p);
  }

  /** Internal: a trigger fired for a task. Apply concurrency policy. */
  private trigger(id: string, prompt: string): void {
    const task = this.tasks.get(id);
    if (!task) return;

    this.emit({ type: 'task_triggered', taskId: id, reason: task.file.trigger.type, prompt });

    if (task.running) {
      switch (this.options.concurrency) {
        case 'skip':
          this.emit({ type: 'task_skipped', taskId: id, reason: 'already running (skip)' });
          return;
        case 'restart':
          task.abort?.();
          task.queue = [prompt];
          return; // the finally-block of the aborted run will drain the queue
        case 'queue':
        default:
          task.queue.push(prompt);
          return;
      }
    }

    void this.execute(task, prompt);
  }

  private async execute(task: Task, prompt: string): Promise<void> {
    // Global engine lock: serialize generation across tasks.
    while (this.engineBusy) {
      await new Promise((r) => setTimeout(r, 25));
    }
    this.engineBusy = true;
    task.running = true;
    task.abort = () => task.agent.abort();

    const started = Date.now();
    let response = '';
    let steps = 0;
    try {
      for await (const event of task.agent.run(prompt)) {
        this.emit({ type: 'task_agent', taskId: task.file.id, event });
        if (event.type === 'done') {
          response = event.response;
          steps = event.steps;
        }
      }
      this.emit({
        type: 'task_done',
        taskId: task.file.id,
        response,
        steps,
        durationMs: Date.now() - started,
      });
    } catch (err) {
      this.emit({
        type: 'task_error',
        taskId: task.file.id,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      task.running = false;
      task.abort = undefined;
      this.engineBusy = false;
      // Drain one queued prompt if any.
      const next = task.queue.shift();
      if (next !== undefined) void this.execute(task, next);
    }
  }
}

/** Create a harness for the given engine. */
export function createHarness(options: HarnessOptions): AgentHarness {
  return new AgentHarness(options);
}
