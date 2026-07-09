// ── Built-in Skills ──
// Ready-to-use skill definitions bundled with the SDK. Enable them via
// `createAgent({ skills: ['web-search', 'file-read', ...] })` or register
// them manually with a SkillStore / NanoAgent.

import type { SkillDefinition } from './types';

/**
 * Web search via DuckDuckGo's Instant Answer API (no API key required).
 * Returns structured top results for the model to reason over.
 */
export const webSearchSkill: SkillDefinition = {
  id: 'web-search',
  name: 'Web Search',
  version: '1.2.0',
  description: 'Search the web using DuckDuckGo and return top results as structured snippets.',
  author: 'local-llm-agent',
  license: 'MIT',
  tags: ['search', 'web', 'retrieval', 'knowledge'],
  trigger: {
    keywords: ['search', 'find online', 'look up', 'google', 'web search', 'internet'],
    patterns: ['search for {query}', 'find information about {query}'],
  },
  tool: {
    type: 'rest',
    method: 'GET',
    url: 'https://api.duckduckgo.com/',
    queryParams: {
      q: '{{query}}',
      format: 'json',
      no_html: '1',
      skip_disambig: '1',
    },
    headers: { Accept: 'application/json' },
    parameters: {
      query: {
        type: 'string',
        description: 'The search query string',
        required: true,
        maxLength: 300,
      },
    },
    transform: `
      const out = [];
      if (response.AbstractText) {
        out.push({ title: response.Heading || 'Summary', snippet: response.AbstractText, url: response.AbstractURL || '' });
      }
      const topics = response.RelatedTopics || [];
      for (const r of topics) {
        if (out.length >= 6) break;
        if (r.Text && r.FirstURL) {
          const parts = r.Text.split(' - ');
          out.push({
            title: parts.length > 1 ? parts[0] : r.Text.slice(0, 80),
            snippet: parts.length > 1 ? parts.slice(1).join(' - ') : '',
            url: r.FirstURL,
          });
        }
      }
      return { results: out };
    `,
    retry: { maxAttempts: 2, backoff: 'exponential', baseDelay: 800 },
  },
  resultTemplate: `Web search results for "{{query}}":
{{#each results}}
{{@index}}. {{title}} — {{snippet}} ({{url}})
{{/each}}`,
  permissions: [
    { network: 'api.duckduckgo.com' },
    { description: 'Send search queries to DuckDuckGo to retrieve web results' },
  ],
};

/**
 * Generic HTTP / API request tool. Lets the model call an arbitrary REST
 * endpoint (GET/POST/...). Useful as a flexible escape hatch for APIs.
 */
export const httpRequestSkill: SkillDefinition = {
  id: 'http-request',
  name: 'HTTP Request',
  version: '1.0.0',
  description: 'Make an HTTP request to a URL (GET/POST/PUT/DELETE) and return the JSON or text response. Use for calling REST APIs.',
  author: 'local-llm-agent',
  license: 'MIT',
  tags: ['http', 'api', 'rest', 'fetch', 'network'],
  trigger: {
    keywords: ['api', 'http', 'request', 'endpoint', 'fetch url', 'call api'],
    patterns: ['call the api at {url}', 'fetch {url}'],
  },
  tool: {
    type: 'rest',
    // The URL is provided by the model at call time via the {{url}} template.
    method: 'GET',
    url: '{{url}}',
    parameters: {
      url: {
        type: 'string',
        description: 'Full URL to request (must be http/https)',
        required: true,
      },
      method: {
        type: 'string',
        description: 'HTTP method',
        enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
        default: 'GET',
      },
      body: {
        type: 'string',
        description: 'Optional request body (JSON string) for POST/PUT/PATCH',
      },
    },
    transform: `
      const preview = typeof response === 'string'
        ? response.slice(0, 4000)
        : JSON.stringify(response).slice(0, 4000);
      return { data: response, preview };
    `,
    retry: { maxAttempts: 2, backoff: 'exponential', baseDelay: 500 },
  },
  resultTemplate: `HTTP response:
{{preview}}`,
  permissions: [
    { network: '*' },
    { description: 'Make outbound HTTP requests to URLs chosen by the model' },
  ],
};

/**
 * Read a file from a user-granted local directory (File System Access API).
 * The first use prompts the user to pick a folder; access is scoped to it.
 */
