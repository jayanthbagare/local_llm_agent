# Local LLM Agent — API Reference

## Architecture

```
@local-llm-agent/sdk  ← One import, everything unified
    ├── llm-engine    Real WebGPU/WASM (transformers.js) or local Ollama inference
    ├── nano-agent    ReAct agent loop (~5KB gzipped)
    ├── skill-store   Skill registry + IndexedDB cache
    ├── tool-bridge   REST, MCP, sandboxed function execution
    └── harness       Multi-task, event-driven agent orchestration
```

---

## Quick Start

```ts
import { createAgent } from '@local-llm-agent/sdk';

// Real in-browser inference (WebGPU, WASM fallback). The model is downloaded
// once from the HuggingFace CDN, then cached in the browser for next time.
const agent = await createAgent({
  model: 'qwen2-0.5b',
  customSkills: [/* ... */],
  maxTokens: 256,          // keep small models responsive
});

for await (const event of agent.run('What is 256 * 128?')) {
  switch (event.type) {
    case 'thinking': console.log('🤔', event.content); break;
    case 'tool_call': console.log('🔧', event.tool, event.args); break;
    case 'tool_result': console.log('📋', event.result); break;
    case 'token': process.stdout.write(event.token); break;
    case 'done': console.log('✅', event.response, `(${event.steps} steps)`); break;
    case 'error': console.error('❌', event.error); break;
  }
}

// Clean up
await agent.destroy();
```

> For unit tests or Node.js, pass `simulated: true` to use `SimulatedEngine`
> (no WebGPU / model download required).

---

## Package: `@local-llm-agent/llm-engine`

### `LLMEngine` interface

```ts
interface LLMEngine {
  load(options: LoadOptions): Promise<void>;
  isLoaded(): boolean;
  getModelInfo(): ModelInfo | null;
  generate(options: GenerateOptions): Promise<GenerateResult>;
  generateStream(options: GenerateOptions): AsyncIterable<Token>;
  countTokens(text: string): number;
  unload(): Promise<void>;
  abort(): void;
}
```

### Engines

