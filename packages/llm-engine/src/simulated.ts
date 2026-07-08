// ── Simulated LLM Engine ──
// Realistic simulation for development and testing without WebGPU/ONNX.

import type {
  LLMEngine,
  LoadOptions,
  GenerateOptions,
  GenerateResult,
  Token,
  ModelInfo,
  LoadProgress,
  ToolCall,
} from './types';
import { countTokens, countMessageTokens } from './tokenizer';

// Response templates for deterministic testing
const MATH_RE = /(?:what is|calculate|compute|evaluate)\s+(\d+)\s*([+\-*\/])\s*(\d+)/i;
const GREET_RE = /\b(hello|hi|hey|greet|good morning|good afternoon)\b/i;
const THANKS_RE = /\b(thanks|thank you|thx)\b/i;
const WEATHER_RE = /\bweather\b/i;
const HELP_RE = /\bhelp\b/i;
const IDENTITY_RE = /\bwho (?:are|r) (?:you|u)\b/i;

const DEFAULT_RESPONSES = [
  "That's a thoughtful question. Let me break it down: the key is understanding the fundamentals first. Once you grasp those, the rest follows naturally. Let me know if you'd like me to dive deeper into any specific aspect.",
  "Good question! There are several ways to approach this. The most practical route depends on your constraints. Could you share more about your specific use case? That'll help me give you the most relevant answer.",
  "I'd be happy to help with that. Let me walk through it step by step so you can see the reasoning clearly. The important thing to remember is that context matters — what works in one scenario may not be ideal in another.",
];
let _respIdx = 0;

export class SimulatedEngine implements LLMEngine {
  private _loaded = false;
  private _info: ModelInfo | null = null;
  private _aborted = false;
  private _device: 'webgpu' | 'wasm' | 'none' = 'none';

  async load(options: LoadOptions): Promise<void> {
    this._aborted = false;
    await this._simulateProgress(options);
    this._loaded = true;
    this._device = options.device === 'wasm' ? 'wasm' : 'webgpu';
    this._info = {
      id: options.modelId,
      name: options.modelId,
      contextLength: 4096,
      isLoaded: true,
      device: this._device,
      memoryUsage: '~1.8 GB',
    };
  }

