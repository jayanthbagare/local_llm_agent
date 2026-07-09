// ── @local-llm-agent/harness ──
// Event-driven, multi-task agent harness. A page can declare many agent files
// (tasks), each with a trigger (manual / event / schedule), and this harness
// runs the nano-agent loop when triggers fire.

export type {
  AgentFile,
  Trigger,
  TriggerType,
  ManualTrigger,
  EventTrigger,
  ScheduleTrigger,
  ConcurrencyPolicy,
  HarnessEvent,
  AgentFileValidation,
} from './types';

export {
  parseAgentFile,
  normalizeAgentFile,
  validateAgentFile,
  parseInterval,
  isValidCron,
  cronMatches,
  discoverAgentFiles,
  fetchAgentFile,
} from './agent-file';

export {
  AgentHarness,
  createHarness,
  type HarnessOptions,
  type HarnessSubscriber,
} from './harness';

export {
  createTrigger,
  createManualTrigger,
  createEventTrigger,
  createScheduleTrigger,
  renderTemplate,
  extractEventValues,
  type TriggerController,
  type FireFn,
  type TriggerDeps,
  type EventTriggerDeps,
  type EventTargetLike,
  type ScheduleDeps,
} from './triggers';
