// ── Ollama Engine ──
// REAL local LLM inference via a locally running Ollama server
// (https://ollama.com), reached over plain HTTP fetch. This lets the agent
// use much larger/more capable models than can fit inside a browser's
// WASM/WebGPU memory ceiling (see packages/llm-engine/src/transformers.ts),
// at the cost of requiring a native Ollama process running on the same
// machine (default: http://localhost:11434).
//
// This is NOT a simulation: it streams real tokens from a real model served
// by `ollama serve`, using Ollama's `/api/chat` NDJSON streaming endpoint.

import type {
  LLMEngine,
  LoadOptions,
  GenerateOptions,
  GenerateResult,
  Token,
  ModelInfo,
  Message,
  ToolCall,
} from './types';
import { countTokens, countMessageTokens } from './tokenizer';

export interface OllamaEngineOptions {
  /** Base URL of the Ollama server. Defaults to http://localhost:11434. */
  baseUrl?: string;
  /** Ollama model tag to use, e.g. "llama3.2", "gemma4:e4b-mlx". */
  model?: string;
  /**
   * Some Ollama models (e.g. "thinking"-capable ones like gemma4) stream
   * their chain-of-thought in a separate `message.thinking` field and only
   * emit the final answer in `message.content` once reasoning is done. If
   * the model's thinking budget exceeds `maxTokens`, the response comes
   * back empty (finish reason "length") with no visible answer at all.
   * Defaults to `false` (disable extended thinking) so responses are fast
   * and always land in `content`. Set `true` to keep the model's default
   * thinking behavior (thinking tokens are currently not surfaced to the
   * agent — only the final `content` is used).
   */
  think?: boolean;
}

type OllamaChatMessage = { role: string; content: string };

type OllamaStreamChunk = {
  model?: string;
  message?: { role: string; content: string; thinking?: string };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
};

export class OllamaEngine implements LLMEngine {
  private _baseUrl: string;
  private _model: string | null;
  private _think: boolean;
  private _info: ModelInfo | null = null;
  private _abortController: AbortController | null = null;
  private _aborted = false;

  constructor(options: OllamaEngineOptions = {}) {
    this._baseUrl = (options.baseUrl ?? 'http://localhost:11434').replace(/\/$/, '');
    this._model = options.model ?? null;
    this._think = options.think ?? false;
  }

