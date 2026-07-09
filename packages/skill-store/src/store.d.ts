import type { SkillDefinition } from './types';
export interface SkillStoreOptions {
    /** Remote registry URL for fetching skill manifests */
    registryUrl?: string;
    /** Cache duration in ms (default: 1 hour) */
    cacheTTL?: number;
    /** Allow fetching skills from remote */
    allowRemote?: boolean;
}
export declare class SkillStore {
    private builtins;
    private registered;
    private cache;
    private manifest;
    private options;
    constructor(options?: SkillStoreOptions);
    /** Register a built-in skill (bundled with the SDK) */
    registerBuiltin(skill: SkillDefinition): void;
    /** Register multiple built-in skills */
    registerBuiltins(skills: SkillDefinition[]): void;
    /** Get a built-in skill by ID */
    getBuiltin(id: string): SkillDefinition | undefined;
    /** List all built-in skill IDs */
    listBuiltinIds(): string[];
    /** List all built-in skills */
    listBuiltins(): SkillDefinition[];
    /** Register a user-defined skill at runtime */
    register(skill: SkillDefinition): void;
    /** Remove a user-registered skill */
    unregister(id: string): boolean;
    /** Get a user-registered skill */
    getRegistered(id: string): SkillDefinition | undefined;
    /** Fetch and cache a skill from the remote registry */
    fetch(id: string, version?: string): Promise<SkillDefinition>;
    /** Fetch and cache multiple skills */
    fetchAll(ids: string[]): Promise<SkillDefinition[]>;
    private _initCache;
    private _getIDB;
    private _getIDBKeys;
    getCached(id: string): Promise<SkillDefinition | undefined>;
    private _getCacheEntry;
    cacheSkill(id: string, skill: SkillDefinition): Promise<void>;
    private _cacheSkill;
    /** Clear all cached skills */
    clearCache(): Promise<void>;
    /** Get a skill by ID, checking all sources */
    get(id: string): Promise<SkillDefinition | undefined>;
    /** List all available skill IDs */
    listIds(): Promise<string[]>;
    private _resolveEntry;
    private _fetchSkill;
    private _parseYAML;
    private _parseSimpleYAML;
    private _parseYAMLValue;
}
/** Create a SkillStore with default options */
export declare function createSkillStore(options?: SkillStoreOptions): SkillStore;
//# sourceMappingURL=store.d.ts.map