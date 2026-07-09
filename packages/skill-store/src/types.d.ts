/** Trigger configuration for auto-routing skills */
export interface SkillTrigger {
    keywords?: string[];
    patterns?: string[];
    always?: boolean;
}
/** Parameter definition */
export interface SkillParameter {
    type: string;
    description: string;
    required?: boolean;
    default?: unknown;
    enum?: string[];
    minimum?: number;
    maximum?: number;
    maxLength?: number;
    pattern?: string;
}
/** Retry configuration */
export interface SkillRetry {
    maxAttempts: number;
    backoff?: 'fixed' | 'exponential' | 'linear';
    baseDelay?: number;
}
/** Tool definition within a skill */
export interface SkillTool {
    type: 'rest' | 'mcp' | 'function' | 'browser-api';
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    url?: string;
    queryParams?: Record<string, string>;
    headers?: Record<string, string>;
    body?: Record<string, unknown>;
    server?: {
        transport: 'sse' | 'stdio';
        url: string;
    };
    toolName?: string;
    api?: string;
    execute?: string;
    transform?: string;
    parameters?: Record<string, SkillParameter>;
    retry?: SkillRetry;
}
/** Permission entry */
export interface SkillPermission {
    network?: string;
    'browser-api'?: string;
    description?: string;
}
/** Complete skill definition */
export interface SkillDefinition {
    id: string;
    name: string;
    version: string;
    description?: string;
    author?: string;
    license?: string;
    tags?: string[];
    icon?: string;
    deprecated?: boolean;
    replaces?: string;
    trigger?: SkillTrigger;
    tool: SkillTool;
    resultTemplate?: string;
    permissions?: SkillPermission[];
}
/** Error codes for skill validation */
export declare enum SkillValidationError {
    INVALID_ID = "INVALID_ID",
    INVALID_VERSION = "INVALID_VERSION",
    MISSING_TOOL = "MISSING_TOOL",
    INVALID_TOOL_TYPE = "INVALID_TOOL_TYPE",
    MISSING_URL = "MISSING_URL",
    MISSING_MCP_CONFIG = "MISSING_MCP_CONFIG",
    MISSING_EXECUTE = "MISSING_EXECUTE",
    MISSING_API = "MISSING_API",
    INVALID_PARAMETER = "INVALID_PARAMETER",
    INVALID_PERMISSION = "INVALID_PERMISSION"
}
/** Validation result */
export interface ValidationResult {
    valid: boolean;
    errors: {
        code: SkillValidationError;
        message: string;
        path?: string;
    }[];
    warnings: string[];
}
/** Remote skill manifest entry */
export interface SkillManifestEntry {
    latest: string;
    url: string;
    sha256?: string;
    size?: number;
}
/** Remote registry manifest */
export interface SkillManifest {
    version: string;
    skills: Record<string, SkillManifestEntry>;
}
//# sourceMappingURL=types.d.ts.map