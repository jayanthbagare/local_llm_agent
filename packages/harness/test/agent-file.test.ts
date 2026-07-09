// ── Agent File Tests ──
import { describe, it, expect } from 'vitest';
import {
  parseAgentFile,
  normalizeAgentFile,
  validateAgentFile,
  parseInterval,
  isValidCron,
  cronMatches,
} from '../src/agent-file';

describe('parseAgentFile', () => {
  it('parses a JSON string', () => {
    const file = parseAgentFile('{"id":"t1","trigger":{"type":"manual"}}');
    expect(file.id).toBe('t1');
    expect(file.trigger.type).toBe('manual');
    expect(file.enabled).toBe(true);
  });

  it('parses a plain object', () => {
    const file = parseAgentFile({ id: 't2', trigger: { type: 'manual' } });
    expect(file.id).toBe('t2');
  });

  it('defaults enabled to true and trigger to manual', () => {
    const file = normalizeAgentFile({ id: 't3' } as Record<string, unknown>);
    expect(file.enabled).toBe(true);
    expect(file.trigger.type).toBe('manual');
  });

  it('respects enabled: false', () => {
    const file = normalizeAgentFile({ id: 't4', enabled: false, trigger: { type: 'manual' } });
    expect(file.enabled).toBe(false);
  });
});

describe('validateAgentFile', () => {
  it('rejects a bad id', () => {
    const r = validateAgentFile(normalizeAgentFile({ id: 'Bad Id', trigger: { type: 'manual' } }));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('kebab-case'))).toBe(true);
  });

  it('accepts a valid manual task', () => {
    const r = validateAgentFile(
      normalizeAgentFile({ id: 'ok', systemPrompt: 'x', skills: ['web-search'], trigger: { type: 'manual' } }),
    );
    expect(r.valid).toBe(true);
  });

  it('requires target/on/promptTemplate for event triggers', () => {
    const r = validateAgentFile(
      normalizeAgentFile({ id: 'ev', trigger: { type: 'event' } as never }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(3);
  });

  it('accepts a valid event trigger', () => {
    const r = validateAgentFile(
      normalizeAgentFile({
        id: 'ev2',
        systemPrompt: 'x',
        skills: ['web-search'],
        trigger: { type: 'event', target: '#field', on: 'change', promptTemplate: 'v={{value}}' },
      }),
    );
    expect(r.valid).toBe(true);
  });

  it('requires interval or cron for schedule triggers', () => {
    const r = validateAgentFile(
      normalizeAgentFile({ id: 'sc', trigger: { type: 'schedule', promptTemplate: 'go' } as never }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('interval or cron'))).toBe(true);
  });

  it('rejects an invalid cron', () => {
    const r = validateAgentFile(
      normalizeAgentFile({ id: 'sc2', trigger: { type: 'schedule', cron: '99 * * * *', promptTemplate: 'go' } }),
    );
    expect(r.valid).toBe(false);
  });

  it('warns about sub-second intervals', () => {
    const r = validateAgentFile(
      normalizeAgentFile({ id: 'sc3', systemPrompt: 'x', skills: ['a'], trigger: { type: 'schedule', interval: '500ms', promptTemplate: 'go' } }),
    );
    expect(r.valid).toBe(true);
    expect(r.warnings.some((w) => w.includes('local model'))).toBe(true);
  });
});

describe('parseInterval', () => {
  it('parses numbers as ms', () => {
    expect(parseInterval(5000)).toBe(5000);
  });
  it('parses unit strings', () => {
    expect(parseInterval('30s')).toBe(30_000);
    expect(parseInterval('5m')).toBe(300_000);
    expect(parseInterval('1h')).toBe(3_600_000);
    expect(parseInterval('500ms')).toBe(500);
  });
  it('sums compound strings', () => {
    expect(parseInterval('2h30m')).toBe(2 * 3_600_000 + 30 * 60_000);
  });
  it('parses bare numeric strings as ms', () => {
    expect(parseInterval('1500')).toBe(1500);
  });
  it('returns null for garbage', () => {
    expect(parseInterval('abc')).toBeNull();
    expect(parseInterval(0)).toBeNull();
    expect(parseInterval(-5)).toBeNull();
  });
});

describe('isValidCron', () => {
  it('accepts common expressions', () => {
    expect(isValidCron('* * * * *')).toBe(true);
    expect(isValidCron('0 */6 * * *')).toBe(true);
    expect(isValidCron('30 9 * * 1-5')).toBe(true);
    expect(isValidCron('0,15,30,45 * * * *')).toBe(true);
  });
  it('rejects wrong field counts', () => {
    expect(isValidCron('* * * *')).toBe(false);
    expect(isValidCron('* * * * * *')).toBe(false);
  });
  it('rejects out-of-range values', () => {
    expect(isValidCron('99 * * * *')).toBe(false); // minute > 59
    expect(isValidCron('* 25 * * *')).toBe(false); // hour > 23
    expect(isValidCron('* * * 13 *')).toBe(false); // month > 12
  });
});

describe('cronMatches', () => {
  it('matches * * * * * always', () => {
    expect(cronMatches('* * * * *', new Date())).toBe(true);
  });
  it('matches a specific minute/hour', () => {
    const d = new Date(2026, 0, 1, 9, 30, 0); // 09:30
    expect(cronMatches('30 9 * * *', d)).toBe(true);
    expect(cronMatches('31 9 * * *', d)).toBe(false);
  });
  it('matches step fields', () => {
    const at0 = new Date(2026, 0, 1, 6, 0, 0); // 06:00
    expect(cronMatches('0 */6 * * *', at0)).toBe(true);
    const at5 = new Date(2026, 0, 1, 5, 0, 0); // 05:00
    expect(cronMatches('0 */6 * * *', at5)).toBe(false);
  });
  it('matches weekday ranges', () => {
    const thu = new Date(2026, 0, 1, 12, 0, 0); // 2026-01-01 is a Thursday (day 4)
    expect(cronMatches('0 12 * * 1-5', thu)).toBe(true);
    const sun = new Date(2026, 0, 4, 12, 0, 0); // Sunday (day 0)
    expect(cronMatches('0 12 * * 1-5', sun)).toBe(false);
  });
});
