// ── Skill Store ──
// Registry for loading, caching, and managing skill definitions.
// Supports bundled skills, IndexedDB caching, and remote CDN fetching.
import { validateSkill } from './validator';
export class SkillStore {
    builtins = new Map();
    registered = new Map();
    cache = null;
    manifest = null;
    options;
    constructor(options = {}) {
        this.options = {
            registryUrl: options.registryUrl || '',
            cacheTTL: options.cacheTTL || 3600000, // 1 hour
            allowRemote: options.allowRemote ?? true,
        };
    }
    // ── Built-in skills (bundled with SDK) ──
    /** Register a built-in skill (bundled with the SDK) */
    registerBuiltin(skill) {
        const result = validateSkill(skill);
        if (!result.valid) {
            throw new Error(`Invalid skill "${skill.id}": ${result.errors.map(e => e.message).join('; ')}`);
        }
        this.builtins.set(skill.id, skill);
    }
    /** Register multiple built-in skills */
    registerBuiltins(skills) {
        for (const skill of skills)
            this.registerBuiltin(skill);
    }
    /** Get a built-in skill by ID */
    getBuiltin(id) {
        return this.builtins.get(id);
    }
    /** List all built-in skill IDs */
    listBuiltinIds() {
        return [...this.builtins.keys()];
    }
    /** List all built-in skills */
    listBuiltins() {
        return [...this.builtins.values()];
    }
    // ── User-registered skills (inline definitions) ──
    /** Register a user-defined skill at runtime */
    register(skill) {
        const result = validateSkill(skill);
        if (!result.valid) {
            throw new Error(`Invalid skill "${skill.id}": ${result.errors.map(e => e.message).join('; ')}`);
        }
        this.registered.set(skill.id, skill);
    }
    /** Remove a user-registered skill */
    unregister(id) {
        return this.registered.delete(id);
    }
    /** Get a user-registered skill */
    getRegistered(id) {
        return this.registered.get(id);
    }
    // ── Remote fetching ──
    /** Fetch and cache a skill from the remote registry */
    async fetch(id, version) {
        if (!this.options.allowRemote) {
            throw new Error('Remote fetching is disabled');
        }
        // Check cache first
        const cached = await this.getCached(id);
        if (cached) {
            const age = Date.now() - (this._getCacheEntry(id)?.fetchedAt || 0);
            if (age < this.options.cacheTTL) {
                return cached;
            }
        }
        // Load manifest to resolve URL
        const entry = await this._resolveEntry(id, version);
        const skill = await this._fetchSkill(entry.url);
        // Validate
        const result = validateSkill(skill);
        if (!result.valid) {
            throw new Error(`Fetched skill "${id}" is invalid: ${result.errors.map(e => e.message).join('; ')}`);
        }
        // Cache
        await this._cacheSkill(id, skill, entry.sha256);
        return skill;
    }
    /** Fetch and cache multiple skills */
    async fetchAll(ids) {
        return Promise.all(ids.map(id => this.fetch(id)));
    }
    // ── Caching (IndexedDB-backed in browser, in-memory in Node) ──
    async _initCache() {
        if (this.cache)
            return this.cache;
        this.cache = new Map();
        // In browser: try IndexedDB via idb-keyval if available
        if (typeof indexedDB !== 'undefined') {
            try {
                // Try to load from IndexedDB
                const { get, set } = await this._getIDB();
                const keys = await this._getIDBKeys();
                if (keys) {
                    for (const key of keys) {
                        const entry = await get(key);
                        if (entry)
                            this.cache.set(key, entry);
                    }
                }
            }
            catch {
                // IndexedDB unavailable, use in-memory cache
            }
        }
        return this.cache;
    }
    async _getIDB() {
        // Dynamic import of idb-keyval — will fail in Node without polyfill
        try {
            const idb = await import('idb-keyval');
            return { get: idb.get, set: idb.set };
        }
        catch {
            // Fallback to simple in-memory Map wrapped in async API
            const mem = new Map();
            return {
                get: async (k) => mem.get(k),
                set: async (k, v) => { mem.set(k, v); },
            };
        }
    }
    async _getIDBKeys() {
        try {
            const idb = await import('idb-keyval');
            return idb.keys();
        }
        catch {
            return this.cache ? [...this.cache.keys()] : [];
        }
    }
    async getCached(id) {
        const cache = await this._initCache();
        const entry = cache.get(id);
        return entry?.skill;
    }
    _getCacheEntry(id) {
        return this.cache?.get(id);
    }
    async cacheSkill(id, skill) {
        await this._cacheSkill(id, skill);
    }
    async _cacheSkill(id, skill, sha256) {
        const cache = await this._initCache();
        const entry = {
            skill,
            fetchedAt: Date.now(),
            sha256,
        };
        cache.set(id, entry);
        // Persist to IndexedDB
        if (typeof indexedDB !== 'undefined') {
            try {
                const { set } = await this._getIDB();
                await set(`skill:${id}`, entry);
            }
            catch { /* ignore persistence errors */ }
        }
    }
    /** Clear all cached skills */
    async clearCache() {
        const cache = await this._initCache();
        cache.clear();
    }
    // ── Lookup (priority: registered > cached > builtin) ──
    /** Get a skill by ID, checking all sources */
    async get(id) {
        // 1. User-registered
        if (this.registered.has(id))
            return this.registered.get(id);
        // 2. Cache
        const cached = await this.getCached(id);
        if (cached)
            return cached;
        // 3. Built-in
        return this.builtins.get(id);
    }
    /** List all available skill IDs */
    async listIds() {
        const ids = new Set();
        for (const id of this.builtins.keys())
            ids.add(id);
        for (const id of this.registered.keys())
            ids.add(id);
        const cache = await this._initCache();
        for (const id of cache.keys())
            ids.add(id);
        return [...ids];
    }
    // ── Private helpers ──
    async _resolveEntry(id, _version) {
        // If no registry URL, try to construct a direct URL
        if (!this.options.registryUrl) {
            return {
                latest: 'unknown',
                url: `https://skills.local-llm-agent.dev/v1/${id}.skill.yaml`,
            };
        }
        // Fetch manifest
        if (!this.manifest) {
            const resp = await fetch(`${this.options.registryUrl}/manifest.json`);
            if (!resp.ok)
                throw new Error(`Failed to fetch manifest: ${resp.status}`);
            this.manifest = await resp.json();
        }
        const entry = this.manifest.skills[id];
        if (!entry) {
            throw new Error(`Skill "${id}" not found in registry`);
        }
        return entry;
    }
    async _fetchSkill(url) {
        const resp = await fetch(url);
        if (!resp.ok)
            throw new Error(`Failed to fetch skill from ${url}: ${resp.status}`);
        const text = await resp.text();
        // Parse YAML or JSON
        if (url.endsWith('.yaml') || url.endsWith('.yml')) {
            return this._parseYAML(text);
        }
        return JSON.parse(text);
    }
    _parseYAML(text) {
        // Simple YAML parser for skill definitions
        // Handles the subset used in skill files — not a full YAML parser
        try {
            // Try js-yaml
            const yaml = require('js-yaml');
            return yaml.load(text);
        }
        catch {
            // Fallback: basic YAML-like parsing
            return this._parseSimpleYAML(text);
        }
    }
    _parseSimpleYAML(text) {
        // Minimal YAML parser for skills (handles our skill file format)
        const result = {};
        let currentKey = '';
        let currentIndent = 0;
        const lines = text.split('\n');
        for (const line of lines) {
            if (line.trim().startsWith('#') || !line.trim())
                continue;
            const indent = line.search(/\S/);
            if (indent === 0) {
                const colonIdx = line.indexOf(':');
                if (colonIdx > 0) {
                    currentKey = line.slice(0, colonIdx).trim();
                    const value = line.slice(colonIdx + 1).trim();
                    if (value) {
                        result[currentKey] = this._parseYAMLValue(value);
                    }
                    else {
                        result[currentKey] = {};
                    }
                    currentIndent = 0;
                }
            }
            else if (indent > 0 && currentKey) {
                const trimmed = line.trim();
                const colonIdx = trimmed.indexOf(':');
                if (colonIdx > 0) {
                    const key = trimmed.slice(0, colonIdx).trim();
                    const value = trimmed.slice(colonIdx + 1).trim();
                    if (typeof result[currentKey] === 'object' && result[currentKey] !== null) {
                        result[currentKey][key] = value ? this._parseYAMLValue(value) : {};
                    }
                }
                else if (trimmed.startsWith('- ')) {
                    const item = trimmed.slice(2).trim();
                    if (!Array.isArray(result[currentKey])) {
                        result[currentKey] = [];
                    }
                    result[currentKey].push(this._parseYAMLValue(item));
                }
            }
        }
        return result;
    }
    _parseYAMLValue(value) {
        if (value === 'true')
            return true;
        if (value === 'false')
            return false;
        if (value === 'null' || value === '~')
            return null;
        if (/^\d+$/.test(value))
            return parseInt(value, 10);
        if (/^\d+\.\d+$/.test(value))
            return parseFloat(value);
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            return value.slice(1, -1);
        }
        return value;
    }
}
/** Create a SkillStore with default options */
export function createSkillStore(options) {
    return new SkillStore(options);
}
//# sourceMappingURL=store.js.map