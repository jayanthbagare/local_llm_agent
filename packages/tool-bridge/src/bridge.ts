// ── Tool Bridge ──
// Executes tool calls from the agent.
// Supports REST APIs, sandboxed JS functions, browser APIs, and MCP servers.

import type { SkillTool } from '@local-llm-agent/skill-store';

/** Arguments passed to a tool */
export type ToolArgs = Record<string, unknown>;

/** Result of a tool execution */
export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  /** Execution time in milliseconds */
  duration: number;
}

/** A transport handler that executes a specific type of tool */
export interface TransportHandler {
  execute(tool: SkillTool, args: ToolArgs, signal?: AbortSignal): Promise<unknown>;
}

/** ToolBridge: dispatches tool calls to the right transport */
export class ToolBridge {
  private transports = new Map<string, TransportHandler>();
  private abortController: AbortController | null = null;

  constructor() {
    // Register built-in transports
    this.registerTransport('rest', new RestTransport());
    this.registerTransport('function', new FunctionTransport());
    this.registerTransport('browser-api', new BrowserApiTransport());
    this.registerTransport('mcp', new MCPTransport());
  }

  /** Register a custom transport handler */
  registerTransport(type: string, handler: TransportHandler): void {
    this.transports.set(type, handler);
  }

  /** Get a registered transport handler (e.g. to configure it). */
  getTransport(type: string): TransportHandler | undefined {
    return this.transports.get(type);
  }

  /**
   * Pre-authorize a directory for the file-system tools. Call this from a user
   * gesture (e.g. a button's click handler) with the handle returned by
   * `showDirectoryPicker()`, so file tools don't need to prompt mid-run.
   */
  setFileSystemRoot(handle: unknown): void {
    const t = this.transports.get('browser-api');
    if (t instanceof BrowserApiTransport) t.setRootDir(handle);
  }

  /** Execute a tool and return the result */
  async execute(tool: SkillTool, args: ToolArgs): Promise<ToolResult> {
    const start = performance.now();
    this.abortController = new AbortController();

    try {
      const handler = this.transports.get(tool.type);
      if (!handler) {
        return {
          success: false,
          error: `Unknown tool type: ${tool.type}. Supported: ${[...this.transports.keys()].join(', ')}`,
          duration: performance.now() - start,
        };
      }

      const rawResult = await handler.execute(tool, args, this.abortController.signal);

      // Apply transform if defined
      const data = tool.transform ? await this._applyTransform(tool.transform, rawResult, args) : rawResult;

      return {
        success: true,
        data,
        duration: performance.now() - start,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        duration: performance.now() - start,
      };
    }
  }

  /** Apply a result template to format output for the LLM */
  applyTemplate(template: string, data: unknown, args: ToolArgs): string {
    return this._renderTemplate(template, { ...(data as Record<string, unknown> || {}), ...args });
  }

  /** Abort current execution */
  abort(): void {
    this.abortController?.abort();
  }

  // ── Private ──

