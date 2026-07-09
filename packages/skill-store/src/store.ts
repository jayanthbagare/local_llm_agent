// ── Skill Store ──
// Registry for loading, caching, and managing skill definitions.
// Supports bundled skills, IndexedDB caching, and remote CDN fetching.

import type { SkillDefinition, SkillManifest, SkillManifestEntry } from './types';
import { validateSkill } from './validator';

export interface SkillStoreOptions {
  /** Remote registry URL for fetching skill manifests */
  registryUrl?: string;
  /** Cache duration in ms (default: 1 hour) */
  cacheTTL?: number;
  /** Allow fetching skills from remote */
  allowRemote?: boolean;
}

interface CacheEntry {
  skill: SkillDefinition;
  fetchedAt: number;
  sha256?: string;
}

export class SkillStore {
  private builtins = new Map<string, SkillDefinition>();
  private registered = new Map<string, SkillDefinition>();
  private cache: Map<string, CacheEntry> | null = null;
  private manifest: SkillManifest | null = null;
  private options: Required<SkillStoreOptions>;

  constructor(options: SkillStoreOptions = {}) {
    this.options = {
      registryUrl: options.registryUrl || '',
      cacheTTL: options.cacheTTL || 3600000, // 1 hour
      allowRemote: options.allowRemote ?? true,
    };
  }

  // ── Built-in skills (bundled with SDK) ──

  /** Register a built-in skill (bundled with the SDK) */
  registerBuiltin(skill: SkillDefinition): void {
    const result = validateSkill(skill);
    if (!result.valid) {
      throw new Error(`Invalid skill "${skill.id}": ${result.errors.map(e => e.message).join('; ')}`);
    }
    this.builtins.set(skill.id, skill);
  }

  /** Register multiple built-in skills */
  registerBuiltins(skills: SkillDefinition[]): void {
    for (const skill of skills) this.registerBuiltin(skill);
  }

  /** Get a built-in skill by ID */
  getBuiltin(id: string): SkillDefinition | undefined {
    return this.builtins.get(id);
  }

  /** List all built-in skill IDs */
  listBuiltinIds(): string[] {
    return [...this.builtins.keys()];
  }

  /** List all built-in skills */
  listBuiltins(): SkillDefinition[] {
    return [...this.builtins.values()];
  }

  // ── User-registered skills (inline definitions) ──

  /** Register a user-defined skill at runtime */
  register(skill: SkillDefinition): void {
    const result = validateSkill(skill);
    if (!result.valid) {
      throw new Error(`Invalid skill "${skill.id}": ${result.errors.map(e => e.message).join('; ')}`);
    }
    this.registered.set(skill.id, skill);
  }

  /** Remove a user-registered skill */
  unregister(id: string): boolean {
    return this.registered.delete(id);
  }

  /** Get a user-registered skill */
  getRegistered(id: string): SkillDefinition | undefined {
    return this.registered.get(id);
  }

  // ── Remote fetching ──

  /** Fetch and cache a skill from the remote registry */
  async fetch(id: string, version?: string): Promise<SkillDefinition> {
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
  async fetchAll(ids: string[]): Promise<SkillDefinition[]> {
    return Promise.all(ids.map(id => this.fetch(id)));
  }

  // ── Caching (IndexedDB-backed in browser, in-memory in Node) ──

  private async _initCache(): Promise<Map<string, CacheEntry>> {
    if (this.cache) return this.cache;
    this.cache = new Map();

    // In browser: try IndexedDB via idb-keyval if available
    if (typeof indexedDB !== 'undefined') {
      try {
        // Try to load from IndexedDB
        const { get } = await this._getIDB();
        const keys = await this._getIDBKeys();
        if (keys) {
          for (const key of keys) {
            const entry = await get(key);
            if (entry) this.cache.set(key as string, entry as CacheEntry);
          }
        }
      } catch {
        // IndexedDB unavailable, use in-memory cache
      }
    }

    return this.cache;
  }

  private async _getIDB(): Promise<{ get: (k: string) => Promise<unknown>; set: (k: string, v: unknown) => Promise<void> }> {
    // Dynamic import of idb-keyval — will fail in Node without polyfill
    try {
      const idb = await import('idb-keyval');
      return { get: idb.get, set: idb.set };
    } catch {
      // Fallback to simple in-memory Map wrapped in async API
      const mem = new Map<string, unknown>();
      return {
        get: async (k: string) => mem.get(k),
        set: async (k: string, v: unknown) => { mem.set(k, v); },
      };
    }
  }

  private async _getIDBKeys(): Promise<string[] | null> {
    try {
      const idb = await import('idb-keyval');
      return idb.keys() as Promise<string[]>;
    } catch {
      return this.cache ? [...this.cache.keys()] : [];
    }
  }

  async getCached(id: string): Promise<SkillDefinition | undefined> {
    const cache = await this._initCache();
    const entry = cache.get(id);
    return entry?.skill;
  }

  private _getCacheEntry(id: string): CacheEntry | undefined {
    return this.cache?.get(id);
  }

  async cacheSkill(id: string, skill: SkillDefinition): Promise<void> {
    await this._cacheSkill(id, skill);
  }

  private async _cacheSkill(id: string, skill: SkillDefinition, sha256?: string): Promise<void> {
    const cache = await this._initCache();
    const entry: CacheEntry = {
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
      } catch { /* ignore persistence errors */ }
    }
  }

