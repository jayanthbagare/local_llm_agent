// ── Built-in Skills Tests ──
import { describe, it, expect } from 'vitest';
import { BUILTIN_SKILLS, getBuiltinSkill } from '../src/builtins';
import { validateSkill } from '../src/validator';

describe('BUILTIN_SKILLS', () => {
  it('all built-in skills pass validation', () => {
    for (const skill of BUILTIN_SKILLS) {
      const r = validateSkill(skill);
      expect(r.valid, `${skill.id}: ${r.errors.map((e) => e.message).join('; ')}`).toBe(true);
    }
  });

  it('exposes the expected skill ids', () => {
    const ids = BUILTIN_SKILLS.map((s) => s.id).sort();
    expect(ids).toEqual(
      ['file-glob', 'file-read', 'file-write', 'http-request', 'mcp-call', 'web-search', 'wikipedia'].sort(),
    );
  });

  it('getBuiltinSkill looks up by id', () => {
    expect(getBuiltinSkill('wikipedia')?.name).toBe('Wikipedia Lookup');
    expect(getBuiltinSkill('nope')).toBeUndefined();
  });

  it('web-search targets Wikipedia (not the dead DuckDuckGo IA API)', () => {
    const s = getBuiltinSkill('web-search')!;
    expect(s.tool.url).toContain('wikipedia.org');
    expect(s.tool.queryParams?.origin).toBe('*'); // CORS-safe
  });

  it('wikipedia tool reads a page extract via the action API', () => {
    const s = getBuiltinSkill('wikipedia')!;
    expect(s.tool.queryParams?.prop).toBe('extracts');
    expect(s.tool.queryParams?.titles).toBe('{{title}}');
    expect(s.tool.parameters?.title?.required).toBe(true);
  });
});
