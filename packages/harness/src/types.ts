// ── Harness Types ──
// An "Agent File" declares a task: which skills (tools) to use, a system
// prompt, and a trigger describing WHEN the agent loop should run.
// A single page may declare many agent files, each with its own trigger.

import type { AgentEvent } from '@local-llm-agent/nano-agent';

/** How a task is triggered. */
export type TriggerType = 'manual' | 'event' | 'schedule';

/** Trigger: run only when the user/API asks. */
export interface ManualTrigger {
  type: 'manual';
  /** Optional default prompt used when runTask() is called without one. */
  promptTemplate?: string;
}

/** Trigger: run in response to a DOM or custom event. */
export interface EventTrigger {
  type: 'event';
  /** CSS selector for the element to listen on (or 'document' / 'window'). */
  target: string;
  /**
   * Event name to listen for, e.g. 'change', 'input', 'click', 'submit',
   * or 'custom:<name>' for a CustomEvent dispatched on document/window.
   */
  on: string;
  /** Debounce in ms before running (default 300). Prevents event storms. */
  debounceMs?: number;
  /**
   * Prompt to run when the event fires. `{{value}}` is replaced with the
   * target's current value/checked/textContent; `{{detail}}` with the JSON of
   * a CustomEvent's detail.
   */
  promptTemplate: string;
}

/** Trigger: run on a timer (interval and/or cron), while the page is open. */
export interface ScheduleTrigger {
  type: 'schedule';
  /** Fixed interval string: '30s', '5m', '1h', '2h30m', or a number of ms. */
  interval?: string | number;
  /** 5-field cron expression (min hour dom month dow). Evaluated per minute. */
  cron?: string;
  /** Prompt to run on each tick. */
  promptTemplate: string;
  /** Skip ticks while the tab is hidden (default true). */
  pauseWhenHidden?: boolean;
}

export type Trigger = ManualTrigger | EventTrigger | ScheduleTrigger;

/** A declarative task definition associated with a page. */
export interface AgentFile {
  /** Unique task id (kebab-case). */
  id: string;
  /** Human-readable name. */
  name?: string;
  /** Model id override (falls back to the harness default). */
  model?: string;
  /** System prompt for this task's agent. */
  systemPrompt?: string;
  /** Built-in skill ids to enable (e.g. 'web-search', 'file-read'). */
  skills?: string[];
  /** Inline custom skill definitions (SkillDefinition shape). */
  customSkills?: unknown[];
  /** Max tool-calling iterations per run. */
  maxSteps?: number;
  /** Max tokens per generation. */
  maxTokens?: number;
  /** Sampling temperature. */
  temperature?: number;
  /** When this task runs. */
  trigger: Trigger;
  /** Disable without deleting. */
  enabled?: boolean;
}

/**
 * When multiple runs of the SAME task are requested while one is in flight:
 *  - 'queue': run them one after another (default)
 *  - 'skip': drop the new request
 *  - 'restart': abort the current run and start the new one
 */
export type ConcurrencyPolicy = 'queue' | 'skip' | 'restart';

/** Events emitted by the harness, tagged with the task they belong to. */
export type HarnessEvent =
  | { type: 'task_triggered'; taskId: string; reason: TriggerType; prompt: string }
  | { type: 'task_agent'; taskId: string; event: AgentEvent }
  | { type: 'task_done'; taskId: string; response: string; steps: number; durationMs: number }
  | { type: 'task_error'; taskId: string; error: string }
  | { type: 'task_skipped'; taskId: string; reason: string };

/** Validation result for an agent file. */
export interface AgentFileValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}