  /** Clear all cached skills */
  async clearCache(): Promise<void> {
    const cache = await this._initCache();
    cache.clear();
  }

  // ── Lookup (priority: registered > cached > builtin) ──

  /** Get a skill by ID, checking all sources */
  async get(id: string): Promise<SkillDefinition | undefined> {
    // 1. User-registered
    if (this.registered.has(id)) return this.registered.get(id);

    // 2. Cache
    const cached = await this.getCached(id);
    if (cached) return cached;

    // 3. Built-in
    return this.builtins.get(id);
  }

  /** List all available skill IDs */
  async listIds(): Promise<string[]> {
    const ids = new Set<string>();
    for (const id of this.builtins.keys()) ids.add(id);
    for (const id of this.registered.keys()) ids.add(id);
    const cache = await this._initCache();
    for (const id of cache.keys()) ids.add(id);
    return [...ids];
  }

  // ── Private helpers ──

  private async _resolveEntry(id: string, _version?: string): Promise<SkillManifestEntry> {
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
      if (!resp.ok) throw new Error(`Failed to fetch manifest: ${resp.status}`);
      this.manifest = await resp.json();
    }

    if (!this.manifest) {
      throw new Error('Manifest failed to load');
    }
    const entry = this.manifest.skills[id];
    if (!entry) {
      throw new Error(`Skill "${id}" not found in registry`);
    }

    return entry;
  }

  private async _fetchSkill(url: string): Promise<SkillDefinition> {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to fetch skill from ${url}: ${resp.status}`);

    const text = await resp.text();

    // Parse YAML or JSON
    if (url.endsWith('.yaml') || url.endsWith('.yml')) {
      return this._parseYAML(text);
    }
    return JSON.parse(text);
  }

  private async _parseYAML(text: string): Promise<SkillDefinition> {
    // Simple YAML parser for skill definitions
    // Handles the subset used in skill files — not a full YAML parser
    try {
      // Try js-yaml
      const yaml = await import('js-yaml');
      return yaml.load(text) as SkillDefinition;
    } catch {
      // Fallback: basic YAML-like parsing
      return this._parseSimpleYAML(text);
    }
  }

  private _parseSimpleYAML(text: string): SkillDefinition {
    // Minimal YAML parser for skills (handles our skill file format)
    const result: Record<string, unknown> = {};
    let currentKey = '';
    const lines = text.split('\n');

    for (const line of lines) {
      if (line.trim().startsWith('#') || !line.trim()) continue;
      const indent = line.search(/\S/);

      if (indent === 0) {
        const colonIdx = line.indexOf(':');
        if (colonIdx > 0) {
          currentKey = line.slice(0, colonIdx).trim();
          const value = line.slice(colonIdx + 1).trim();
          if (value) {
            result[currentKey] = this._parseYAMLValue(value);
          } else {
            result[currentKey] = {};
          }
        }
      } else if (indent > 0 && currentKey) {
        const trimmed = line.trim();
        const colonIdx = trimmed.indexOf(':');
        if (colonIdx > 0) {
          const key = trimmed.slice(0, colonIdx).trim();
          const value = trimmed.slice(colonIdx + 1).trim();
          if (typeof result[currentKey] === 'object' && result[currentKey] !== null) {
            (result[currentKey] as Record<string, unknown>)[key] = value ? this._parseYAMLValue(value) : {};
          }
        } else if (trimmed.startsWith('- ')) {
          const item = trimmed.slice(2).trim();
          if (!Array.isArray(result[currentKey])) {
            result[currentKey] = [];
          }
          (result[currentKey] as unknown[]).push(this._parseYAMLValue(item));
        }
      }
    }

    return result as unknown as SkillDefinition;
  }

  private _parseYAMLValue(value: string): unknown {
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (value === 'null' || value === '~') return null;
    if (/^\d+$/.test(value)) return parseInt(value, 10);
    if (/^\d+\.\d+$/.test(value)) return parseFloat(value);
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      return value.slice(1, -1);
    }
    return value;
  }
}

/** Create a SkillStore with default options */
export function createSkillStore(options?: SkillStoreOptions): SkillStore {
  return new SkillStore(options);
}
