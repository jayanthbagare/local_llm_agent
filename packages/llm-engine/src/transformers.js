// ── Transformers.js Engine ──
// REAL local LLM inference using @huggingface/transformers.
// Downloads a quantized ONNX model from the HuggingFace CDN and runs it
// entirely in the browser via WebGPU (falling back to WASM), streaming
// genuine model-generated tokens.
//
// This is NOT a simulation: it loads real model weights and runs a real
// forward pass / auto-regressive decode through onnxruntime-web.
import { countTokens, countMessageTokens } from './tokenizer';
let transformers = null;
/**
 * The module specifier used to import transformers.js. Overridable so the
 * static demo page (which loads it from a CDN via an import map) and a bundled
 * app can both resolve it.
 */
export let TRANSFORMERS_SPECIFIER = '@huggingface/transformers';
/** Override where transformers.js is imported from (e.g. a CDN URL). */
export function setTransformersSpecifier(specifier) {
    TRANSFORMERS_SPECIFIER = specifier;
}
async function getTransformers() {
    if (transformers)
        return transformers;
    try {
        transformers = (await import(
        /* @vite-ignore */ TRANSFORMERS_SPECIFIER));
    }
    catch (err) {
        throw new Error(`Failed to load @huggingface/transformers ("${TRANSFORMERS_SPECIFIER}"). ` +
            `Install it (npm install @huggingface/transformers) or point ` +
            `setTransformersSpecifier() at a CDN build. Original error: ${err.message}`);
    }
    return transformers;
}
/** Model presets: maps friendly ids to HuggingFace ONNX repos transformers.js can load. */
const MODEL_PRESETS = {
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
};
/** Default model — small enough to download and run quickly in-browser. */
const DEFAULT_MODEL = 'qwen2-0.5b';
export class TransformersEngine {
    generator = null;
    _info = null;
    _device = 'none';
    _aborted = false;
    _contextLength = 4096;
    async load(options) {
        const tf = await getTransformers();
        this._aborted = false;
        // Prefer remote models from the HF hub (the demo loads by repo id).
        tf.env.allowLocalModels = false;
        tf.env.allowRemoteModels = true;
        const preset = MODEL_PRESETS[options.modelId] ?? MODEL_PRESETS[DEFAULT_MODEL];
        const repo = options.modelUrl || preset.repo;
        this._contextLength = preset.contextLength;
        const device = await this._resolveDevice(options.device);
        this._device = device;
        options.onProgress?.({
            status: 'downloading',
            message: `Downloading ${preset.name} (${repo})...`,
        });
        try {
            this.generator = await tf.pipeline('text-generation', repo, {
                device: device === 'webgpu' ? 'webgpu' : 'wasm',
                dtype: device === 'webgpu' ? 'q4f16' : 'q4',
                progress_callback: (p) => {
                    if (this._aborted)
                        return;
                    if (p.status === 'progress') {
                        options.onProgress?.({
                            status: 'downloading',
                            bytesDownloaded: p.loaded,
                            totalBytes: p.total,
                            message: `Downloading ${p.file ?? ''}... ${Math.round(p.progress ?? 0)}%`,
                        });
                    }
                    else if (p.status === 'ready' || p.status === 'done') {
                        options.onProgress?.({ status: 'loading', message: 'Preparing model...' });
                    }
                },
            });
        }
        catch (err) {
            if (device === 'webgpu') {
                // Fall back to WASM CPU inference.
                options.onProgress?.({
                    status: 'loading',
                    message: 'WebGPU failed, falling back to WASM (slower)...',
                });
                this._device = 'wasm';
                this.generator = await tf.pipeline('text-generation', repo, {
                    device: 'wasm',
                    dtype: 'q4',
                });
            }
            else {
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
    }
    isLoaded() {
        return this._info?.isLoaded ?? false;
    }
    getModelInfo() {
        return this._info;
    }
    async generate(options) {
        const tokens = [];
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
    async *generateStream(options) {
        this._aborted = false;
        if (!this.generator) {
            throw new Error('No model loaded. Call load() first.');
        }
        const tf = await getTransformers();
        const messages = this._toChatMessages(options);
        // Bridge the streamer's synchronous callback into an async iterator.
        const queue = [];
        let done = false;
        let notify = null;
        const streamer = new tf.TextStreamer(this.generator.tokenizer, {
            skip_prompt: true,
            skip_special_tokens: true,
            callback_function: (text) => {
                if (!text)
                    return;
                queue.push(text);
                options.onToken?.(text);
                notify?.();
            },
        });
        // Kick off generation without awaiting so we can stream as tokens arrive.
        const genPromise = this.generator(messages, {
            max_new_tokens: options.maxTokens ?? 512,
            temperature: options.temperature ?? 0.7,
            top_p: options.topP ?? 0.9,
            do_sample: (options.temperature ?? 0.7) > 0,
            repetition_penalty: 1.1,
            streamer,
        })
            .catch((err) => {
            // Surface generation errors through the stream.
            queue.push('');
            genPromise.error = err;
        })
            .finally(() => {
            done = true;
            notify?.();
        });
        while (!done || queue.length > 0) {
            if (this._aborted)
                break;
            if (queue.length === 0) {
                await new Promise((resolve) => {
                    notify = () => {
                        notify = null;
                        resolve();
                    };
                });
                continue;
            }
            const text = queue.shift();
            if (text)
                yield { text };
        }
        await genPromise;
        if (genPromise.error) {
            throw genPromise.error;
        }
    }
    countTokens(text) {
        // Use the model's real tokenizer when available; fall back to heuristic.
        const enc = this.generator?.tokenizer?.encode;
        if (enc) {
            try {
                return enc.call(this.generator.tokenizer, text).length;
            }
            catch {
                /* fall through */
            }
        }
        return countTokens(text);
    }
    async unload() {
        if (this.generator?.dispose) {
            try {
                await this.generator.dispose();
            }
            catch {
                /* ignore */
            }
        }
        this.generator = null;
        this._info = null;
        this._device = 'none';
    }
    abort() {
        this._aborted = true;
    }
    // ── Private ──
    async _resolveDevice(device) {
        if (device === 'wasm')
            return 'wasm';
        if (device === 'webgpu')
            return 'webgpu';
        // auto
        if (typeof navigator !== 'undefined' && 'gpu' in navigator) {
            try {
                const adapter = await navigator.gpu.requestAdapter();
                if (adapter)
                    return 'webgpu';
            }
            catch {
                /* fall through */
            }
        }
        return 'wasm';
    }
    _toChatMessages(options) {
        if (options.messages) {
            return options.messages.map((m) => ({
                // transformers.js chat templates only understand system/user/assistant.
                role: m.role === 'tool' ? 'user' : m.role,
                content: m.role === 'tool' ? `Tool result (${m.name ?? 'tool'}):\n${m.content}` : m.content,
            }));
        }
        const msgs = [];
        if (options.systemPrompt)
            msgs.push({ role: 'system', content: options.systemPrompt });
        if (options.prompt)
            msgs.push({ role: 'user', content: options.prompt });
        return msgs;
    }
    _countPrompt(options) {
        if (options.messages)
            return countMessageTokens(options.messages);
        if (options.prompt)
            return countTokens(options.prompt);
        return 0;
    }
    _parseToolCalls(text) {
        const toolCalls = [];
        const re = /```(?:json|tool_call)?\s*\n?(\{[\s\S]*?\})\s*```/g;
        let m;
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
            }
            catch {
                /* skip */
            }
        }
        return { cleanText: text.replace(re, '').trim(), toolCalls };
    }
}
export function createTransformersEngine() {
    return new TransformersEngine();
}
//# sourceMappingURL=transformers.js.map