  private async _applyTransform(code: string, response: unknown, args: ToolArgs): Promise<unknown> {
    // Execute transform in a sandboxed context
    // In browser, this would run in a WebWorker; here we use a restricted Function
    try {
      const fn = new Function('response', 'args', `"use strict"; ${code}`);
      return fn(response, args);
    } catch (err) {
      throw new Error(`Transform error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private _renderTemplate(template: string, data: Record<string, unknown>): string {
    // Simple Mustache-style template rendering
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
      const val = data[key];
      if (val === undefined || val === null) return '';
      return String(val);
    });
  }
}

// ── REST Transport ──

export class RestTransport implements TransportHandler {
  async execute(tool: SkillTool, args: ToolArgs, signal?: AbortSignal): Promise<unknown> {
    if (!tool.url) throw new Error('REST tool requires a URL');

    let url = this._interpolate(tool.url, args);
    // Allow the caller (model) to override the HTTP method via args.method.
    const method = String(args.method || tool.method || 'GET').toUpperCase();
    const headers: Record<string, string> = { ...(tool.headers || {}) };

    // Build query params
    if (tool.queryParams) {
      const searchParams = new URLSearchParams();
      for (const [key, value] of Object.entries(tool.queryParams)) {
        searchParams.append(key, this._interpolate(value, args));
      }
      const qs = searchParams.toString();
      if (qs) url += (url.includes('?') ? '&' : '?') + qs;
    }

    const fetchOptions: RequestInit = {
      method,
      headers,
      signal,
    };

    // Add body for non-GET methods. Prefer an explicit args.body (string),
    // otherwise fall back to the tool's templated body object.
    if (method !== 'GET' && method !== 'HEAD') {
      if (typeof args.body === 'string' && args.body.length > 0) {
        headers['Content-Type'] = headers['Content-Type'] || 'application/json';
        fetchOptions.body = args.body;
      } else if (tool.body) {
        headers['Content-Type'] = headers['Content-Type'] || 'application/json';
        fetchOptions.body = JSON.stringify(this._interpolateValues(tool.body, args));
      }
    }

    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return response.json();
    }
    return response.text();
  }

  private _interpolate(template: string, args: ToolArgs): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => String(args[key] ?? ''));
  }

  private _interpolateValues(obj: Record<string, unknown>, args: ToolArgs): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string') {
        result[key] = this._interpolate(value, args);
      } else {
        result[key] = value;
      }
    }
    return result;
  }
}

// ── Function Transport (sandboxed JS) ──

export class FunctionTransport implements TransportHandler {
  async execute(tool: SkillTool, args: ToolArgs, _signal?: AbortSignal): Promise<unknown> {
    if (!tool.execute) throw new Error('Function tool requires execute code');

    // Run in restricted context
    // NOTE: In production, this should run in a WebWorker with CSP
    const allowedGlobals: Record<string, unknown> = {
      // Math functions
      abs: Math.abs, acos: Math.acos, asin: Math.asin, atan: Math.atan,
      atan2: Math.atan2, ceil: Math.ceil, cos: Math.cos, exp: Math.exp,
      floor: Math.floor, log: Math.log, log10: Math.log10, log2: Math.log2,
      max: Math.max, min: Math.min, pow: Math.pow, round: Math.round,
      sin: Math.sin, sqrt: Math.sqrt, tan: Math.tan, trunc: Math.trunc,
      PI: Math.PI, E: Math.E,
      // Utilities
      parseInt, parseFloat, isNaN, isFinite,
      JSON: { stringify: JSON.stringify, parse: JSON.parse },
      Date,
      Math,
      // Arguments
      params: args,
      args,
    };

    const keys = Object.keys(allowedGlobals);
    const values = Object.values(allowedGlobals);

    try {
      const fn = new Function(...keys, `"use strict"; ${tool.execute}`);
      return fn(...values);
    } catch (err) {
      throw new Error(`Function execution error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ── Browser API Transport ──

/** Minimal subset of the File System Access API types we rely on. */
interface FSFileHandle {
  kind: 'file';
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
}
interface FSDirHandle {
  kind: 'directory';
  name: string;
  entries(): AsyncIterable<[string, FSFileHandle | FSDirHandle]>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FSFileHandle>;
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FSDirHandle>;
  removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void>;
}

export class BrowserApiTransport implements TransportHandler {
  /** Cached root directory the user granted access to (File System Access API). */
  private rootDir: FSDirHandle | null = null;

  /** Pre-set the granted directory handle (from a user-gesture picker call). */
  setRootDir(handle: unknown): void {
    this.rootDir = (handle as FSDirHandle) ?? null;
  }

  async execute(tool: SkillTool, args: ToolArgs, _signal?: AbortSignal): Promise<unknown> {
    const api = tool.api;
    if (!api) throw new Error('browser-api tool requires an api name');

    switch (api) {
      case 'clipboard':
        return this._clipboard(args);
      case 'geolocation':
        return this._geolocation();
      case 'notification':
        return this._notification(args);
      case 'calendar':
        return this._calendar(args);
      case 'file-system':
        return this._fileSystem(args);
      default:
        throw new Error(`Unknown browser API: ${api}`);
    }
  }

  private async _clipboard(args: ToolArgs): Promise<unknown> {
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      throw new Error('Clipboard API not available');
    }
    const action = args.action as string;
    if (action === 'read') {
      return navigator.clipboard.readText();
    }
    if (action === 'write') {
      await navigator.clipboard.writeText(args.text as string);
      return { written: true };
    }
    throw new Error(`Unknown clipboard action: ${action}`);
  }

  private async _geolocation(): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!navigator?.geolocation) {
        reject(new Error('Geolocation not available'));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        }),
        (err) => reject(new Error(`Geolocation error: ${err.message}`)),
      );
    });
  }

  private async _notification(args: ToolArgs): Promise<unknown> {
    if (typeof Notification === 'undefined') {
      throw new Error('Notifications API not available');
    }
    if (Notification.permission === 'denied') {
      throw new Error('Notification permission denied');
    }
    if (Notification.permission !== 'granted') {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') throw new Error('Notification permission not granted');
    }
    new Notification(args.title as string, {
      body: args.body as string,
      icon: args.icon as string,
    });
    return { notified: true };
  }

  private _calendar(args: ToolArgs): unknown {
    // In a real implementation, this uses the browser's Calendar API
    // or Google Calendar API. For now, return mock data.
    return {
      action: args.action,
      events: [
        { id: '1', title: 'Team standup', start: '09:00', end: '09:30' },
        { id: '2', title: 'Lunch', start: '12:00', end: '13:00' },
      ],
    };
  }

  private async _fileSystem(args: ToolArgs): Promise<unknown> {
    const action = String(args.action || 'read');
    const rawPath = String(args.path ?? '').replace(/^\.?\//, '');

    // ── Read/write/list/glob against a user-granted directory ──
    // Uses the File System Access API. The first call prompts the user to pick
    // a directory; the handle is cached for subsequent calls in this session.
    const dir = await this._getRootDir();

    switch (action) {
      case 'read': {
        const handle = await this._resolveFile(dir, rawPath, false);
        const file = await handle.getFile();
        const text = await file.text();
        const MAX = 50000;
        return {
          action,
          path: rawPath,
          content: text.slice(0, MAX),
          truncated: text.length > MAX,
          size: file.size,
        };
      }
      case 'write': {
        const handle = await this._resolveFile(dir, rawPath, true);
        const writable = await handle.createWritable();
        const content = String(args.content ?? '');
        await writable.write(content);
        await writable.close();
        return { action, path: rawPath, written: true, size: content.length };
      }
      case 'list': {
        const target = rawPath ? await this._resolveDir(dir, rawPath, false) : dir;
        const files: { name: string; type: string }[] = [];
        for await (const [name, entry] of target.entries()) {
          files.push({ name, type: entry.kind });
        }
        return { action, path: rawPath || '.', files, count: files.length };
      }
      case 'glob': {
        const pattern = String(args.pattern ?? args.path ?? '*');
        const matches = await this._glob(dir, pattern);
        return { action, pattern, matches, count: matches.length };
      }
      case 'delete': {
        const segments = rawPath.split('/').filter(Boolean);
        const name = segments.pop()!;
        const parent = segments.length
          ? await this._resolveDir(dir, segments.join('/'), false)
          : dir;
        await parent.removeEntry(name, { recursive: true });
        return { action, path: rawPath, deleted: true };
      }
      default:
        throw new Error(`Unknown file-system action: ${action}`);
    }
  }

  private async _getRootDir(): Promise<FSDirHandle> {
    if (this.rootDir) return this.rootDir;
    const picker = (globalThis as unknown as {
      showDirectoryPicker?: (opts?: { mode?: string }) => Promise<FSDirHandle>;
    }).showDirectoryPicker;
    if (typeof picker !== 'function') {
      throw new Error(
        'File System Access API is unavailable. Use Chrome/Edge over HTTPS or localhost.',
      );
    }
    // Requires a user gesture; the agent call chain must originate from one.
    this.rootDir = await picker({ mode: 'readwrite' });
    return this.rootDir;
  }

  /** Walk a slash-separated path down to its containing directory + file. */
  private async _resolveFile(root: FSDirHandle, path: string, create: boolean): Promise<FSFileHandle> {
    const segments = path.split('/').filter(Boolean);
    if (segments.length === 0) throw new Error('Empty file path');
    const name = segments.pop()!;
    let cur = root;
    for (const seg of segments) {
      cur = await cur.getDirectoryHandle(seg, { create });
    }
    return cur.getFileHandle(name, { create });
  }

  private async _resolveDir(root: FSDirHandle, path: string, create: boolean): Promise<FSDirHandle> {
    const segments = path.split('/').filter(Boolean);
    let cur = root;
    for (const seg of segments) {
      cur = await cur.getDirectoryHandle(seg, { create });
    }
    return cur;
  }

  /** Recursively match files against a glob pattern (supports ** / * / ?). */
  private async _glob(root: FSDirHandle, pattern: string): Promise<string[]> {
    const re = globToRegExp(pattern);
    const results: string[] = [];
    const MAX = 500;
    const walk = async (dir: FSDirHandle, prefix: string): Promise<void> => {
      if (results.length >= MAX) return;
      for await (const [name, entry] of dir.entries()) {
        const rel = prefix ? `${prefix}/${name}` : name;
        if (entry.kind === 'directory') {
          await walk(entry as FSDirHandle, rel);
        } else if (re.test(rel)) {
          results.push(rel);
          if (results.length >= MAX) return;
        }
      }
    };
    await walk(root, '');
    return results;
  }
}

