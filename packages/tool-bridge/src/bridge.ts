// ── Tool Bridge ──
// Executes tool calls from the agent.
// Supports REST APIs, sandboxed JS functions, browser APIs, and MCP servers.

import type { SkillTool } from '../../skill-store/src/types.js';

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
    const method = tool.method || 'GET';
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

    // Add body for non-GET methods
    if (method !== 'GET' && tool.body) {
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      fetchOptions.body = JSON.stringify(this._interpolateValues(tool.body, args));
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

export class BrowserApiTransport implements TransportHandler {
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

  private _fileSystem(args: ToolArgs): unknown {
    // File System Access API — requires user gesture in browser
    return {
      action: args.action,
      path: args.path,
      note: 'File System Access API requires user interaction in browser',
    };
  }
}

// ── MCP Transport ──

export class MCPTransport implements TransportHandler {
  async execute(tool: SkillTool, args: ToolArgs, signal?: AbortSignal): Promise<unknown> {
    if (!tool.server?.url) throw new Error('MCP tool requires server URL');
    if (!tool.toolName) throw new Error('MCP tool requires toolName');

    // MCP SSE protocol: connect to server, send tool call, receive result
    const url = tool.server.url;

    // Open SSE connection
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
          name: tool.toolName,
          arguments: args,
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
