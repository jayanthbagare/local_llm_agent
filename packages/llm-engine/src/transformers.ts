// ── Transformers.js Engine ──
// REAL local LLM inference using @huggingface/transformers.
// Downloads a quantized ONNX model from the HuggingFace CDN and runs it
// entirely in the browser via WebGPU (falling back to WASM), streaming
// genuine model-generated tokens.
//
// This is NOT a simulation: it loads real model weights and runs a real
// forward pass / auto-regressive decode through onnxruntime-web.

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

// ── Dynamic import of @huggingface/transformers (browser-only) ──

type TransformersModule = {
  pipeline: (
    task: string,
    model: string,
    options?: Record<string, unknown>,
  ) => Promise<TextGenerationPipeline>;
  TextStreamer: new (
    tokenizer: unknown,
    options: {
      skip_prompt?: boolean;
      skip_special_tokens?: boolean;
      callback_function?: (text: string) => void;
    },
  ) => unknown;
  env: {
    allowLocalModels?: boolean;
    allowRemoteModels?: boolean;
    localModelPath?: string;
    useBrowserCache?: boolean;
    useFSCache?: boolean;
    backends?: { onnx?: { wasm?: { proxy?: boolean } } };
  };
};

type ChatMessage = { role: string; content: string };

type TextGenerationPipeline = {
  (
    messages: ChatMessage[] | string,
    options?: Record<string, unknown>,
  ): Promise<Array<{ generated_text: string | ChatMessage[] }>>;
  tokenizer: {
    apply_chat_template?: (
      messages: ChatMessage[],
      options?: Record<string, unknown>,
    ) => unknown;
    encode?: (text: string) => number[];
  };
  dispose?: () => Promise<void>;
};

let transformers: TransformersModule | null = null;

/**
 * The module specifier used to import transformers.js. Overridable so the
 * static demo page (which loads it from a CDN via an import map) and a bundled
 * app can both resolve it.
 */
export let TRANSFORMERS_SPECIFIER = '@huggingface/transformers';

/** Override where transformers.js is imported from (e.g. a CDN URL). */
export function setTransformersSpecifier(specifier: string): void {
  TRANSFORMERS_SPECIFIER = specifier;
}

async function getTransformers(): Promise<TransformersModule> {
  if (transformers) return transformers;
  try {
    transformers = (await import(
      /* @vite-ignore */ TRANSFORMERS_SPECIFIER
    )) as unknown as TransformersModule;
  } catch (err) {
    throw new Error(
      `Failed to load @huggingface/transformers ("${TRANSFORMERS_SPECIFIER}"). ` +
        `Install it (npm install @huggingface/transformers) or point ` +
        `setTransformersSpecifier() at a CDN build. Original error: ${
          (err as Error).message
        }`,
    );
  }
  return transformers!;
}

/** Model presets: maps friendly ids to HuggingFace ONNX repos transformers.js can load. */
const MODEL_PRESETS: Record<
  string,
  { repo: string; contextLength: number; name: string }
> = {
  'phi-3-mini-4k-instruct': {
    repo: 'onnx-community/Phi-3.5-mini-instruct-onnx-web',
    contextLength: 4096,
    name: 'Phi-3.5 Mini Instruct',
  },
  'phi-3-mini-4k': {
    repo: 'onnx-community/Phi-3.5-mini-instruct-onnx-web',
    contextLength: 4096,
    name: 'Phi-3.5 Mini Instruct',
  },
  'gemma-2-2b': {
    repo: 'onnx-community/gemma-2-2b-it',
    contextLength: 8192,
    name: 'Gemma 2 (2B) Instruct',
  },
  'qwen2-0.5b': {
    repo: 'onnx-community/Qwen2.5-0.5B-Instruct',
    contextLength: 32768,
    name: 'Qwen2.5 0.5B Instruct',
  },
  'qwen2-1.5b': {
    repo: 'onnx-community/Qwen2.5-1.5B-Instruct',
    contextLength: 32768,
    name: 'Qwen2.5 1.5B Instruct',
  },
};

/** Default model — small enough to download and run quickly in-browser. */
const DEFAULT_MODEL = 'qwen2-0.5b';

export class TransformersEngine implements LLMEngine {
  private generator: TextGenerationPipeline | null = null;
  private _info: ModelInfo | null = null;
  private _device: 'webgpu' | 'wasm' | 'none' = 'none';
  private _hasShaderF16 = false;
  private _aborted = false;
  private _contextLength = 4096;

