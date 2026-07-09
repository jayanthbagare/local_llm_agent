// ── Agent File Parsing & Validation ──

import type { AgentFile, AgentFileValidation, Trigger } from './types';

const VALID_ID_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const TRIGGER_TYPES = new Set(['manual', 'event', 'schedule']);

/** Parse an agent file from a JSON string or a plain object. */
export function parseAgentFile(input: string | object): AgentFile {
  const obj = typeof input === 'string' ? JSON.parse(input) : input;
  return normalizeAgentFile(obj as Record<string, unknown>);
}

/** Fill in defaults and coerce shapes into a normalized AgentFile. */
export function normalizeAgentFile(raw: Record<string, unknown>): AgentFile {
  const trigger = (raw.trigger ?? { type: 'manual' }) as Trigger;
  const file: AgentFile = {
    id: String(raw.id ?? ''),
    name: raw.name ? String(raw.name) : undefined,
    model: raw.model ? String(raw.model) : undefined,
    systemPrompt: raw.systemPrompt ? String(raw.systemPrompt) : undefined,
    skills: Array.isArray(raw.skills) ? (raw.skills as string[]) : undefined,
    customSkills: Array.isArray(raw.customSkills) ? (raw.customSkills as unknown[]) : undefined,
    maxSteps: typeof raw.maxSteps === 'number' ? raw.maxSteps : undefined,
    maxTokens: typeof raw.maxTokens === 'number' ? raw.maxTokens : undefined,
    temperature: typeof raw.temperature === 'number' ? raw.temperature : undefined,
    trigger,
    enabled: raw.enabled === undefined ? true : Boolean(raw.enabled),
  };
  return file;
}

/** Validate a (normalized) agent file. Does not throw. */
export function validateAgentFile(file: AgentFile): AgentFileValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!file.id || !VALID_ID_RE.test(file.id)) {
    errors.push('id must be kebab-case (e.g. "price-watcher")');
  }
  if (!file.trigger || typeof file.trigger !== 'object') {
    errors.push('trigger is required');
    return { valid: false, errors, warnings };
  }

  const t = file.trigger;
  if (!TRIGGER_TYPES.has(t.type)) {
    errors.push(`trigger.type must be one of: ${[...TRIGGER_TYPES].join(', ')}`);
  }

  switch (t.type) {
    case 'event':
      if (!t.target) errors.push('event trigger requires a target (CSS selector)');
      if (!t.on) errors.push('event trigger requires an event name (on)');
      if (!t.promptTemplate) errors.push('event trigger requires a promptTemplate');
      break;
    case 'schedule':
      if (t.interval == null && !t.cron) {
        errors.push('schedule trigger requires interval or cron');
      }
      if (t.cron && !isValidCron(t.cron)) {
        errors.push(`invalid cron expression: "${t.cron}"`);
      }
      if (t.interval != null) {
        const ms = parseInterval(t.interval);
        if (ms == null) errors.push(`invalid interval: "${t.interval}"`);
        else if (ms < 1000) warnings.push('interval < 1s may overwhelm a local model');
      }
      if (!t.promptTemplate) errors.push('schedule trigger requires a promptTemplate');
      break;
    case 'manual':
      // no required fields
      break;
  }

  if (!file.systemPrompt) warnings.push('no systemPrompt — the model has no task framing');
  if (!file.skills?.length && !file.customSkills?.length) {
    warnings.push('no skills enabled — the task can only chat, not use tools');
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ── Interval parsing ──

/**
 * Parse an interval into milliseconds.
 *  - number → treated as ms
 *  - '30s' | '5m' | '1h' | '2h30m' | '500ms' → summed
 * Returns null if unparseable.
 */
export function parseInterval(interval: string | number): number | null {
  if (typeof interval === 'number') return interval > 0 ? interval : null;
  const re = /(\d+)\s*(ms|s|m|h|d)/g;
  let total = 0;
  let matched = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(interval)) !== null) {
    matched = true;
    const n = parseInt(m[1], 10);
    switch (m[2]) {
      case 'ms': total += n; break;
      case 's': total += n * 1000; break;
      case 'm': total += n * 60_000; break;
      case 'h': total += n * 3_600_000; break;
      case 'd': total += n * 86_400_000; break;
    }
  }
  if (!matched) {
    const n = Number(interval);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return total > 0 ? total : null;
}

// ── Cron ──

/**
 * Minimal 5-field cron validator: "min hour dom month dow".
 * Supports: star, step (star slash n), ranges (a-b), lists (a,b,c). No names.
 */
export function isValidCron(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const ranges: [number, number][] = [
    [0, 59], // minute
    [0, 23], // hour
    [1, 31], // day of month
    [1, 12], // month
    [0, 6], // day of week (0 = Sunday)
  ];
  return parts.every((field, i) => isValidCronField(field, ranges[i][0], ranges[i][1]));
}

function isValidCronField(field: string, min: number, max: number): boolean {
  if (field === '*') return true;
  return field.split(',').every((part) => {
    // step: */n or a-b/n
    let base = part;
    let step: number | null = null;
    if (part.includes('/')) {
      const [b, s] = part.split('/');
      base = b;
      step = Number(s);
      if (!Number.isInteger(step) || step <= 0) return false;
    }
    if (base === '*') return true;
    if (base.includes('-')) {
      const [a, b] = base.split('-').map(Number);
      return Number.isInteger(a) && Number.isInteger(b) && a >= min && b <= max && a <= b;
    }
    const n = Number(base);
    return Number.isInteger(n) && n >= min && n <= max;
  });
}

/** Does a Date match a 5-field cron expression? (validate first) */
export function cronMatches(expr: string, date: Date): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const values = [
    date.getMinutes(),
    date.getHours(),
    date.getDate(),
    date.getMonth() + 1,
    date.getDay(),
  ];
  return parts.every((field, i) => cronFieldMatches(field, values[i]));
}

function cronFieldMatches(field: string, value: number): boolean {
  if (field === '*') return true;
  return field.split(',').some((part) => {
    let base = part;
    let step = 1;
    if (part.includes('/')) {
      const [b, s] = part.split('/');
      base = b;
      step = Number(s);
    }
    let lo: number;
    let hi: number;
    if (base === '*') {
      // range depends on caller; approximate with value itself for step math
      return value % step === 0;
    } else if (base.includes('-')) {
      const [a, b] = base.split('-').map(Number);
      lo = a;
      hi = b;
    } else {
      lo = hi = Number(base);
    }
    if (value < lo || value > hi) return false;
    return (value - lo) % step === 0;
  });
}

// ── DOM discovery ──

/**
 * Discover agent files declared inline in the current document via
 * <script type="application/agent+json"> blocks. Browser-only.
 */
export function discoverAgentFiles(doc?: Document): AgentFile[] {
  const d = doc ?? (typeof document !== 'undefined' ? document : undefined);
  if (!d) return [];
  const nodes = d.querySelectorAll('script[type="application/agent+json"]');
  const files: AgentFile[] = [];
  nodes.forEach((node) => {
    const text = node.textContent?.trim();
    if (!text) return;
    try {
      const parsed = JSON.parse(text);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of arr) files.push(normalizeAgentFile(item));
    } catch {
      // skip malformed blocks
    }
  });
  return files;
}

/** Fetch and parse an agent file from a URL (browser or Node with fetch). */
export async function fetchAgentFile(url: string): Promise<AgentFile> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch agent file ${url}: ${resp.status}`);
  return parseAgentFile(await resp.text());
}