| Class | Description | Requires |
|-------|-------------|----------|
| `TransformersEngine` | **Real** in-browser inference via [transformers.js](https://github.com/huggingface/transformers.js) — loads a quantized ONNX model and runs it on WebGPU (WASM fallback), streaming real tokens. **Default** in browsers. | Browser, `@huggingface/transformers` |
| `OllamaEngine` | **Real** inference via a locally running [Ollama](https://ollama.com) server (`ollama serve`, default `http://localhost:11434`) over `/api/chat` NDJSON streaming. Lets an agent use much larger/more capable models than fit inside a browser's WASM/WebGPU memory ceiling. | Node/CLI, local `ollama serve` process |
| `SimulatedEngine` | Deterministic simulation for tests/dev. | Nothing — works everywhere |
| `WebGPUEngine` | Legacy ONNX Runtime Web scaffold (placeholder inference). | Browser, onnxruntime-web |

`createAgent()` selects `TransformersEngine` automatically in a browser, and
`SimulatedEngine` in Node (or when you pass `simulated: true`). Pass an
explicit `engine: new OllamaEngine({ model: 'qwen2.5:7b' })` to use Ollama
instead (see below).

### `OllamaEngine`

```ts
import { createAgent, OllamaEngine } from '@local-llm-agent/sdk';

const engine = new OllamaEngine({
  baseUrl: 'http://localhost:11434',  // default
  model: 'qwen2.5:7b',                // any pulled Ollama model tag
  think: false,                       // default: disable extended "thinking"
});

const agent = await createAgent({ engine, skills: ['web-search', 'wikipedia'] });
```

```ts
interface OllamaEngineOptions {
  baseUrl?: string;   // default: 'http://localhost:11434'
  model?: string;     // Ollama model tag, e.g. 'llama3.2', 'qwen2.5:7b'
  think?: boolean;    // default: false
}
```

> Some Ollama models (e.g. "thinking"-capable ones like gemma4) stream their
> chain-of-thought in a separate `message.thinking` field and only emit the
> final answer in `message.content` once reasoning is done. If the model's
> thinking budget exceeds `maxTokens`, the response comes back empty (finish
> reason `length`) with no visible answer at all. `think: false` (the default)
> disables extended thinking so responses always land in `content`.
>
> Requires `ollama serve` running locally with the model already pulled
> (`ollama pull qwen2.5:7b`). `ModelInfo.device` reports `'ollama'` for this
> engine.

### Model caching (download once)

`TransformersEngine` sets `env.useBrowserCache = true`, so model files are stored
in the browser's **Cache Storage** (bucket: `transformers-cache`) on first load.
Every subsequent load reads from the cache with **no network** — a model is
downloaded at most once per origin. Inspect it in DevTools → Application →
Cache Storage → `transformers-cache`.

### Self-hosting models (no HuggingFace dependency)

Set `local: true` to load model files from **your own origin** instead of the
HuggingFace hub. Files are still cached in the browser after first fetch.

```ts
await engine.load({
  modelId: 'qwen2-0.5b',
  local: true,
  localModelPath: '/models/',   // serves /models/<repo>/... on your origin
});
```

The folder under `localModelPath` must mirror the HuggingFace repo layout
(e.g. `onnx/model_q4f16.onnx`, `tokenizer.json`, `config.json`, ...).

### `LoadOptions`

```ts
interface LoadOptions {
  modelId: string;           // e.g., 'qwen2-0.5b'
  modelUrl?: string;         // Override repo id / folder name
  device?: 'webgpu' | 'wasm' | 'auto';  // default: 'auto'
  cache?: boolean;
  onProgress?: (p: LoadProgress) => void;
  local?: boolean;           // Load from your own origin (see above)
  localModelPath?: string;   // Base path for self-hosted models (default '/models/')
  dtype?: string;            // Override quantization: 'q4f16' | 'q4' | 'fp16' | 'int8'
}
```

> By default, `dtype` is `q4f16` on WebGPU and `q4` on WASM.

### `GenerateOptions`

```ts
interface GenerateOptions {
  messages?: Message[];
  prompt?: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;      // 0-2, default 0.7
  topP?: number;             // 0-1, default 0.9
  stopSequences?: string[];
  seed?: number;
  onToken?: (token: string) => void;
  tools?: ToolDefinition[];  // For function calling
}
```

### Token Counting

```ts
import { countTokens, countMessageTokens } from '@local-llm-agent/llm-engine';

countTokens('Hello world');           // ~3 tokens
countMessageTokens(messages);          // Total tokens in message array
```

### Chat Templates

```ts
import { applyChatTemplate, CHAT_TEMPLATES } from '@local-llm-agent/llm-engine';

const prompt = applyChatTemplate(CHAT_TEMPLATES['chatml'], [
  { role: 'system', content: 'Be helpful' },
  { role: 'user', content: 'Hello' },
], true);
// <|im_start|>system\nBe helpful<|im_end|>\n<|im_start|>user\nHello<|im_end|>\n<|im_start|>assistant\n
```

Supported templates:
- `CHAT_TEMPLATES['phi-3']` — Phi-3 format
- `CHAT_TEMPLATES['llama-3']` — Llama 3 format
- `CHAT_TEMPLATES['gemma']` — Gemma format
- `CHAT_TEMPLATES['chatml']` — Qwen/ChatML format

---

## Package: `@local-llm-agent/skill-store`

### `SkillStore`

```ts
class SkillStore {
  constructor(options?: SkillStoreOptions);

  // Built-in skills (bundled with SDK)
  registerBuiltin(skill: SkillDefinition): void;
  registerBuiltins(skills: SkillDefinition[]): void;
  getBuiltin(id: string): SkillDefinition | undefined;
  listBuiltins(): SkillDefinition[];

  // User-defined skills (runtime registration)
  register(skill: SkillDefinition): void;
  unregister(id: string): boolean;
  getRegistered(id: string): SkillDefinition | undefined;

  // Remote fetching
  fetch(id: string, version?: string): Promise<SkillDefinition>;
  fetchAll(ids: string[]): Promise<SkillDefinition[]>;

  // Caching (IndexedDB-backed in browser)
  cacheSkill(id: string, skill: SkillDefinition): Promise<void>;
  getCached(id: string): Promise<SkillDefinition | undefined>;
  clearCache(): Promise<void>;

  // Lookup (registered > cached > builtin)
  get(id: string): Promise<SkillDefinition | undefined>;
  listIds(): Promise<string[]>;
}
```

### Skill Definition Format

```ts
interface SkillDefinition {
  id: string;              // kebab-case, e.g., 'web-search'
  name: string;
  version: string;         // Semver
  description?: string;
  author?: string;
  license?: string;
  tags?: string[];
  trigger?: SkillTrigger;  // Auto-routing keywords
  tool: SkillTool;         // The tool to execute
  resultTemplate?: string; // Mustache template for formatting
  permissions?: SkillPermission[];
}
```

### Tool Types

| Type | Description | Required Fields |
|------|-------------|-----------------|
| `rest` | HTTP API call | `url`, `method` |
| `mcp` | Model Context Protocol | `server.url`, `toolName` |
| `function` | Sandboxed JavaScript | `execute` |
| `browser-api` | Browser native APIs | `api` |

### Validation

```ts
import { validateSkill, isSkillDefinition } from '@local-llm-agent/skill-store';

const result = validateSkill(mySkill);
if (!result.valid) {
  for (const err of result.errors) {
    console.error(`${err.code}: ${err.message}`);
  }
}
```

---

## Package: `@local-llm-agent/tool-bridge`

### `ToolBridge`

```ts
class ToolBridge {
  execute(tool: SkillTool, args: ToolArgs): Promise<ToolResult>;
  applyTemplate(template: string, data: unknown, args: ToolArgs): string;
  registerTransport(type: string, handler: TransportHandler): void;
  abort(): void;
}

interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
  duration: number;  // ms
}
```

### Built-in Transports

| Transport | Class | Description |
|-----------|-------|-------------|
| `rest` | `RestTransport` | HTTP fetch with URL interpolation, JSON/text parsing |
| `function` | `FunctionTransport` | Sandboxed JS with allowed globals (Math, JSON, Date) |
| `browser-api` | `BrowserApiTransport` | Clipboard, Geolocation, Notifications, Calendar, File System |
| `mcp` | `MCPTransport` | MCP SSE protocol for tool servers |

### Custom Transport

```ts
bridge.registerTransport('my-transport', {
  async execute(tool, args, signal) {
    // Custom execution logic
    return { result: 'done' };
  },
});
```

---

## Package: `@local-llm-agent/nano-agent`

### `NanoAgent`

```ts
class NanoAgent {
  constructor(config: NanoAgentConfig);

  // Core
  run(input: string): AsyncIterable<AgentEvent>;
  abort(): void;

  // Skills
  registerSkill(skill: SkillDefinition): void;
  registerSkills(skills: SkillDefinition[]): void;
  getSkills(): SkillDefinition[];

  // Conversation
  getMessages(): Message[];
  setMessages(messages: Message[]): void;
  clearHistory(): void;
}
```

### `NanoAgentConfig`

```ts
interface NanoAgentConfig {
  engine: LLMEngine;
  toolBridge: ToolBridge;
  maxSteps?: number;         // default: 5
  systemPrompt?: string;
  temperature?: number;      // default: 0.7
  topP?: number;             // default: 0.9
  maxTokens?: number;        // default: 2048
  maxContextTokens?: number; // default: 8192
}
```

### `AgentEvent` types

```ts
type AgentEvent =
  | { type: 'thinking'; content: string }
  | { type: 'tool_call'; tool: string; args: Record<string, unknown> }
  | { type: 'tool_result'; tool: string; result: ToolResult }
  | { type: 'token'; token: string }
  | { type: 'done'; response: string; steps: number }
  | { type: 'error'; error: string };
```

### Agent Loop (ReAct Pattern)

```
User Input → LLM reasons → Tool needed? → call tool → observe → reason again → ...
                                  ↓ No
                          FINAL: answer
```

When tools are registered, the system prompt instructs the model to respond on
each turn with **either** a tool call **or** a `FINAL:` answer — reasoning first
and using a tool only if necessary:

1. User input is added to the conversation.
2. The system prompt is augmented with ReAct instructions + tool descriptions.
3. The model generates a response. The agent parses it robustly:
   - a fenced ```json `{ "name", "arguments" }` ``` block, **or**
   - a bare (unfenced) JSON tool-call object, **or**
   - the engine's own `toolCalls` if provided.
4. **Tool call** (for a known tool) → execute it, append the observation, loop.
5. **No tool call** → the text (minus any `FINAL:` marker) is the final answer.
6. Tool calls naming an unknown tool are ignored (treated as a direct answer).
7. `maxSteps` bounds the loop.

This means small local models that don't emit perfect function-call JSON still
work, and the model won't call a tool when it can just answer.

---

## Package: `@local-llm-agent/sdk`

### `createAgent(options)`

The main entry point. Creates a fully configured agent in one call.

```ts
const agent = await createAgent({
  model: 'qwen2-0.5b',         // Model ID (default engine = real transformers.js)
  simulated: false,            // true → SimulatedEngine (tests / Node)
  systemPrompt: '...',         // Custom system prompt
  maxSteps: 4,                 // Max tool-calling iterations
  temperature: 0.3,
  maxTokens: 256,              // Cap generation length (keeps small models fast)
  loadOptions: {               // Passed to engine.load()
    device: 'auto',            // 'webgpu' | 'wasm' | 'auto'
    local: false,              // true → self-host under localModelPath
    localModelPath: '/models/',
    onProgress: (p) => console.log(p.message),
  },
  skills: ['web-search', 'calculator'], // Load built-in skills
  customSkills: [/* ... */],   // Inline skill definitions
  skillStoreOptions: {         // Remote registry config
    registryUrl: 'https://skills.example.com',
    allowRemote: true,
  },
});
```

---

## Package: `@local-llm-agent/react`

### Components & Hooks

```tsx
import { AgentProvider, useAgent, useAgentThinking, useAgentTools } from '@local-llm-agent/react';

function App() {
  return (
    <AgentProvider simulated={true} skills={['calculator']}>
      <ChatBox />
    </AgentProvider>
  );
}

function ChatBox() {
  const { isReady, isRunning, run, error } = useAgent();
  const { response } = useAgentThinking();
  const toolCalls = useAgentTools();

  // ...
}
```

---

## Built-in Skills (Tools)

The SDK bundles ready-to-use skills. Enable them by id via
`createAgent({ skills: [...] })` — they're pre-registered, so no network fetch
is needed. Import the definitions directly with `import { BUILTIN_SKILLS } from '@local-llm-agent/sdk'`.

| Skill id | Type | What it does | Parameters |
|----------|------|--------------|------------|
| `web-search` | `rest` | **Real general web search** — parses DuckDuckGo's HTML results page (`html.duckduckgo.com/html/`) and returns the top result titles, snippets, and URLs. Reaches arbitrary sites (GitHub, museum/library catalogs, government docs, news), not just Wikipedia. | `query` |
| `wikipedia` | `rest` | Read a specific Wikipedia article's text; `find` returns the passage around a keyword (e.g. "perigee"). | `title`, `find?`, `maxChars?` |
| `http-request` | `rest` | Call any REST/API endpoint (GET/POST/PUT/DELETE/PATCH). | `url`, `method?`, `body?` |
| `file-read` | `browser-api` | Read a file from a user-granted local folder. | `path` |
| `file-write` | `browser-api` | Write/create a file in the granted folder. | `path`, `content` |
| `file-glob` | `browser-api` | Find files by glob pattern (`**/*.ts`, `src/*.md`). | `pattern` |
| `mcp-call` | `mcp` | Invoke a named tool on an MCP server (SSE). | `serverUrl`, `toolName`, `arguments?` |

> **`web-search` history:** it was originally Wikipedia's `origin=*` search API
> (CORS-safe from the browser), replacing an even earlier DuckDuckGo Instant
> Answer API that returned nothing for general queries. But a Wikipedia-only
> search meant the agent could never reach GitHub, news, or other non-Wikipedia
> reference sites — a real capability ceiling confirmed by running the GAIA
> benchmark (see **GAIA benchmark harness** below). It now parses DuckDuckGo's
> HTML results page instead, using a browser User-Agent + Referer header to
> avoid the bot-detection "anomaly" challenge page (light, occasional use only
> — this endpoint is undocumented/ToS-restricted for heavy automation). If it
> ever returns a blocked/no-results message, fall back to the `wikipedia` tool.
> `wikipedia` still uses Wikipedia's own CORS-safe API.

```ts
const agent = await createAgent({
  model: 'qwen2-1.5b',
  skills: ['web-search', 'wikipedia', 'file-read', 'file-glob', 'http-request', 'mcp-call'],
});
```

### File tools and the File System Access API

`file-read` / `file-write` / `file-glob` operate on a directory the **user**
grants via the browser's File System Access API (Chrome/Edge, HTTPS or
localhost). Because the picker requires a user gesture, authorize the folder
from a click handler and hand the agent the handle so tools don't prompt
mid-run:

```ts
grantButton.addEventListener('click', async () => {
  const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
  agent.setFileSystemRoot(dir);   // reused by all file tools
});
```

If no directory is pre-authorized, the first file tool call will attempt to
open the picker itself (which may be blocked without an active gesture).

### `http-request` & `mcp-call` notes

- `http-request` is subject to the browser's CORS policy — the target API must
  allow cross-origin requests from your origin.
- `mcp-call` POSTs a JSON-RPC `tools/call` to the MCP server's SSE endpoint.
  Pass tool arguments as a JSON string in `arguments`.

---

## Skill File Reference

See `skills/skill-schema.json` for the full JSON Schema, and
`packages/skill-store/src/builtins.ts` for the bundled skill definitions
(`web-search`, `http-request`, `file-read`/`write`/`glob`, `mcp-call`). A skill
has these key sections:

```yaml
id: my-skill
name: "My Skill"
version: "1.0.0"
tool:
  type: rest|mcp|function|browser-api
  # ... type-specific config
  parameters:
    param_name:
      type: string|number|boolean
      description: "..."
      required: true|false
  transform: "return response;"
  retry:
    maxAttempts: 2
    backoff: exponential
resultTemplate: "Output: {{key}}"
permissions:
  - network: "api.example.com"
```

---

## Package: `@local-llm-agent/harness`

Run **multiple tasks** on one page, each with its own trigger, all sharing a
single loaded model. A task is described by an **Agent File** (JSON).

### Agent File

```jsonc
{
  "id": "price-watcher",           // kebab-case, unique per page
  "name": "Price watcher",
  "systemPrompt": "You watch prices and summarize changes.",
  "skills": ["web-search", "http-request"],  // built-in skill ids
  "customSkills": [ /* inline SkillDefinition[] */ ],
  "maxSteps": 4,
  "maxTokens": 200,
  "temperature": 0.3,
  "trigger": { /* one of the three below */ },
  "enabled": true
}
```

### Triggers

**Manual** — runs only when you call `harness.runTask(id, prompt?)`:
```jsonc
{ "type": "manual", "promptTemplate": "optional default prompt" }
```

**Event** — runs on a DOM/custom event (debounced), capturing `{{value}}`:
```jsonc
{
  "type": "event",
  "target": "#price",          // CSS selector, or 'document' / 'window'
  "on": "change",              // 'input' | 'click' | 'submit' | 'custom:my-event'
  "debounceMs": 300,
  "promptTemplate": "Field changed to {{value}}. Summarize."
}
```
`{{value}}` resolves to the target's `value` / `checked` / `textContent`;
`{{detail}}` to a CustomEvent's `detail` (JSON).

**Schedule** — runs on an interval and/or cron, **while the tab is open**:
```jsonc
{
  "type": "schedule",
  "interval": "30s",           // '30s' | '5m' | '1h' | '2h30m' | ms number
  "cron": "0 */6 * * *",       // optional 5-field cron (min hour dom month dow)
  "pauseWhenHidden": true,     // skip ticks while the tab is hidden (default true)
  "promptTemplate": "Do the periodic check."
}
```
> Cron here is *soft*: it fires only while the page is open. True background
> scheduling needs a Service Worker or a server (out of scope).

### Authoring tasks in HTML

Declare tasks inline; the harness auto-discovers them:
```html
<script type="application/agent+json">
{ "id": "chat", "systemPrompt": "...", "trigger": { "type": "manual" } }
</script>
```

### `createAgentHarness(options)`

```ts
import { createAgentHarness } from '@local-llm-agent/sdk';

const harness = await createAgentHarness({
  model: 'qwen2-0.5b',       // shared engine, loaded once
  discover: true,            // read <script type="application/agent+json"> blocks
  tasks: [/* AgentFile[] */],// and/or pass tasks inline
  concurrency: 'queue',      // 'queue' | 'skip' | 'restart'
  autoStart: true,           // arm triggers immediately
});

harness.on((e) => {
  // e.type: 'task_triggered' | 'task_agent' | 'task_done' | 'task_skipped' | 'task_error'
  // every event carries e.taskId
});

harness.runTask('chat', 'What is 2+2?');   // manual run
harness.setFileSystemRoot(dirHandle);        // authorize file tools for all tasks
harness.stop();                              // disarm triggers, abort runs
```

### Concurrency

A single engine can only generate one stream at a time, so **all runs are
serialized** globally. Per-task, the `concurrency` policy decides what happens
when a task is re-triggered while it's still running:

| Policy | Behavior |
|--------|----------|
| `queue` (default) | Runs the new request after the current one finishes |
| `skip` | Drops the new request (emits `task_skipped`) |
| `restart` | Aborts the current run and starts the new one |

### `AgentHarness` API

```ts
class AgentHarness {
  addTask(file: AgentFile): void;
  listTasks(): string[];
  runTask(id: string, prompt?: string): void;
  setFileSystemRoot(handle: unknown): void;
  start(): void;   // arm all enabled triggers
  stop(): void;    // disarm + abort
  on(cb: (e: HarnessEvent) => void): () => void;  // returns unsubscribe
}
```

### Helpers

```ts
import {
  parseAgentFile, validateAgentFile, discoverAgentFiles, fetchAgentFile,
} from '@local-llm-agent/sdk';
```

See `examples/harness-demo/` for a page running manual + event + schedule tasks.

---

## GAIA benchmark harness

`eval/scripts/run-gaia.ts` runs `NanoAgent` (with `OllamaEngine`) against the
[GAIA benchmark](https://huggingface.co/datasets/gaia-benchmark/GAIA)
validation set's no-file-attachment subset, scores each answer with GAIA's own
exact-match rule (`eval/scripts/gaia-scorer.ts`, ported from smolagents'
`gaia_scorer.py`), and writes a results JSON.

```bash
npx tsx eval/scripts/run-gaia.ts --model qwen2.5:7b --limit 10
npx tsx eval/scripts/run-gaia.ts --model llama3.2 --limit 10 --offset 10
```

| Flag | Default | Description |
|------|---------|--------------|
| `--model` | `qwen2.5:7b` | Ollama model tag to run |
| `--limit` | `10` | Number of tasks to run |
| `--offset` | `0` | Skip this many tasks first |
| `--level` | (all) | Restrict to GAIA difficulty level 1/2/3 |
| `--base-url` | `http://localhost:11434` | Ollama server URL |
| `--out` | auto-named | Output JSON path |
| `--max-steps` | `10` | Agent ReAct step budget per task |
| `--max-tokens` | `800` | Token budget per generation |
| `--temperature` | `0.2` | Sampling temperature |
| `--timeout-ms` | `120000` | Per-task timeout before aborting |

The agent is configured with `web-search`, `wikipedia`, and a sandboxed
`calculator` tool, and a system prompt that requires it to look up every
needed fact individually, always use the calculator (never compute in its
head), and answer with a short `FINAL:`-prefixed value. Only one Ollama model
is loaded/tested at a time — the script does not run models concurrently
(useful on RAM-limited dev machines).

**Findings:** switching `web-search` from Wikipedia-only to real DuckDuckGo
search (see **Built-in Skills** above) took a 10-task smoke test (qwen2.5:7b)
from **0/10 → 1/10** correct, plus several additional near-misses that were
previously impossible (task required GitHub/museum sources the old tool
couldn't reach). A fuller 127-task run scored **6/127 (4.7%)** overall
(Level 1: 2/42, Level 2: 4/66, Level 3: 0/19; ~41s and ~3.3 steps/task avg).

> The GAIA dataset (`eval/gaia/`) and per-run result files (`eval/results/`)
> are **gitignored**. GAIA's license prohibits resharing the dataset outside a
> gated/private repo, and result files quote verbatim question/answer text
> from it — never commit either directory.

---

## ERP throughput-accounting benchmark

A second benchmark for when the goal is a **domain-specific task set over
ERP-shaped data** instead of a general-knowledge benchmark like GAIA. Unlike
GAIA, the dataset is entirely synthetic (generated deterministically by a
seeded PRNG), so it has no license restriction and is committed to the repo
(`eval/erp/companies.json`, `eval/erp/tasks.json`).

It tests whether an agent applies Theory-of-Constraints **throughput
accounting** — not traditional cost/margin accounting — to a synthetic
manufacturer's period extract: work centers (available minutes), products
(price, totally variable cost, market demand, per-work-center routing
minutes), and operating expenses.

```bash
# 1. Generate (or regenerate) the dataset + tasks
npx tsx eval/scripts/generate-erp-benchmark.ts --companies 8 --seed 42

# 2. Run the agent against it
npx tsx eval/scripts/run-erp-benchmark.ts --model qwen2.5:7b --limit 16
```

| Flag | Default | Description |
|------|---------|--------------|
| `--model` | `qwen2.5:7b` | Ollama model tag to run |
| `--limit` | all tasks | Number of tasks to run |
| `--offset` | `0` | Skip this many tasks first |
| `--level` | (all) | Restrict to difficulty level 1/2/3 |
| `--type` | (all) | Restrict to one task type (e.g. `net_profit`) |
| `--base-url` | `http://localhost:11434` | Ollama server URL |
| `--max-steps` | `8` | Agent ReAct step budget per task |
| `--max-tokens` | `600` | Token budget per generation |
| `--timeout-ms` | `90000` | Per-task timeout before aborting |

### Dataset generator (`generate-erp-benchmark.ts`)

For each synthetic company: 4 work centers, 4–5 products (price, totally
variable cost → per-unit throughput, market demand, minutes-per-unit routing
at each work center), and operating expenses. Exactly one work center is
chosen as the binding **constraint** (available minutes less than what's
needed to satisfy full demand for every product); the generator nudges
routing data until the "highest $-throughput" product and the "highest T/CU
at the constraint" product genuinely diverge, so a naive margin-based
strategy and the correct throughput-accounting strategy disagree — the
interesting case throughput accounting is designed to catch. All derived
figures (optimal mix, total throughput, net profit, the T/CU vs.
margin-ranking mismatch) are independently computable from the raw data, so
ground truth is self-consistent and can be re-verified from `companies.json`
alone.

Each company yields 8 tasks across 3 difficulty levels:

| Level | Type | Example |
|-------|------|---------|
| 1 | `throughput_per_unit` | "What is Product A's per-unit throughput?" |
| 1 | `constraint_identification` | "Which work center is the constraint?" |
| 2 | `tcu_ranking` | "Which product has the highest T/CU at the constraint?" |
| 2 | `throughput_per_unit_ranking` | "Which product has the highest $ throughput per unit?" |
| 2 | `optimal_mix_units` | "How many units of Product D should be produced in the optimal mix?" |
| 3 | `total_throughput` | "What is the total throughput of the optimal mix?" |
| 3 | `net_profit` | "What is net profit (total throughput − operating expenses)?" |
| 3 | `throughput_accounting_trap` | "Would a margin-per-unit ranking recommend the same product as T/CU ranking? (Yes/No)" |

The `throughput_accounting_trap` task is the key discriminator: it directly
tests whether the model conflates traditional margin-per-unit reasoning with
correct constraint-aware throughput accounting.

### Agent setup (`run-erp-benchmark.ts`)

Each task run scopes the agent to exactly one company via a sandboxed
`erp-report` function-tool (actions: `list_work_centers`, `list_products`,
`get_product`, `get_work_center`, `get_operating_expenses`, `get_routing`) —
the company's data is baked into the tool's execute code (no filesystem/
network access), so nothing is pre-loaded into the prompt and the agent must
call the tool for every fact. A `calculator` tool (same as the GAIA harness)
handles arithmetic. The system prompt defines throughput-accounting
terminology precisely (T/CU, constraint, optimal mix) to keep the task about
reasoning/tool-use reliability rather than domain vocabulary.

### Scoring (`erp-scorer.ts`)

Type-aware (each task carries its own `answer_type`, unlike GAIA's shape-
guessing): `number` extracts the first numeric token from free text and
compares by value (after stripping `$`/`,`); `id` does normalized string
match, also accepting the expected name as a substring/whole-word inside a
longer sentence; `yes_no` matches a leading Yes/No token.

**Findings so far** (qwen2.5:7b, 16-task sample): **8/16 (50%)** overall —
**4/4** Level 1, **2/6** Level 2, **2/6** Level 3. The model got **2/2**
`throughput_accounting_trap` questions right (it doesn't naively equate
margin-per-unit with T/CU) but failed every `total_throughput`/`net_profit`
aggregation task — a genuine multi-step tool-call + arithmetic reliability
gap, confirmed (not a step-budget artifact) by re-running failing tasks with
a larger step/token budget and getting the same wrong answers.

---

## Model Presets

| Model ID | HuggingFace repo | Context | dtype (WebGPU) |
|----------|------------------|---------|----------------|
| `qwen2-0.5b` | `onnx-community/Qwen2.5-0.5B-Instruct` | 32768 | q4f16 (~0.5 GB) |
| `qwen2-1.5b` | `onnx-community/Qwen2.5-1.5B-Instruct` | 32768 | q4f16 (~1.1 GB) |
| `phi-3-mini-4k-instruct` | `onnx-community/Phi-3.5-mini-instruct-onnx-web` | 4096 | q4f16 (~2 GB) |
| `gemma-2-2b` | `onnx-community/gemma-2-2b-it` | 8192 | q4f16 (~1.6 GB) |

Models are fetched on first use and cached in the browser's Cache Storage.
The demo (`index.html`) defaults to `qwen2-1.5b` for better multi-step reasoning
and tool use; smaller/larger presets trade speed for capability.

---

## Security

| Concern | Mitigation |
|---------|------------|
| Skill files | SHA256 verification, sandboxed execution |
| Network access | User-visible permission prompts |
| Prompt injection | Role-based message framing, input sanitization |
| Resource exhaustion | Max steps, token budget, abort controller |
