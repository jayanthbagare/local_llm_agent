// ── Trigger Controllers ──
// A trigger controller watches for its condition (nothing, an event, or a
// timer) and calls `fire(prompt)` when the task should run. Controllers are
// created per task by the harness and disposed on stop().

/** Called by a trigger when the task should run, with the resolved prompt. */
export type FireFn = (prompt: string) => void;

/** A live trigger. Call start() to arm it and stop() to dispose listeners/timers. */
export interface TriggerController {
  start(fire: FireFn): void;
  stop(): void;
}

/** Fill `{{key}}` placeholders in a template from a values map. */
export function renderTemplate(template: string, values: Record<string, unknown>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    const v = values[key];
    return v === undefined || v === null ? '' : String(v);
  });
}