  async load(options: LoadOptions): Promise<void> {
    this._aborted = false;
    const model = options.modelUrl || this._model || options.modelId;
    if (!model) {
      throw new Error(
        'OllamaEngine.load(): no model specified. Pass a model tag via the ' +
          'constructor ({ model: "llama3.2" }) or LoadOptions.modelUrl.',
      );
    }

    options.onProgress?.({ status: 'loading', message: `Checking Ollama for "${model}"...` });

    let res: Response;
    try {
      res = await fetch(`${this._baseUrl}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      });
    } catch (err) {
      throw new Error(
        `Could not reach Ollama at ${this._baseUrl}. Is "ollama serve" running? ` +
          `(${(err as Error)?.message || err})`,
      );
    }

    if (!res.ok) {
      if (res.status === 404) {
        throw new Error(
          `Model "${model}" is not available on this Ollama server. Run ` +
            `"ollama pull ${model}" first, then reload.`,
        );
      }
      throw new Error(`Ollama /api/show failed: ${res.status} ${res.statusText}`);
    }

    const info = (await res.json().catch(() => ({}))) as {
      details?: { parameter_size?: string };
      model_info?: Record<string, unknown>;
    };

    this._model = model;
    const contextLength = this._guessContextLength(info.model_info);

    this._info = {
      id: model,
      name: model,
      contextLength,
      isLoaded: true,
      // Ollama's execution device (GPU/CPU/Metal) is opaque to this HTTP
      // client and irrelevant to the browser tab — the model runs in the
      // native Ollama process, not in-page.
      device: 'ollama',
      memoryUsage: info.details?.parameter_size
        ? `${info.details.parameter_size} params (served by Ollama)`
        : 'served by Ollama',
    };

    options.onProgress?.({ status: 'ready', message: `Ready (${model} via Ollama)` });
  }

  isLoaded(): boolean {
    return this._info?.isLoaded ?? false;
  }

  getModelInfo(): ModelInfo | null {
    return this._info;
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    const tokens: Token[] = [];
    let fullText = '';
    let usage: GenerateResult['usage'];

    for await (const token of this.generateStream(options)) {
      tokens.push(token);
      fullText += token.text;
    }

    // generateStream stashes the final usage numbers here once done.
    usage = this._lastUsage ?? undefined;

    const { cleanText, toolCalls } = this._parseToolCalls(fullText);

    return {
      text: cleanText || fullText,
      tokens,
      finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: usage ?? {
        promptTokens: this._countPrompt(options),
        completionTokens: tokens.length,
        totalTokens: this._countPrompt(options) + tokens.length,
      },
    };
  }

  async *generateStream(options: GenerateOptions): AsyncIterable<Token> {
    this._aborted = false;
    this._lastUsage = undefined;
    if (!this._model) throw new Error('No model loaded. Call load() first.');

    const messages = this._toChatMessages(options);
    this._abortController = new AbortController();

    let res: Response;
    try {
      res = await fetch(`${this._baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: this._abortController.signal,
        body: JSON.stringify({
          model: this._model,
          messages,
          stream: true,
          think: this._think,
          options: {
            temperature: options.temperature ?? 0.7,
            top_p: options.topP ?? 0.9,
            num_predict: options.maxTokens ?? 512,
            stop: options.stopSequences,
            seed: options.seed,
          },
        }),
      });
    } catch (err) {
      if (this._aborted) return;
      throw new Error(
        `Could not reach Ollama at ${this._baseUrl} (${(err as Error)?.message || err}).`,
      );
    }

    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => '');
      throw new Error(`Ollama /api/chat failed: ${res.status} ${res.statusText} ${body}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        if (this._aborted) break;
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);
          if (!line) continue;

          let chunk: OllamaStreamChunk;
          try {
            chunk = JSON.parse(line);
          } catch {
            continue; // ignore malformed/partial line
          }

          if (chunk.error) throw new Error(`Ollama error: ${chunk.error}`);

          const text = chunk.message?.content ?? '';
          if (text) {
            options.onToken?.(text);
            yield { text };
          }

          if (chunk.done) {
            this._lastUsage = {
              promptTokens: chunk.prompt_eval_count ?? 0,
              completionTokens: chunk.eval_count ?? 0,
              totalTokens: (chunk.prompt_eval_count ?? 0) + (chunk.eval_count ?? 0),
            };
          }
        }
      }
    } finally {
      reader.releaseLock?.();
    }
  }

  countTokens(text: string): number {
    // Ollama doesn't expose client-side tokenization; fall back to the
    // shared heuristic estimator used by SimulatedEngine. Real usage counts
    // (when available) come from the streamed response's
    // prompt_eval_count/eval_count fields instead (see generate()).
    return countTokens(text);
  }

  async unload(): Promise<void> {
    this._info = null;
  }

  abort(): void {
    this._aborted = true;
    this._abortController?.abort();
  }

  // ── Private ──

  private _lastUsage: GenerateResult['usage'] | undefined;

  private _toChatMessages(options: GenerateOptions): OllamaChatMessage[] {
    if (options.messages) {
      return options.messages.map((m: Message) => ({
        role: m.role === 'tool' ? 'user' : m.role,
        content:
          m.role === 'tool' ? `Tool result (${m.name ?? 'tool'}):\n${m.content}` : m.content,
      }));
    }
    const msgs: OllamaChatMessage[] = [];
    if (options.systemPrompt) msgs.push({ role: 'system', content: options.systemPrompt });
    if (options.prompt) msgs.push({ role: 'user', content: options.prompt });
    return msgs;
  }

  private _parseToolCalls(text: string): { cleanText: string; toolCalls: ToolCall[] } {
    const toolCalls: ToolCall[] = [];
    const re = /```(?:json|tool_call)?\s*\n?(\{[\s\S]*?\})\s*```/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      try {
        const parsed = JSON.parse(m[1]);
        if (parsed.name || parsed.tool || parsed.function) {
          toolCalls.push({
            id: `call_${Math.random().toString(36).slice(2, 9)}`,
            name: parsed.name || parsed.tool || parsed.function,
            arguments: parsed.arguments || parsed.args || parsed.parameters || {},
          });
        }
      } catch {
        /* skip */
      }
    }
    return { cleanText: text.replace(re, '').trim(), toolCalls };
  }

  private _countPrompt(options: GenerateOptions): number {
    if (options.messages) return countMessageTokens(options.messages);
    if (options.prompt) return countTokens(options.prompt);
    return 0;
  }

  private _guessContextLength(modelInfo: Record<string, unknown> | undefined): number {
    if (!modelInfo) return 4096;
    for (const [key, value] of Object.entries(modelInfo)) {
      if (key.endsWith('.context_length') && typeof value === 'number') {
        return value;
      }
    }
    return 4096;
  }
}

export function createOllamaEngine(options?: OllamaEngineOptions): LLMEngine {
  return new OllamaEngine(options);
}
