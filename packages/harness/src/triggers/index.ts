// ── Trigger factory ──

import type { Trigger } from '../types';
import type { TriggerController } from './types';
import { createManualTrigger } from './manual';
import { createEventTrigger, type EventTriggerDeps } from './event';
import { createScheduleTrigger, type ScheduleDeps } from './schedule';

export type { TriggerController, FireFn } from './types';
export { renderTemplate } from './types';
export { createManualTrigger } from './manual';
export { createEventTrigger, extractEventValues, type EventTriggerDeps, type EventTargetLike } from './event';
export { createScheduleTrigger, type ScheduleDeps } from './schedule';

export interface TriggerDeps {
  event?: EventTriggerDeps;
  schedule?: ScheduleDeps;
}

/** Build the appropriate trigger controller for a trigger definition. */
export function createTrigger(trigger: Trigger, deps: TriggerDeps = {}): TriggerController {
  switch (trigger.type) {
    case 'manual':
      return createManualTrigger(trigger);
    case 'event':
      return createEventTrigger(trigger, deps.event);
    case 'schedule':
      return createScheduleTrigger(trigger, deps.schedule);
    default:
      throw new Error(`Unknown trigger type: ${(trigger as { type: string }).type}`);
  }
}
