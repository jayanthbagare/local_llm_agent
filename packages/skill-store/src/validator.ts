// ── Skill Validator ──
import type { SkillDefinition, ValidationResult, SkillValidationError } from './types';

const VALID_ID_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
const VALID_VERSION_RE = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/;
const VALID_TOOL_TYPES = new Set(['rest', 'mcp', 'function', 'browser-api']);

export function validateSkill(skill: unknown): ValidationResult {
  const errors: ValidationResult['errors'] = [];
  const warnings: string[] = [];
  const add = (code: SkillValidationError, msg: string, path?: string) => errors.push({ code, message: msg, path });
  const warn = (msg: string) => warnings.push(msg);

  if (!skill || typeof skill !== 'object') {
    add('INVALID_ID' as SkillValidationError, 'Skill must be an object');
    return { valid: false, errors, warnings };
  }

  const s = skill as Record<string, unknown>;

  // Validate id
  if (typeof s.id !== 'string' || !VALID_ID_RE.test(s.id)) {
    add('INVALID_ID' as SkillValidationError, 'id must be kebab-case (e.g., "web-search")', 'id');
  }

  // Validate name
  if (typeof s.name !== 'string' || !s.name.trim()) {
    add('INVALID_ID' as SkillValidationError, 'name is required', 'name');
  }

  // Validate version
  if (typeof s.version !== 'string' || !VALID_VERSION_RE.test(s.version)) {
    add('INVALID_VERSION' as SkillValidationError, 'version must be semver (e.g., "1.0.0")', 'version');
  }

  // Validate tool
  if (!s.tool || typeof s.tool !== 'object') {
    add('MISSING_TOOL' as SkillValidationError, 'tool definition is required', 'tool');
    return { valid: false, errors, warnings };
  }

  const tool = s.tool as Record<string, unknown>;

  if (typeof tool.type !== 'string' || !VALID_TOOL_TYPES.has(tool.type)) {
    add('INVALID_TOOL_TYPE' as SkillValidationError, `tool.type must be one of: ${[...VALID_TOOL_TYPES].join(', ')}`, 'tool.type');
  } else {
    // Type-specific validation
    switch (tool.type) {
      case 'rest':
        if (typeof tool.url !== 'string') {
          add('MISSING_URL' as SkillValidationError, 'REST tools require a url', 'tool.url');
        }
        if (tool.method && !['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(tool.method as string)) {
          warn(`Unusual HTTP method: ${tool.method}`);
        }
        break;
      case 'mcp':
        if (!tool.server || typeof tool.server !== 'object' || !(tool.server as any)?.url) {
          add('MISSING_MCP_CONFIG' as SkillValidationError, 'MCP tools require server.url', 'tool.server');
        }
        if (typeof tool.toolName !== 'string') {
          warn('MCP tools should specify toolName');
        }
        break;
      case 'function':
        if (typeof tool.execute !== 'string') {
          add('MISSING_EXECUTE' as SkillValidationError, 'function tools require execute code', 'tool.execute');
        }
        break;
      case 'browser-api':
        if (typeof tool.api !== 'string') {
          add('MISSING_API' as SkillValidationError, 'browser-api tools require an api name', 'tool.api');
        }
        break;
    }
  }

  // Validate parameters
  if (tool.parameters && typeof tool.parameters === 'object') {
    for (const [key, param] of Object.entries(tool.parameters)) {
      const p = param as Record<string, unknown>;
      if (typeof p.type !== 'string') {
        add('INVALID_PARAMETER' as SkillValidationError, `Parameter "${key}" must have a type`, `tool.parameters.${key}`);
      }
    }
  }

  // Validate permissions
  if (s.permissions && Array.isArray(s.permissions)) {
    for (let i = 0; i < s.permissions.length; i++) {
      const p = s.permissions[i] as Record<string, unknown>;
      if (typeof p !== 'object' || (!p.network && !p['browser-api'] && !p.description)) {
        add('INVALID_PERMISSION' as SkillValidationError, `Permission at index ${i} must have network, browser-api, or description`, `permissions[${i}]`);
      }
    }
  }

  // Warnings for best practices
  if (!s.description) warn('Skill is missing a description');
  if (!s.tags || (Array.isArray(s.tags) && s.tags.length === 0)) warn('Skill has no tags — harder to discover');
  if (!tool.retry && tool.type === 'rest') warn('REST tool has no retry config — network failures will not be retried');

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/** Quick check if something looks like a valid skill definition */
export function isSkillDefinition(obj: unknown): obj is SkillDefinition {
  return validateSkill(obj).valid;
}