export const fileReadSkill: SkillDefinition = {
  id: 'file-read',
  name: 'Read File',
  version: '1.0.0',
  description: 'Read the contents of a file from a local folder the user has granted access to.',
  author: 'local-llm-agent',
  license: 'MIT',
  tags: ['files', 'fs', 'read'],
  trigger: {
    keywords: ['read file', 'open file', 'file contents', 'cat'],
    patterns: ['read the file {path}', 'show me {path}'],
  },
  tool: {
    type: 'browser-api',
    api: 'file-system',
    parameters: {
      action: { type: 'string', description: 'Fixed to "read"', enum: ['read'], default: 'read' },
      path: { type: 'string', description: 'Relative path of the file within the granted folder', required: true },
    },
  },
  resultTemplate: `File {{path}} ({{size}} bytes{{#if truncated}}, truncated{{/if}}):
{{content}}`,
  permissions: [{ 'browser-api': 'file-system' }, { description: 'Read files in a user-selected folder' }],
};

/** Write/create a file in the user-granted local directory. */
export const fileWriteSkill: SkillDefinition = {
  id: 'file-write',
  name: 'Write File',
  version: '1.0.0',
  description: 'Write content to a file in a local folder the user has granted access to (creates it if missing).',
  author: 'local-llm-agent',
  license: 'MIT',
  tags: ['files', 'fs', 'write'],
  trigger: {
    keywords: ['write file', 'save file', 'create file'],
    patterns: ['write {content} to {path}', 'save this to {path}'],
  },
  tool: {
    type: 'browser-api',
    api: 'file-system',
    parameters: {
      action: { type: 'string', description: 'Fixed to "write"', enum: ['write'], default: 'write' },
      path: { type: 'string', description: 'Relative path of the file to write', required: true },
      content: { type: 'string', description: 'Text content to write', required: true },
    },
  },
  resultTemplate: `Wrote {{size}} bytes to {{path}}.`,
  permissions: [{ 'browser-api': 'file-system' }, { description: 'Write files in a user-selected folder' }],
};

/**
 * Glob / list files in the user-granted local directory by pattern
 * (e.g. `**\/*.ts`, `src/*.js`).
 */
export const fileGlobSkill: SkillDefinition = {
  id: 'file-glob',
  name: 'Find Files (glob)',
  version: '1.0.0',
  description: 'Find files matching a glob pattern (e.g. "**/*.ts", "src/*.md") within a user-granted local folder.',
  author: 'local-llm-agent',
  license: 'MIT',
  tags: ['files', 'fs', 'glob', 'search', 'list'],
  trigger: {
    keywords: ['glob', 'find files', 'list files', 'search files'],
    patterns: ['find files matching {pattern}', 'list all {pattern} files'],
  },
  tool: {
    type: 'browser-api',
    api: 'file-system',
    parameters: {
      action: { type: 'string', description: 'Fixed to "glob"', enum: ['glob'], default: 'glob' },
      pattern: { type: 'string', description: 'Glob pattern, e.g. "**/*.ts"', required: true },
    },
  },
  resultTemplate: `Found {{count}} file(s) matching "{{pattern}}":
{{#each matches}}
- {{this}}
{{/each}}`,
  permissions: [{ 'browser-api': 'file-system' }, { description: 'List files in a user-selected folder' }],
};

/**
 * Call a tool exposed by an MCP (Model Context Protocol) server over HTTP/SSE.
 */
export const mcpCallSkill: SkillDefinition = {
  id: 'mcp-call',
  name: 'MCP Tool Call',
  version: '1.0.0',
  description: 'Invoke a named tool on a Model Context Protocol (MCP) server and return its result.',
  author: 'local-llm-agent',
  license: 'MIT',
  tags: ['mcp', 'tools', 'protocol', 'integration'],
  trigger: {
    keywords: ['mcp', 'tool server', 'run tool'],
  },
  tool: {
    type: 'mcp',
    server: { transport: 'sse', url: '{{serverUrl}}' },
    toolName: '{{toolName}}',
    parameters: {
      serverUrl: { type: 'string', description: 'MCP server URL (SSE endpoint)', required: true },
      toolName: { type: 'string', description: 'Name of the MCP tool to invoke', required: true },
      arguments: { type: 'string', description: 'JSON string of arguments for the tool', default: '{}' },
    },
    transform: `
      return { result: response, preview: JSON.stringify(response).slice(0, 4000) };
    `,
  },
  resultTemplate: `MCP tool result:
{{preview}}`,
  permissions: [{ network: '*' }, { description: 'Call tools on an MCP server' }],
};

/** All built-in skills, keyed by id. */
export const BUILTIN_SKILLS: SkillDefinition[] = [
  webSearchSkill,
  httpRequestSkill,
  fileReadSkill,
  fileWriteSkill,
  fileGlobSkill,
  mcpCallSkill,
];

/** Look up a built-in skill definition by id. */
export function getBuiltinSkill(id: string): SkillDefinition | undefined {
  return BUILTIN_SKILLS.find((s) => s.id === id);
}
