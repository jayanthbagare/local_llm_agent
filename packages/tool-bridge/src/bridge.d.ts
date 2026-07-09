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
export declare class ToolBridge {
    private transports;
    private abortController;
    constructor();
    /** Register a custom transport handler */
    registerTransport(type: string, handler: TransportHandler): void;
    /** Execute a tool and return the result */
    execute(tool: SkillTool, args: ToolArgs): Promise<ToolResult>;
    /** Apply a result template to format output for the LLM */
    applyTemplate(template: string, data: unknown, args: ToolArgs): string;
    /** Abort current execution */
    abort(): void;
    private _applyTransform;
    private _renderTemplate;
}
export declare class RestTransport implements TransportHandler {
    execute(tool: SkillTool, args: ToolArgs, signal?: AbortSignal): Promise<unknown>;
    private _interpolate;
    private _interpolateValues;
}
export declare class FunctionTransport implements TransportHandler {
    execute(tool: SkillTool, args: ToolArgs, _signal?: AbortSignal): Promise<unknown>;
}
export declare class BrowserApiTransport implements TransportHandler {
    execute(tool: SkillTool, args: ToolArgs, _signal?: AbortSignal): Promise<unknown>;
    private _clipboard;
    private _geolocation;
    private _notification;
    private _calendar;
    private _fileSystem;
}
export declare class MCPTransport implements TransportHandler {
    execute(tool: SkillTool, args: ToolArgs, signal?: AbortSignal): Promise<unknown>;
}
/** Create a ToolBridge with default transports */
export declare function createToolBridge(): ToolBridge;
//# sourceMappingURL=bridge.d.ts.map