// ── Manual Trigger ──
// Never fires on its own; runs only when the harness calls runTask().
// This controller exists for uniformity; it holds the default prompt.

import type { ManualTrigger } from '../types';
import type { TriggerController } from './types';

export function createManualTrigger(_trigger: ManualTrigger): TriggerController {
  return {
    start() {
      /* nothing to arm — driven by runTask() */
    },
    stop() {
      /* nothing to dispose */
    },
  };
}
