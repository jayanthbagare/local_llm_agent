// ── Trigger Tests ──
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createManualTrigger } from '../src/triggers/manual';
import { createEventTrigger, extractEventValues, type EventTargetLike } from '../src/triggers/event';
import { createScheduleTrigger } from '../src/triggers/schedule';
import { renderTemplate } from '../src/triggers/types';

describe('renderTemplate', () => {
  it('replaces placeholders', () => {
    expect(renderTemplate('v={{value}}', { value: 42 })).toBe('v=42');
  });
  it('empties unknown/null placeholders', () => {
    expect(renderTemplate('a={{a}} b={{b}}', { a: null })).toBe('a= b=');
  });
});

describe('manual trigger', () => {
  it('never fires on its own', () => {
    const fire = vi.fn();
    const t = createManualTrigger({ type: 'manual' });
    t.start(fire);
    t.stop();
    expect(fire).not.toHaveBeenCalled();
  });
});

// A tiny fake EventTarget for deterministic event tests.
class FakeTarget implements EventTargetLike {
  listeners = new Map<string, ((e: unknown) => void)[]>();
  addEventListener(type: string, l: (e: unknown) => void) {
    const arr = this.listeners.get(type) ?? [];
    arr.push(l);
    this.listeners.set(type, arr);
  }
  removeEventListener(type: string, l: (e: unknown) => void) {
    const arr = this.listeners.get(type) ?? [];
    this.listeners.set(type, arr.filter((x) => x !== l));
  }
  dispatch(type: string, e: unknown) {
    (this.listeners.get(type) ?? []).forEach((l) => l(e));
  }
}

describe('extractEventValues', () => {
  it('reads input value', () => {
    expect(extractEventValues({ target: { value: 'hi' } }).value).toBe('hi');
  });
  it('reads checkbox checked', () => {
    expect(extractEventValues({ target: { checked: true } }).value).toBe(true);
  });
  it('reads custom event detail', () => {
    const r = extractEventValues({ detail: { a: 1 } });
    expect(r.value).toBe('{"a":1}');
    expect(r.detail).toEqual({ a: 1 });
  });
});

describe('event trigger', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires (debounced) with rendered prompt on the event', () => {
    const target = new FakeTarget();
    const fire = vi.fn();
    const t = createEventTrigger(
      { type: 'event', target: '#f', on: 'change', debounceMs: 300, promptTemplate: 'value is {{value}}' },
      { resolveTarget: () => target },
    );
    t.start(fire);
    target.dispatch('change', { target: { value: '99' } });
    expect(fire).not.toHaveBeenCalled(); // debounced
    vi.advanceTimersByTime(300);
    expect(fire).toHaveBeenCalledWith('value is 99');
  });

  it('debounce collapses rapid events into one fire', () => {
    const target = new FakeTarget();
    const fire = vi.fn();
    const t = createEventTrigger(
      { type: 'event', target: '#f', on: 'input', debounceMs: 200, promptTemplate: '{{value}}' },
      { resolveTarget: () => target },
    );
    t.start(fire);
    target.dispatch('input', { target: { value: 'a' } });
    vi.advanceTimersByTime(100);
    target.dispatch('input', { target: { value: 'ab' } });
    vi.advanceTimersByTime(100);
    target.dispatch('input', { target: { value: 'abc' } });
    vi.advanceTimersByTime(200);
    expect(fire).toHaveBeenCalledTimes(1);
    expect(fire).toHaveBeenCalledWith('abc');
  });

  it('stop() removes the listener', () => {
    const target = new FakeTarget();
    const fire = vi.fn();
    const t = createEventTrigger(
      { type: 'event', target: '#f', on: 'change', debounceMs: 0, promptTemplate: '{{value}}' },
      { resolveTarget: () => target },
    );
    t.start(fire);
    t.stop();
    target.dispatch('change', { target: { value: 'x' } });
    expect(fire).not.toHaveBeenCalled();
  });

  it('resolves custom: events on document', () => {
    const doc = new FakeTarget();
    const fire = vi.fn();
    const t = createEventTrigger(
      { type: 'event', target: 'document', on: 'custom:price', debounceMs: 0, promptTemplate: 'p={{value}}' },
      { resolveTarget: (sel) => (sel === 'document' ? doc : null) },
    );
    t.start(fire);
    doc.dispatch('price', { detail: 123 });
    expect(fire).toHaveBeenCalledWith('p=123');
  });
});

describe('schedule trigger (interval)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires repeatedly on the interval', () => {
    const fire = vi.fn();
    const t = createScheduleTrigger(
      { type: 'schedule', interval: '1s', promptTemplate: 'tick' },
      { isHidden: () => false },
    );
    t.start(fire);
    vi.advanceTimersByTime(1000);
    expect(fire).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2000);
    expect(fire).toHaveBeenCalledTimes(3);
    t.stop();
    vi.advanceTimersByTime(5000);
    expect(fire).toHaveBeenCalledTimes(3); // stopped
  });

  it('pauses while hidden', () => {
    let hidden = false;
    const fire = vi.fn();
    const t = createScheduleTrigger(
      { type: 'schedule', interval: '1s', promptTemplate: 'tick', pauseWhenHidden: true },
      { isHidden: () => hidden },
    );
    t.start(fire);
    vi.advanceTimersByTime(1000);
    expect(fire).toHaveBeenCalledTimes(1);
    hidden = true;
    vi.advanceTimersByTime(3000);
    expect(fire).toHaveBeenCalledTimes(1); // paused
    hidden = false;
    vi.advanceTimersByTime(1000);
    expect(fire).toHaveBeenCalledTimes(2);
  });
});

describe('schedule trigger (cron)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires once when the minute matches', () => {
    let clock = new Date(2026, 0, 1, 8, 59, 50); // just before 09:00
    const fire = vi.fn();
    const t = createScheduleTrigger(
      { type: 'schedule', cron: '0 9 * * *', promptTemplate: 'morning' },
      { isHidden: () => false, now: () => clock },
    );
    t.start(fire);
    // poll at 15s intervals; advance clock alongside timers
    clock = new Date(2026, 0, 1, 9, 0, 5);
    vi.advanceTimersByTime(15_000);
    expect(fire).toHaveBeenCalledTimes(1);
    // still within the same minute → no double fire
    clock = new Date(2026, 0, 1, 9, 0, 40);
    vi.advanceTimersByTime(15_000);
    expect(fire).toHaveBeenCalledTimes(1);
  });
});
