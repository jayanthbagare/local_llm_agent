// ── Skill Store Tests ──
import { describe, it, expect, beforeEach } from 'vitest';
import { validateSkill, isSkillDefinition } from '../src/validator';
import { SkillStore, createSkillStore } from '../src/store';
// ── Sample skills for testing ──
const webSearchSkill = {
    id: 'web-search',
    name: 'Web Search',
    version: '1.0.0',
    description: 'Search the web',
    tags: ['search'],
    tool: {
        type: 'rest',
        method: 'GET',
        url: 'https://api.example.com/search?q={{query}}',
        parameters: {
            query: { type: 'string', description: 'Search query', required: true },
        },
        retry: { maxAttempts: 2 },
    },
    resultTemplate: 'Results for {{query}}',
    permissions: [{ network: 'api.example.com', description: 'Search API' }],
};
const calculatorSkill = {
    id: 'calculator',
    name: 'Calculator',
    version: '1.0.0',
    tool: {
        type: 'function',
        execute: 'return eval(expression)',
        parameters: {
            expression: { type: 'string', description: 'Math expression', required: true },
        },
    },
};
const mcpSkill = {
    id: 'db-query',
    name: 'Database Query',
    version: '1.0.0',
    tool: {
        type: 'mcp',
        server: { transport: 'sse', url: 'https://mcp.example.com' },
        toolName: 'run_query',
        parameters: {
            sql: { type: 'string', description: 'SQL query', required: true },
        },
    },
};
// ── Validator Tests ──
describe('validateSkill', () => {
    it('validates a complete REST skill', () => {
        const result = validateSkill(webSearchSkill);
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
    });
    it('validates a function skill', () => {
        const result = validateSkill(calculatorSkill);
        expect(result.valid).toBe(true);
    });
    it('validates an MCP skill', () => {
        const result = validateSkill(mcpSkill);
        expect(result.valid).toBe(true);
    });
    it('rejects invalid id format', () => {
        const result = validateSkill({ ...webSearchSkill, id: 'Invalid ID!' });
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.path === 'id')).toBe(true);
    });
    it('rejects invalid version', () => {
        const result = validateSkill({ ...webSearchSkill, version: 'not-semver' });
        expect(result.valid).toBe(false);
    });
    it('rejects missing tool', () => {
        const result = validateSkill({ id: 'test', name: 'Test', version: '1.0.0' });
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.code === 'MISSING_TOOL')).toBe(true);
    });
    it('rejects invalid tool type', () => {
        const result = validateSkill({ ...webSearchSkill, tool: { ...webSearchSkill.tool, type: 'invalid' } });
        expect(result.valid).toBe(false);
    });
    it('rejects REST tool without URL', () => {
        const skill = { ...webSearchSkill, tool: { type: 'rest', method: 'GET' } };
        const result = validateSkill(skill);
        expect(result.valid).toBe(false);
    });
    it('rejects MCP tool without server', () => {
        const skill = { ...mcpSkill, tool: { type: 'mcp', toolName: 'test' } };
        const result = validateSkill(skill);
        expect(result.valid).toBe(false);
    });
    it('rejects function tool without execute', () => {
        const skill = { ...calculatorSkill, tool: { type: 'function' } };
        const result = validateSkill(skill);
        expect(result.valid).toBe(false);
    });
    it('adds warnings for missing description', () => {
        const result = validateSkill(calculatorSkill);
        expect(result.warnings.length).toBeGreaterThan(0);
        expect(result.warnings.some(w => w.includes('description'))).toBe(true);
    });
    it('adds warnings for missing tags', () => {
        const result = validateSkill(calculatorSkill);
        expect(result.warnings.some(w => w.includes('tag'))).toBe(true);
    });
});
describe('isSkillDefinition', () => {
    it('returns true for valid skills', () => {
        expect(isSkillDefinition(webSearchSkill)).toBe(true);
    });
    it('returns false for invalid objects', () => {
        expect(isSkillDefinition(null)).toBe(false);
        expect(isSkillDefinition({})).toBe(false);
        expect(isSkillDefinition('string')).toBe(false);
    });
});
// ── SkillStore Tests ──
describe('SkillStore', () => {
    let store;
    beforeEach(() => {
        store = new SkillStore({ allowRemote: false });
    });
    describe('built-in skills', () => {
        it('registers and retrieves a built-in skill', () => {
            store.registerBuiltin(webSearchSkill);
            expect(store.getBuiltin('web-search')).toEqual(webSearchSkill);
        });
        it('lists all built-in IDs', () => {
            store.registerBuiltins([webSearchSkill, calculatorSkill]);
            const ids = store.listBuiltinIds();
            expect(ids).toContain('web-search');
            expect(ids).toContain('calculator');
            expect(ids).toHaveLength(2);
        });
        it('lists all built-in skills', () => {
            store.registerBuiltins([webSearchSkill, calculatorSkill]);
            const skills = store.listBuiltins();
            expect(skills).toHaveLength(2);
        });
        it('returns undefined for unknown built-in', () => {
            expect(store.getBuiltin('nonexistent')).toBeUndefined();
        });
        it('throws on invalid skill registration', () => {
            expect(() => store.registerBuiltin({ id: 'bad', name: '', version: 'x', tool: {} }))
                .toThrow();
        });
    });
    describe('user-registered skills', () => {
        it('registers and retrieves a skill', () => {
            store.register(calculatorSkill);
            expect(store.getRegistered('calculator')).toEqual(calculatorSkill);
        });
        it('unregisters a skill', () => {
            store.register(calculatorSkill);
            expect(store.unregister('calculator')).toBe(true);
            expect(store.getRegistered('calculator')).toBeUndefined();
        });
        it('returns false when unregistering unknown skill', () => {
            expect(store.unregister('nope')).toBe(false);
        });
        it('throws on invalid skill', () => {
            expect(() => store.register({ id: 'bad' })).toThrow();
        });
    });
    describe('get (priority lookup)', () => {
        it('prefers registered over built-in', async () => {
            store.registerBuiltin(webSearchSkill);
            const modified = { ...webSearchSkill, version: '2.0.0' };
            store.register(modified);
            const result = await store.get('web-search');
            expect(result?.version).toBe('2.0.0');
        });
        it('falls back to built-in', async () => {
            store.registerBuiltin(webSearchSkill);
            const result = await store.get('web-search');
            expect(result).toEqual(webSearchSkill);
        });
        it('returns undefined for unknown', async () => {
            expect(await store.get('unknown')).toBeUndefined();
        });
    });
    describe('caching', () => {
        it('caches and retrieves a skill', async () => {
            await store.cacheSkill('test-skill', webSearchSkill);
            const cached = await store.getCached('test-skill');
            expect(cached).toEqual(webSearchSkill);
        });
        it('clears cache', async () => {
            await store.cacheSkill('test-skill', webSearchSkill);
            await store.clearCache();
            expect(await store.getCached('test-skill')).toBeUndefined();
        });
    });
    describe('listIds', () => {
        it('lists all available skill IDs', async () => {
            store.registerBuiltin(webSearchSkill);
            store.register(calculatorSkill);
            await store.cacheSkill('db-query', mcpSkill);
            const ids = await store.listIds();
            expect(ids).toContain('web-search');
            expect(ids).toContain('calculator');
            expect(ids).toContain('db-query');
        });
    });
    describe('remote fetch disabled', () => {
        it('throws when fetch is called with allowRemote=false', async () => {
            await expect(store.fetch('web-search')).rejects.toThrow('disabled');
        });
    });
});
describe('createSkillStore factory', () => {
    it('creates a store with default options', () => {
        const s = createSkillStore();
        expect(s).toBeInstanceOf(SkillStore);
    });
    it('creates a store with custom options', () => {
        const s = createSkillStore({ allowRemote: true, cacheTTL: 60000 });
        expect(s).toBeInstanceOf(SkillStore);
    });
});
//# sourceMappingURL=store.test.js.map