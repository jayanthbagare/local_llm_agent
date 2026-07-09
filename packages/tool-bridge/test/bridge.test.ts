// ── Tool Bridge Tests ──
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolBridge, RestTransport, FunctionTransport, BrowserApiTransport, MCPTransport, createToolBridge } from '../src/bridge';
import type { SkillTool } from '../../skill-store/src/types.js';

// ── Sample tool definitions ──

const restTool: SkillTool = {
  type: 'rest',
  method: 'GET',
  url: 'https://api.example.com/data?q={{query}}',
  headers: { Accept: 'application/json' },
  parameters: {
    query: { type: 'string', description: 'Query', required: true },
  },
  retry: { maxAttempts: 2 },
};

const functionTool: SkillTool = {
  type: 'function',
  execute: 'return params.a + params.b;',
  parameters: {
    a: { type: 'number', description: 'First number', required: true },
    b: { type: 'number', description: 'Second number', required: true },
  },
};

const functionWithTransformTool: SkillTool = {
  type: 'function',
  execute: 'return { sum: params.a + params.b };',
  transform: 'return response.sum * 2;',
  parameters: {
    a: { type: 'number', description: 'First number' },
    b: { type: 'number', description: 'Second number' },
  },
};

// ── ToolBridge Tests ──

describe('ToolBridge', () => {
  let bridge: ToolBridge;

  beforeEach(() => {
    bridge = new ToolBridge();
  });

  describe('execute', () => {
    it('executes a function tool', async () => {
      const result = await bridge.execute(functionTool, { a: 5, b: 3 });
      expect(result.success).toBe(true);
      expect(result.data).toBe(8);
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('executes a function tool with transform', async () => {
      const result = await bridge.execute(functionWithTransformTool, { a: 5, b: 3 });
      expect(result.success).toBe(true);
      expect(result.data).toBe(16); // (5+3)*2
    });

    it('returns error for unknown tool type', async () => {
      const result = await bridge.execute({ type: 'unknown' } as any, {});
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown tool type');
    });

    it('returns error for function execution failure', async () => {
      const badTool: SkillTool = {
        type: 'function',
        execute: 'throw new Error("boom");',
      };
      const result = await bridge.execute(badTool, {});
      expect(result.success).toBe(false);
      expect(result.error).toContain('boom');
    });
  });

  describe('applyTemplate', () => {
    it('renders a mustache-style template', () => {
      const result = bridge.applyTemplate(
        'Results for {{query}}: {{count}} items',
        { count: 5 },
        { query: 'test' },
      );
      expect(result).toBe('Results for test: 5 items');
    });

    it('handles missing values', () => {
      const result = bridge.applyTemplate(
        '{{a}} and {{missing}}',
        {},
        {},
      );
      expect(result).toBe(' and ');
    });
  });

  describe('custom transports', () => {
    it('supports registering custom transport', async () => {
      bridge.registerTransport('custom', {
        execute: async (_tool, args) => {
          return { handled: true, args };
        },
      });

      const result = await bridge.execute(
        { type: 'custom' } as SkillTool,
        { x: 1 },
      );
      expect(result.success).toBe(true);
      expect((result.data as any).handled).toBe(true);
    });
  });
});

// ── Function Transport Tests ──

describe('FunctionTransport', () => {
  const transport = new FunctionTransport();

  it('executes simple math', async () => {
    const result = await transport.execute(
      { type: 'function', execute: 'return params.x * 2;' },
      { x: 21 },
    );
    expect(result).toBe(42);
  });

  it('has access to Math functions', async () => {
    const result = await transport.execute(
      { type: 'function', execute: 'return Math.sqrt(params.n);' },
      { n: 16 },
    );
    expect(result).toBe(4);
  });

  it('has access to JSON', async () => {
    const result = await transport.execute(
      { type: 'function', execute: 'return JSON.stringify({ a: params.val });' },
      { val: 42 },
    );
    expect(result).toBe('{"a":42}');
  });

  it('handles errors', async () => {
    await expect(
      transport.execute(
        { type: 'function', execute: 'throw new Error("fail");' },
        {},
      ),
    ).rejects.toThrow('fail');
  });

  it('rejects missing execute code', async () => {
    await expect(
      transport.execute({ type: 'function' }, {}),
    ).rejects.toThrow('requires execute code');
  });
});

// ── REST Transport Tests ──

describe('RestTransport', () => {
  const transport = new RestTransport();

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('interpolates URL parameters', async () => {
    // Mock fetch
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => 'application/json' },
      json: () => Promise.resolve({ data: 'test' }),
    } as any);

    const result = await transport.execute(restTool, { query: 'hello' });
    expect(fetch).toHaveBeenCalledWith(
      'https://api.example.com/data?q=hello',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(result).toEqual({ data: 'test' });
  });

  it('handles HTTP errors', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      headers: { get: () => 'text/plain' },
    } as any);

    await expect(
      transport.execute(restTool, { query: 'test' }),
    ).rejects.toThrow('404');
  });

  it('rejects missing URL', async () => {
    await expect(
      transport.execute({ type: 'rest', method: 'GET' }, {}),
    ).rejects.toThrow('requires a URL');
  });
});

// ── MCP Transport Tests ──

describe('MCPTransport', () => {
  const transport = new MCPTransport();

  it('rejects missing server URL', async () => {
    await expect(
      transport.execute({ type: 'mcp', toolName: 'test' }, {}),
    ).rejects.toThrow('requires a server URL');
  });

  it('rejects missing toolName', async () => {
    await expect(
      transport.execute({ type: 'mcp', server: { transport: 'sse', url: 'http://localhost' } }, {}),
    ).rejects.toThrow('requires a toolName');
  });
});

// ── Browser API Transport Tests ──

describe('BrowserApiTransport', () => {
  const transport = new BrowserApiTransport();

  it('rejects unknown API', async () => {
    await expect(
      transport.execute({ type: 'browser-api', api: 'nonexistent' }, {}),
    ).rejects.toThrow('Unknown browser API');
  });

  it('rejects missing api name', async () => {
    await expect(
      transport.execute({ type: 'browser-api' }, {}),
    ).rejects.toThrow('requires an api name');
  });

  it('returns calendar mock data', async () => {
    const result = await transport.execute(
      { type: 'browser-api', api: 'calendar' },
      { action: 'list' },
    );
    expect(result).toHaveProperty('events');
    expect((result as any).events).toHaveLength(2);
  });
});

// ── Factory Test ──

describe('createToolBridge', () => {
  it('creates a bridge with default transports', () => {
    const bridge = createToolBridge();
    expect(bridge).toBeInstanceOf(ToolBridge);
  });
});
