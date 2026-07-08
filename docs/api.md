# Local LLM Agent — API Reference

## Architecture

```
@local-llm-agent/sdk  ← One import, everything unified
    ├── llm-engine    WebGPU inference (ONNX Runtime Web)
    ├── nano-agent    ReAct agent loop (~5KB gzipped)
    ├── skill-store   Skill registry + IndexedDB cache
    └── tool-bridge   REST, MCP, sandboxed function execution
```

---

## Quick Start

```ts
import { createAgent } from '@local-llm-agent/sdk';

const agent = await createAgent({
  model: 'phi-3-mini-4k',
  skills: ['calculator', 'web-search'],
  simulated: true, // for dev; remove for production WebGPU
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
| `WebGPUEngine` | Real ONNX Runtime Web inference | Browser, WebGPU, onnxruntime-web |
| `SimulatedEngine` | Deterministic simulation | Nothing — works everywhere |

### `LoadOptions`

```ts
interface LoadOptions {
  modelId: string;           // e.g., 'phi-3-mini-4k'
  modelUrl?: string;         // Override download URL
  device?: 'webgpu' | 'wasm' | 'auto';
  cache?: boolean;           // Cache model in IndexedDB
  onProgress?: (p: LoadProgress) => void;
}
```

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
User Input → LLM Reasoning → Tool Call? → Execute → Observe → LLM Reasoning → ...
                                    ↓ No
                              Final Response
```

1. User input is added to conversation
2. System prompt with tool descriptions is prepended
3. LLM generates a response (thinking + optional tool call)
4. If tool call: execute tool, add result to context, go back to step 3
5. If no tool call: emit final response
6. Max steps prevents infinite loops

---

## Package: `@local-llm-agent/sdk`

### `createAgent(options)`

The main entry point. Creates a fully configured agent in one call.

```ts
const agent = await createAgent({
  model: 'phi-3-mini-4k',      // Model ID
  simulated: false,            // Use real WebGPU engine
  systemPrompt: '...',         // Custom system prompt
  maxSteps: 5,                 // Max tool-calling iterations
  temperature: 0.7,
  skills: ['web-search', 'calculator'], // Load built-in skills
  customSkills: [...],         // Inline skill definitions
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

## Skill File Reference

See `skills/web-search.skill.yaml`, `skills/calculator.skill.yaml`, etc. for complete examples. Key sections:

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

## Model Presets

| Model | Size | Context | Format |
|-------|------|---------|--------|
| `phi-3-mini-4k` | ~2.2 GB | 4096 | ONNX INT4 |
| `gemma-2-2b` | ~1.6 GB | 8192 | ONNX INT4 |
| `qwen2-0.5b` | ~0.6 GB | 32768 | ONNX INT4 |

---

## Security

| Concern | Mitigation |
|---------|------------|
| Skill files | SHA256 verification, sandboxed execution |
| Network access | User-visible permission prompts |
| Prompt injection | Role-based message framing, input sanitization |
| Resource exhaustion | Max steps, token budget, abort controller |
