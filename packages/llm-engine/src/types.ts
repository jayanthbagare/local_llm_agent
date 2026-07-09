// ── LLM Engine Types ──
// Shared type definitions for the inference engine.

/** Role in a chat conversation */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/** A single chat message */
export interface Message {
  role: MessageRole;
  content: string;
  name?: string;
  toolCallId?: string;
}

/** Model loading progress */
export interface LoadProgress {
  status: 'downloading' | 'loading' | 'ready' | 'error';
  bytesDownloaded?: number;
  totalBytes?: number;
  message?: string;
}

/** Options for loading a model */
export interface LoadOptions {
  modelId: string;
  modelUrl?: string;
  device?: 'webgpu' | 'wasm' | 'auto';
  cache?: boolean;
  onProgress?: (p: LoadProgress) => void;
  /**
   * Load model files from your own origin instead of the HuggingFace hub.
   * When set, transformers.js resolves files under `<localModelPath>/<modelId>/`.
   * Files are still cached in the browser's Cache Storage on first load, so
   * subsequent visits require no network at all.
   * e.g. `local: true, localModelPath: '/models/'`
   */
  local?: boolean;
  /** Base path (on the current origin) that holds self-hosted model folders. */
  localModelPath?: string;
  /** Explicit dtype override (e.g. 'q4f16', 'q4', 'fp16', 'int8'). */
  dtype?: string;
}

/** Tool definition for function calling */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** A parsed tool call from model output */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Options for text generation */
export interface GenerateOptions {
  messages?: Message[];
  prompt?: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  seed?: number;
  onToken?: (token: string) => void;
  tools?: ToolDefinition[];
}

/** A single generated token */
export interface Token {
  text: string;
  logProb?: number;
  special?: boolean;
}

/** Complete generation result */
export interface GenerateResult {
  text: string;
  tokens: Token[];
  finishReason: 'stop' | 'length' | 'tool_calls' | 'error';
  toolCalls?: ToolCall[];
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/** Model information */
export interface ModelInfo {
  id: string;
  name: string;
  contextLength: number;
  isLoaded: boolean;
  device: 'webgpu' | 'wasm' | 'none';
  memoryUsage?: string;
}

/** The LLM Engine interface */
export interface LLMEngine {
  load(options: LoadOptions): Promise<void>;
  isLoaded(): boolean;
  getModelInfo(): ModelInfo | null;
  generate(options: GenerateOptions): Promise<GenerateResult>;
  generateStream(options: GenerateOptions): AsyncIterable<Token>;
  countTokens(text: string): number;
  unload(): Promise<void>;
  abort(): void;
}
