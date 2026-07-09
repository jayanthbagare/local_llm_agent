// ── LLM Engine Tests ──
import { describe, it, expect, beforeEach } from 'vitest';
import { SimulatedEngine, createSimulatedEngine } from '../src/simulated';
import { countTokens, countMessageTokens, applyChatTemplate, CHAT_TEMPLATES } from '../src/tokenizer';
// ── Tokenizer Tests ──
describe('countTokens', () => {
    it('returns 0 for empty string', () => {
        expect(countTokens('')).toBe(0);
    });
    it('counts single words as tokens', () => {
        // 'hello' = 5 chars → ceil(5/4) = 2 tokens
        expect(countTokens('hello')).toBe(2);
        // 'hi' = 2 chars → ceil(2/4) = 1 token
        expect(countTokens('hi')).toBe(1);
    });
    it('counts longer words proportionally', () => {
        // "beautiful" = 9 chars → ceil(9/4) = 3 tokens
        expect(countTokens('beautiful')).toBe(3);
    });
    it('counts multi-word text', () => {
        const text = 'The quick brown fox';
        // The(1) + quick(2) + brown(2) + fox(1) = 6
        const n = countTokens(text);
        expect(n).toBeGreaterThanOrEqual(5);
        expect(n).toBeLessThanOrEqual(8);
    });
    it('counts special tokens as 1 each', () => {
        expect(countTokens('<|system|>')).toBeGreaterThanOrEqual(1);
        expect(countTokens('<|end|>')).toBeGreaterThanOrEqual(1);
    });
});
describe('countMessageTokens', () => {
    it('counts tokens across messages with overhead', () => {
        const msgs = [
            { role: 'system', content: 'You are helpful.' },
            { role: 'user', content: 'Hello' },
        ];
        const tokens = countMessageTokens(msgs);
        // 2 msgs × 3 overhead + content tokens
        expect(tokens).toBeGreaterThan(6);
    });
    it('returns 0 for empty array', () => {
        expect(countMessageTokens([])).toBe(0);
    });
});
// ── Chat Template Tests ──
describe('applyChatTemplate', () => {
    it('renders chatml format', () => {
        const msgs = [
            { role: 'system', content: 'Be helpful.' },
            { role: 'user', content: 'Hi' },
        ];
        const result = applyChatTemplate(CHAT_TEMPLATES['chatml'], msgs, true);
        expect(result).toContain('<|im_start|>system');
        expect(result).toContain('Be helpful.');
        expect(result).toContain('<|im_start|>user');
        expect(result).toContain('Hi');
        expect(result).toContain('<|im_start|>assistant');
    });
    it('excludes generation prompt when flag is false', () => {
        const msgs = [{ role: 'user', content: 'Hi' }];
        const result = applyChatTemplate(CHAT_TEMPLATES['chatml'], msgs, false);
        expect(result).not.toContain('<|im_start|>assistant');
    });
    it('renders gemma format with role-based branching', () => {
        const msgs = [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there!' },
        ];
        const result = applyChatTemplate(CHAT_TEMPLATES['gemma'], msgs, true);
        expect(result).toContain('<start_of_turn>user');
        expect(result).toContain('Hello');
        expect(result).toContain('Hi there!');
        // Should contain generation prompt at the end
        expect(result.endsWith('<start_of_turn>model')).toBe(true);
    });
});
// ── Simulated Engine Tests ──
describe('SimulatedEngine', () => {
    let engine;
    beforeEach(() => {
        engine = new SimulatedEngine();
    });
    describe('load', () => {
        it('loads a model successfully', async () => {
            const progress = [];
            await engine.load({
                modelId: 'test-model',
                onProgress: (p) => progress.push(p.status),
            });
            expect(engine.isLoaded()).toBe(true);
            expect(progress).toContain('ready');
        });
        it('sets model info after loading', async () => {
            await engine.load({ modelId: 'phi-3-mini-4k' });
            const info = engine.getModelInfo();
            expect(info).not.toBeNull();
            expect(info.id).toBe('phi-3-mini-4k');
            expect(info.isLoaded).toBe(true);
        });
    });
    describe('generate', () => {
        beforeEach(async () => {
            await engine.load({ modelId: 'test' });
        });
        it('generates a response for a prompt', async () => {
            const result = await engine.generate({ prompt: 'Hello!' });
            expect(result.text).toBeTruthy();
            expect(result.text.length).toBeGreaterThan(0);
            expect(result.finishReason).toBe('stop');
        });
        it('generates math results', async () => {
            const result = await engine.generate({ prompt: 'what is 123 + 456' });
            expect(result.text).toContain('579');
        });
        it('includes usage statistics', async () => {
            const result = await engine.generate({ prompt: 'Hello' });
            expect(result.usage).toBeDefined();
            expect(result.usage.promptTokens).toBeGreaterThan(0);
            expect(result.usage.completionTokens).toBeGreaterThan(0);
        });
        it('works with messages array', async () => {
            const result = await engine.generate({
                messages: [
                    { role: 'system', content: 'Be concise.' },
                    { role: 'user', content: 'Hi' },
                ],
            });
            expect(result.text).toBeTruthy();
        });
        it('generates tool calls when tools are provided and query matches', async () => {
            const result = await engine.generate({
                prompt: 'search for cats',
                tools: [
                    {
                        type: 'function',
                        function: {
                            name: 'web_search',
                            description: 'Search the web',
                            parameters: { query: { type: 'string' } },
                        },
                    },
                ],
            });
            expect(result.finishReason).toBe('tool_calls');
            expect(result.toolCalls).toBeDefined();
            expect(result.toolCalls.length).toBeGreaterThan(0);
            expect(result.toolCalls[0].name).toBe('web_search');
        });
    });
    describe('generateStream', () => {
        beforeEach(async () => {
            await engine.load({ modelId: 'test' });
        });
        it('yields tokens incrementally', async () => {
            const tokens = [];
            for await (const t of engine.generateStream({ prompt: 'Hello world' })) {
                tokens.push(t.text);
            }
            expect(tokens.length).toBeGreaterThan(0);
        });
        it('calls onToken callback', async () => {
            const tokens = [];
            for await (const _t of engine.generateStream({
                prompt: 'test',
                onToken: (t) => tokens.push(t),
            })) {
                // consume
            }
            expect(tokens.length).toBeGreaterThan(0);
        });
        it('can be aborted mid-stream', async () => {
            const tokens = [];
            const promise = (async () => {
                for await (const t of engine.generateStream({ prompt: 'This is a longer response' })) {
                    tokens.push(t.text);
                }
            })();
            // Abort after a tick
            await new Promise(r => setTimeout(r, 30));
            engine.abort();
            await promise;
            // Should have fewer tokens than full response
            expect(tokens.length).toBeGreaterThan(0);
        });
    });
    describe('countTokens', () => {
        it('delegates to tokenizer', () => {
            const engine2 = createSimulatedEngine();
            const n = engine2.countTokens('hello world');
            expect(n).toBeGreaterThan(0);
        });
    });
    describe('unload', () => {
        it('unloads the model', async () => {
            await engine.load({ modelId: 'test' });
            expect(engine.isLoaded()).toBe(true);
            await engine.unload();
            expect(engine.isLoaded()).toBe(false);
            expect(engine.getModelInfo()).toBeNull();
        });
    });
});
// ── Factory Tests ──
describe('createSimulatedEngine factory', () => {
    it('creates an engine instance', () => {
        const e = createSimulatedEngine();
        expect(e).toBeDefined();
        expect(typeof e.load).toBe('function');
        expect(typeof e.generate).toBe('function');
    });
});
//# sourceMappingURL=engine.test.js.map