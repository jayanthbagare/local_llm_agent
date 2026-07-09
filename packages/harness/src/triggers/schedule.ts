// ── Schedule Trigger ──
// Fires on a fixed interval and/or a 5-field cron expression, while the page
// is open. Cron granularity is one minute (checked each minute). This is a
// "soft" scheduler — it only runs while the tab is alive.

import type { ScheduleTrigger } from '../types';
import type { TriggerController, FireFn } from './types';
import { parseInterval, cronMatches } from '../agent-file';

export interface ScheduleDeps {
  /** Override "is the tab hidden?" (for tests). */
  isHidden?: () => boolean;
  /** Override the clock (for tests). */
  now?: () => Date;
}

function defaultIsHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden === true;
}

export function createScheduleTrigger(
  trigger: ScheduleTrigger,
  deps: ScheduleDeps = {},
): TriggerController {
  const isHidden = deps.isHidden ?? defaultIsHidden;
  const now = deps.now ?? (() => new Date());
  const pauseWhenHidden = trigger.pauseWhenHidden ?? true;

  const intervalMs = trigger.interval != null ? parseInterval(trigger.interval) : null;

  let intervalTimer: ReturnType<typeof setTimeout> | null = null;
  let cronTimer: ReturnType<typeof setTimeout> | null = null;
  let lastCronMinute = -1;
  let stopped = false;

  const shouldRun = () => !(pauseWhenHidden && isHidden());

  return {
    start(fire: FireFn) {
      stopped = false;

      // Interval scheduling (recursive setTimeout to avoid drift pile-up).
      if (intervalMs && intervalMs > 0) {
        const tick = () => {
          if (stopped) return;
          if (shouldRun()) fire(trigger.promptTemplate);
          intervalTimer = setTimeout(tick, intervalMs);
        };
        intervalTimer = setTimeout(tick, intervalMs);
      }

      // Cron scheduling: poll every 15s, fire at most once per matching minute.
      if (trigger.cron) {
        const cronExpr = trigger.cron;
        const poll = () => {
          if (stopped) return;
          const d = now();
          const minuteKey = d.getFullYear() * 1e8 + (d.getMonth() + 1) * 1e6 +
            d.getDate() * 1e4 + d.getHours() * 100 + d.getMinutes();
          if (minuteKey !== lastCronMinute && cronMatches(cronExpr, d)) {
            lastCronMinute = minuteKey;
            if (shouldRun()) fire(trigger.promptTemplate);
          }
          cronTimer = setTimeout(poll, 15_000);
        };
        cronTimer = setTimeout(poll, 15_000);
      }
    },
    stop() {
      stopped = true;
      if (intervalTimer) clearTimeout(intervalTimer);
      if (cronTimer) clearTimeout(cronTimer);
      intervalTimer = null;
      cronTimer = null;
    },
  };
}
