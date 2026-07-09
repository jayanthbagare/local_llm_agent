// ── Built-in Skills ──
// Ready-to-use skill definitions bundled with the SDK. Enable them via
// `createAgent({ skills: ['web-search', 'file-read', ...] })` or register
// them manually with a SkillStore / NanoAgent.

import type { SkillDefinition } from './types';

/**
 * Web search backed by Wikipedia's CORS-enabled search API. Returns real,
 * usable snippets (the DuckDuckGo Instant Answer API returns almost nothing for
 * general queries and is not a real search). No API key required.
 */
export const webSearchSkill: SkillDefinition = {
  id: 'web-search',
  name: 'Web Search',
  version: '2.0.0',
  description:
    'Search the web (Wikipedia-backed) and return the most relevant article snippets. Use this to look up facts, definitions, and figures.',
  author: 'local-llm-agent',
  license: 'MIT',
  tags: ['search', 'web', 'retrieval', 'knowledge', 'wikipedia'],
  trigger: {
    keywords: ['search', 'find online', 'look up', 'google', 'web search', 'internet'],
    patterns: ['search for {query}', 'find information about {query}'],
  },
  tool: {
    type: 'rest',
    method: 'GET',
    url: 'https://en.wikipedia.org/w/api.php',
    queryParams: {
      action: 'query',
      list: 'search',
      srsearch: '{{query}}',
      srlimit: '5',
      format: 'json',
      origin: '*',
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
    // Produce a single readable text block (the template engine has no loops).
    transform: `
      const hits = (response.query && response.query.search) || [];
      if (hits.length === 0) return { text: 'No results found.' };
      const strip = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
      const lines = hits.slice(0, 5).map((h, i) =>
        (i + 1) + '. ' + h.title + ' — ' + strip(h.snippet) +
        ' (https://en.wikipedia.org/wiki/' + encodeURIComponent(h.title.replace(/ /g, '_')) + ')'
      );
      return { text: lines.join('\\n') };
    `,
    retry: { maxAttempts: 2, backoff: 'exponential', baseDelay: 800 },
  },
  resultTemplate: `Search results:\n{{text}}`,
  permissions: [
    { network: 'en.wikipedia.org' },
    { description: 'Query Wikipedia to retrieve web results' },
  ],
};

/**
 * Read a specific Wikipedia page's plain-text extract (intro + body). Use when
 * the user names a page ("the Wikipedia page for X") or you need exact figures.
 * CORS-safe via origin=*.
 */
export const wikipediaSkill: SkillDefinition = {
  id: 'wikipedia',
  name: 'Wikipedia Lookup',
  version: '1.0.0',
  description:
    'Fetch text from a specific Wikipedia article by title. Pass an optional "find" keyword (e.g. "perigee") to get the passages around that term. Use to read exact facts/figures from a named page (e.g. the Moon, Eliud Kipchoge).',
  author: 'local-llm-agent',
  license: 'MIT',
  tags: ['wikipedia', 'reference', 'retrieval', 'facts'],
  trigger: {
    keywords: ['wikipedia', 'wiki page', 'article about'],
    patterns: ['the wikipedia page for {title}', 'look up {title} on wikipedia'],
  },
  tool: {
    type: 'rest',
    method: 'GET',
    url: 'https://en.wikipedia.org/w/api.php',
    queryParams: {
      action: 'query',
      prop: 'extracts',
      titles: '{{title}}',
      explaintext: '1',
      redirects: '1',
      format: 'json',
      origin: '*',
    },
    headers: { Accept: 'application/json' },
    parameters: {
      title: {
        type: 'string',
        description: 'Exact Wikipedia article title, e.g. "Moon" or "Eliud Kipchoge"',
        required: true,
      },
      find: {
        type: 'string',
        description:
          'Optional keyword to locate (e.g. "perigee"). If given, returns the passages around each match instead of the article start.',
      },
      maxChars: {
        type: 'number',
        description: 'Max characters of article text to return (default 4000)',
      },
    },
    transform: `
      const pages = (response.query && response.query.pages) || {};
      const page = Object.values(pages)[0] || {};
      let text = page.extract || '';
      if (!text) return { title: page.title || '', text: 'Page not found or empty.' };
      const limit = (args && Number(args.maxChars)) > 0 ? Number(args.maxChars) : 4000;
      const find = args && args.find ? String(args.find) : '';
      if (find) {
        // Return windows of context around each occurrence of the keyword.
        const lower = text.toLowerCase();
        const needle = find.toLowerCase();
        const windows = [];
        let from = 0;
        while (windows.length < 5) {
          const idx = lower.indexOf(needle, from);
          if (idx < 0) break;
          const start = Math.max(0, idx - 300);
          const end = Math.min(text.length, idx + 300);
          windows.push('…' + text.slice(start, end).trim() + '…');
          from = idx + needle.length;
        }
        if (windows.length > 0) {
          return { title: page.title || '', text: windows.join('\\n\\n') };
        }
        // Keyword not found — fall through to the article start.
      }
      const truncated = text.length > limit;
      return { title: page.title || '', text: text.slice(0, limit) + (truncated ? '\\n…[truncated]' : '') };
    `,
    retry: { maxAttempts: 2, backoff: 'exponential', baseDelay: 800 },
  },
  resultTemplate: `Wikipedia: {{title}}\n{{text}}`,
  permissions: [
    { network: 'en.wikipedia.org' },
    { description: 'Read Wikipedia article text' },
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
  wikipediaSkill,
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