  isLoaded(): boolean { return this._loaded; }
  getModelInfo(): ModelInfo | null { return this._info; }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    const tokens: Token[] = [];
    let text = '';
    for await (const t of this.generateStream(options)) { tokens.push(t); text += t.text; }
    const { cleanText, toolCalls } = this._parseToolCalls(text);
    const pTokens = this._countPromptTokens(options);
    return {
      text: cleanText || text,
      tokens,
      finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: { promptTokens: pTokens, completionTokens: tokens.length, totalTokens: pTokens + tokens.length },
    };
  }

  async *generateStream(options: GenerateOptions): AsyncIterable<Token> {
    this._aborted = false;
    const text = this._generate(options);
    const words = text.split(/(\s+)/);
    for (const w of words) {
      if (this._aborted) break;
      await new Promise(r => setTimeout(r, 10 + Math.random() * 20));
      options.onToken?.(w);
      yield { text: w };
    }
  }

  countTokens(text: string): number { return countTokens(text); }

  async unload(): Promise<void> {
    this._loaded = false;
    this._info = null;
    this._device = 'none';
  }

  abort(): void { this._aborted = true; }

  // ── Private ──

  private async _simulateProgress(opts: LoadOptions): Promise<void> {
    for (let i = 0; i < 5; i++) {
      if (this._aborted) return;
      const pct = (i + 1) / 5;
      opts.onProgress?.({
        status: i < 4 ? 'downloading' : 'loading',
        bytesDownloaded: pct * 100 * 1024 * 1024,
        totalBytes: 100 * 1024 * 1024,
        message: i < 4 ? `Downloading... ${Math.round(pct * 100)}%` : 'Loading model...',
      });
      await new Promise(r => setTimeout(r, 15));
    }
    opts.onProgress?.({ status: 'ready', message: 'Ready' });
  }

  private _generate(options: GenerateOptions): string {
    const userMsg = this._getLastUserMessage(options);

    if (options.tools?.length && userMsg) {
      const tc = this._tryToolCall(userMsg, options.tools);
      if (tc) return tc;
    }

    if (!userMsg) return 'I am ready to help. What would you like to know?';
    return this._respond(userMsg);
  }

  private _respond(input: string): string {
    const lower = input.toLowerCase();

    const mathM = input.match(MATH_RE);
    if (mathM) {
      const a = parseInt(mathM[1]), b = parseInt(mathM[3]);
      let r: number;
      switch (mathM[2]) {
        case '+': r = a + b; break;
        case '-': r = a - b; break;
        case '*': r = a * b; break;
        case '/': r = a / b; break;
        default: r = NaN;
      }
      return `${a} ${mathM[2]} ${b} = ${r}`;
    }

    if (GREET_RE.test(lower))
      return "Hello! I'm your local AI assistant, running right in your browser with WebGPU. How can I help today?";
    if (THANKS_RE.test(lower))
      return "You're welcome! Feel free to ask if you need anything else.";
    if (IDENTITY_RE.test(lower))
      return "I'm a browser-native LLM agent powered by WebGPU. I run entirely on your device — no servers, no API keys, complete privacy.";
    if (WEATHER_RE.test(lower))
      return "I don't have real-time weather data, but I can search the web for you if you enable the web-search skill!";
    if (HELP_RE.test(lower))
      return "I can help with: math calculations, answering questions, coding, web searches (with skills enabled), calendar management, file operations, and more. Just ask!";

    return DEFAULT_RESPONSES[_respIdx++ % DEFAULT_RESPONSES.length];
  }

  private _tryToolCall(userMsg: string, tools: NonNullable<GenerateOptions['tools']>): string | null {
    const lower = userMsg.toLowerCase();
    for (const tool of tools) {
      const name = tool.function.name;
      const kw = [...name.split(/[-_]/), ...(tool.function.description || '').toLowerCase().split(/\s+/)];
      if (kw.some(k => k.length > 2 && lower.includes(k))) {
        let args: Record<string, unknown> = {};
        try {
          const jm = userMsg.match(/\{[\s\S]*\}/);
          if (jm) args = JSON.parse(jm[0]);
          else {
            const pairs = userMsg.match(/(\w+)\s*[=:]\s*("[^"]+"|'[^']+'|\S+)/g);
            if (pairs) for (const p of pairs) { const [k, v] = p.split(/\s*[=:]\s*/); args[k] = (v || '').replace(/^["']|["']$/g, ''); }
          }
        } catch { /* ignore */ }
        return `I'll use the **${name}** tool to help with that.\n\n\`\`\`json\n${JSON.stringify({ name, arguments: args }, null, 2)}\n\`\`\``;
      }
    }
    return null;
  }

  private _parseToolCalls(text: string): { cleanText: string; toolCalls: ToolCall[] } {
    const calls: ToolCall[] = [];
    const re = /```(?:json|tool_call)?\s*\n?(\{[\s\S]*?\})\s*```/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      try {
        const p = JSON.parse(m[1]);
        if (p.name || p.tool || p.function) {
          calls.push({
            id: `call_${Math.random().toString(36).slice(2, 9)}`,
            name: p.name || p.tool || p.function,
            arguments: p.arguments || p.args || p.parameters || {},
          });
        }
      } catch { /* skip */ }
    }
    return { cleanText: text.replace(re, '').trim(), toolCalls: calls };
  }

  private _getLastUserMessage(options: GenerateOptions): string | null {
    if (options.prompt) return options.prompt;
    if (options.messages) {
      for (let i = options.messages.length - 1; i >= 0; i--) {
        if (options.messages[i].role === 'user') return options.messages[i].content;
      }
    }
    return null;
  }

  private _countPromptTokens(options: GenerateOptions): number {
    if (options.messages) return countMessageTokens(options.messages);
    if (options.prompt) return countTokens(options.prompt);
    return 0;
  }
}

export function createSimulatedEngine(): LLMEngine {
  return new SimulatedEngine();
}