/** Convert a glob pattern to a RegExp. Supports **, *, ? and literal segments. */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++; // consume trailing slash of **/
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`, 'i');
}

// ── MCP Transport ──

export class MCPTransport implements TransportHandler {
  async execute(tool: SkillTool, args: ToolArgs, signal?: AbortSignal): Promise<unknown> {
    // Resolve the server URL and tool name, allowing {{templates}} filled from
    // args (so a generic `mcp-call` skill can target any server/tool).
    const interp = (s: string | undefined): string =>
      (s || '').replace(/\{\{(\w+)\}\}/g, (_, k) => String(args[k] ?? ''));

    const url = interp(tool.server?.url) || String(args.serverUrl || '');
    const toolName = interp(tool.toolName) || String(args.toolName || '');
    if (!url) throw new Error('MCP tool requires a server URL (serverUrl)');
    if (!toolName) throw new Error('MCP tool requires a toolName');

    // Build the arguments payload. A generic mcp-call passes them as a JSON
    // string in args.arguments; otherwise forward the remaining args as-is.
    let toolArgs: unknown = args;
    if (typeof args.arguments === 'string') {
      try {
        toolArgs = JSON.parse(args.arguments || '{}');
      } catch {
        throw new Error('mcp-call "arguments" must be a valid JSON string');
      }
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: toolArgs,
        },
        id: Date.now(),
      }),
      signal,
    });

    if (!response.ok) {
      throw new Error(`MCP server error: ${response.status}`);
    }

    const data = await response.json();

    if (data.error) {
      throw new Error(`MCP error: ${data.error.message || JSON.stringify(data.error)}`);
    }

    return data.result;
  }
}

/** Create a ToolBridge with default transports */
export function createToolBridge(): ToolBridge {
  return new ToolBridge();
}