  async load(options: LoadOptions): Promise<void> {
    const tf = await getTransformers();
    this._aborted = false;

    // Always cache fetched weights in the browser's Cache Storage so a model
    // is downloaded at most once per origin (subsequent loads are offline).
    tf.env.useBrowserCache = true;

    const preset =
      MODEL_PRESETS[options.modelId] ?? MODEL_PRESETS[DEFAULT_MODEL];
    this._contextLength = preset.contextLength;

    // Where to load model files from.
    //   - local: served from your own origin under `localModelPath/<repo>/`
    //   - remote (default): the HuggingFace hub
    let repo: string;
    if (options.local) {
      tf.env.allowLocalModels = true;
      tf.env.allowRemoteModels = false;
      tf.env.localModelPath = options.localModelPath ?? '/models/';
      // For local serving the "repo" is just the folder name under localModelPath.
      repo = options.modelUrl || preset.repo;
    } else {
      tf.env.allowLocalModels = false;
      tf.env.allowRemoteModels = true;
      repo = options.modelUrl || preset.repo;
    }

    const device = await this._resolveDevice(options.device);
    this._device = device;

    options.onProgress?.({
      status: 'downloading',
      message: options.local
        ? `Loading ${preset.name} from ${tf.env.localModelPath}${repo}...`
        : `Downloading ${preset.name} (${repo})...`,
    });

    const dtype = options.dtype ?? this._pickDtype(device);

    try {
      this.generator = await tf.pipeline('text-generation', repo, {
        device: device === 'webgpu' ? 'webgpu' : 'wasm',
        dtype,
        progress_callback: (p: {
          status?: string;
          file?: string;
          progress?: number;
          loaded?: number;
          total?: number;
        }) => {
          if (this._aborted) return;
          if (p.status === 'progress') {
            options.onProgress?.({
              status: 'downloading',
              bytesDownloaded: p.loaded,
              totalBytes: p.total,
              message: `Downloading ${p.file ?? ''}... ${Math.round(
                p.progress ?? 0,
              )}%`,
            });
          } else if (p.status === 'ready' || p.status === 'done') {
            options.onProgress?.({ status: 'loading', message: 'Preparing model...' });
          }
        },
      });
    } catch (err) {
      if (device === 'webgpu') {
        // Fall back to WASM CPU inference.
        console.warn(
          '[llm-engine] WebGPU pipeline failed to load, falling back to WASM:',
          err,
        );
        options.onProgress?.({
          status: 'loading',
          message: `WebGPU failed (${
            (err as Error)?.message || err
          }), falling back to WASM (slower)...`,
        });
        this._device = 'wasm';
        this.generator = await tf.pipeline('text-generation', repo, {
          device: 'wasm',
          dtype: options.dtype ?? 'q4',
        });
      } else {
        throw err;
      }
    }

    options.onProgress?.({ status: 'ready', message: 'Model loaded' });

    this._info = {
      id: options.modelId,
      name: preset.name,
      contextLength: this._contextLength,
      isLoaded: true,
      device: this._device,
      memoryUsage: this._device === 'webgpu' ? '~GPU VRAM' : '~system RAM',
    };

    // Warm up: run a tiny generation so the first real query doesn't pay the
    // one-time cost of shader/graph compilation and buffer allocation.
    try {
      options.onProgress?.({ status: 'loading', message: 'Warming up...' });
      await this.generator!([{ role: 'user', content: 'Hi' }], {
        max_new_tokens: 1,
        do_sample: false,
      });
      options.onProgress?.({ status: 'ready', message: 'Ready' });
    } catch {
      /* warmup is best-effort */
    }
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
    for await (const token of this.generateStream(options)) {
      tokens.push(token);
      fullText += token.text;
    }

    const { cleanText, toolCalls } = this._parseToolCalls(fullText);
    const promptTokens = this._countPrompt(options);

    return {
      text: cleanText || fullText,
      tokens,
      finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        promptTokens,
        completionTokens: tokens.length,
        totalTokens: promptTokens + tokens.length,
      },
    };
  }

  async *generateStream(options: GenerateOptions): AsyncIterable<Token> {
    this._aborted = false;
    if (!this.generator) {
      throw new Error('No model loaded. Call load() first.');
    }
    const tf = await getTransformers();

    const messages = this._toChatMessages(options);

    // Bridge the streamer's synchronous callback into an async iterator.
    const queue: string[] = [];
    let done = false;
    let notify: (() => void) | null = null;

    const streamer = new tf.TextStreamer(this.generator.tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (text: string) => {
        if (!text) return;
        queue.push(text);
        options.onToken?.(text);
        notify?.();
      },
    });

    // Cap generation length: a 0.5-2B model in-browser is slow per token, so
    // very large limits (e.g. 2048) make short answers feel sluggish. Honor an
    // explicit request but keep a sane ceiling for responsiveness. On the WASM
    // (CPU) fallback, cap more aggressively since each token is much slower.
    const ceiling = this._device === 'wasm' ? 200 : 512;
    const maxNewTokens = Math.min(options.maxTokens ?? 256, ceiling);

    // Kick off generation without awaiting so we can stream as tokens arrive.
    const genPromise = this.generator(messages, {
      max_new_tokens: maxNewTokens,
      temperature: options.temperature ?? 0.7,
      top_p: options.topP ?? 0.9,
      do_sample: (options.temperature ?? 0.7) > 0,
      repetition_penalty: 1.1,
      streamer,
    })
      .catch((err: unknown) => {
        // Surface generation errors through the stream.
        queue.push('');
        (genPromise as { error?: unknown }).error = err;
      })
      .finally(() => {
        done = true;
        notify?.();
      });

    while (!done || queue.length > 0) {
      if (this._aborted) break;
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          notify = () => {
            notify = null;
            resolve();
          };
        });
        continue;
      }
      const text = queue.shift()!;
      if (text) yield { text };
    }

    await genPromise;
    if ((genPromise as { error?: unknown }).error) {
      throw (genPromise as { error?: unknown }).error;
    }
  }

  countTokens(text: string): number {
    // Use the model's real tokenizer when available; fall back to heuristic.
    const enc = this.generator?.tokenizer?.encode;
    if (enc) {
      try {
        return enc.call(this.generator!.tokenizer, text).length;
      } catch {
        /* fall through */
      }
    }
    return countTokens(text);
  }

  async unload(): Promise<void> {
    if (this.generator?.dispose) {
      try {
        await this.generator.dispose();
      } catch {
        /* ignore */
      }
    }
    this.generator = null;
    this._info = null;
    this._device = 'none';
  }

  abort(): void {
    this._aborted = true;
  }

  // ── Private ──

  private async _resolveDevice(
    device: LoadOptions['device'],
  ): Promise<'webgpu' | 'wasm'> {
    if (device === 'wasm') return 'wasm';
    if (device === 'webgpu') return 'webgpu';
    // auto
    if (typeof navigator !== 'undefined' && 'gpu' in navigator) {
      try {
        const adapter = await (navigator as unknown as {
          gpu: {
            requestAdapter: () => Promise<{
              features?: { has: (name: string) => boolean };
            } | null>;
          };
        }).gpu.requestAdapter();
        if (adapter) {
          // Remember whether this adapter supports fp16 shaders so we can
          // pick a dtype it can actually run (see `_pickDtype`). Adapters
          // without `shader-f16` (common on many integrated/mobile GPUs)
          // will throw when asked to run a q4f16 pipeline, which used to
          // be silently mis-reported as "WebGPU failed" and fell back to
          // WASM even though WebGPU itself works fine with a q4 dtype.
          this._hasShaderF16 = !!adapter.features?.has?.('shader-f16');
          return 'webgpu';
        }
      } catch (err) {
        console.warn(
          '[llm-engine] navigator.gpu.requestAdapter() failed, falling back to WASM:',
          err,
        );
      }
    }
    return 'wasm';
  }

  /** Pick a dtype the resolved device can actually run. */
  private _pickDtype(device: 'webgpu' | 'wasm'): string {
    if (device !== 'webgpu') return 'q4';
    // q4f16 needs the `shader-f16` WebGPU feature; without it the pipeline
    // throws during session creation. Use plain q4 instead so we stay on
    // WebGPU rather than needlessly downgrading to WASM.
    return this._hasShaderF16 ? 'q4f16' : 'q4';
  }

  private _toChatMessages(options: GenerateOptions): ChatMessage[] {
    if (options.messages) {
      return options.messages.map((m: Message) => ({
        // transformers.js chat templates only understand system/user/assistant.
        role: m.role === 'tool' ? 'user' : m.role,
        content:
          m.role === 'tool' ? `Tool result (${m.name ?? 'tool'}):\n${m.content}` : m.content,
      }));
    }
    const msgs: ChatMessage[] = [];
    if (options.systemPrompt) msgs.push({ role: 'system', content: options.systemPrompt });
    if (options.prompt) msgs.push({ role: 'user', content: options.prompt });
    return msgs;
  }

  private _countPrompt(options: GenerateOptions): number {
    if (options.messages) return countMessageTokens(options.messages);
    if (options.prompt) return countTokens(options.prompt);
    return 0;
  }

  private _parseToolCalls(text: string): {
    cleanText: string;
    toolCalls: ToolCall[];
  } {
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
}

export function createTransformersEngine(): LLMEngine {
  return new TransformersEngine();
}
