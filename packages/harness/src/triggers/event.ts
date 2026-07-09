// ── Event Trigger ──
// Runs the task in response to a DOM event or a CustomEvent, with debouncing
// and value capture. Supports targets: a CSS selector, 'document', 'window'.
// The `on` field may be a plain event name ('change', 'input', 'click', ...)
// or 'custom:<name>' for a CustomEvent dispatched on document/window.

import type { EventTrigger } from '../types';
import type { TriggerController, FireFn } from './types';
import { renderTemplate } from './types';

/** Minimal EventTarget surface we rely on (keeps this testable without DOM lib). */
export interface EventTargetLike {
  addEventListener(type: string, listener: (e: unknown) => void): void;
  removeEventListener(type: string, listener: (e: unknown) => void): void;
}

export interface EventTriggerDeps {
  /** Resolve a selector/'document'/'window' to an event target. */
  resolveTarget?: (target: string) => EventTargetLike | null;
}

function defaultResolveTarget(target: string): EventTargetLike | null {
  if (typeof document === 'undefined') return null;
  if (target === 'document') return document as unknown as EventTargetLike;
  if (target === 'window') return window as unknown as EventTargetLike;
  return document.querySelector(target) as unknown as EventTargetLike | null;
}

/** Extract a usable value + detail from an event for template rendering. */
export function extractEventValues(e: unknown): { value: unknown; detail: unknown } {
  const ev = e as { target?: unknown; detail?: unknown };
  const t = ev?.target as
    | { value?: unknown; checked?: unknown; textContent?: unknown }
    | undefined;
  let value: unknown = '';
  if (t) {
    if (t.value !== undefined) value = t.value;
    else if (t.checked !== undefined) value = t.checked;
    else if (t.textContent !== undefined) value = t.textContent;
  }
  const detail = ev?.detail;
  if (detail !== undefined && value === '') {
    value = typeof detail === 'object' ? JSON.stringify(detail) : detail;
  }
  return { value, detail };
}

export function createEventTrigger(
  trigger: EventTrigger,
  deps: EventTriggerDeps = {},
): TriggerController {
  const resolve = deps.resolveTarget ?? defaultResolveTarget;
  const eventName = trigger.on.startsWith('custom:') ? trigger.on.slice(7) : trigger.on;
  const isCustom = trigger.on.startsWith('custom:');
  const debounceMs = trigger.debounceMs ?? 300;

  let target: EventTargetLike | null = null;
  let listener: ((e: unknown) => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  return {
    start(fire: FireFn) {
      // Custom events are dispatched on document/window; DOM events on the target.
      target = isCustom
        ? resolve('document') ?? resolve('window')
        : resolve(trigger.target);
      if (!target) {
        console.warn(`[harness] event trigger target not found: ${trigger.target}`);
        return;
      }
      listener = (e: unknown) => {
        const { value, detail } = extractEventValues(e);
        const prompt = renderTemplate(trigger.promptTemplate, {
          value,
          detail: typeof detail === 'object' ? JSON.stringify(detail) : detail,
        });
        if (debounceMs > 0) {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => fire(prompt), debounceMs);
        } else {
          fire(prompt);
        }
      };
      target.addEventListener(eventName, listener);
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
      if (target && listener) target.removeEventListener(eventName, listener);
      target = null;
      listener = null;
    },
  };
}
