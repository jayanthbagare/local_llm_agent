# Browser-Native LLM Agent SDK — Project Plan

## 1. Overview

A drop-in JavaScript/TypeScript SDK that enables web apps to run a **local LLM in the browser via WebGPU** paired with a **nano-weight agent** orchestrator. The agent enriches LLM context by calling external APIs, MCP (Model Context Protocol) tools, and user-defined skills — all running client-side with optional server-assisted skill fetching.

```
┌─────────────────────────────────────────────────────────┐
│                      User Web App                        │
│  ┌───────────────────────────────────────────────────┐  │
│  │              @local-llm-agent/sdk                  │  │
│  │  ┌──────────┐  ┌──────────┐  ┌────────────────┐  │  │
│  │  │ WebGPU   │  │  Nano    │  │  Skill Store   │  │  │
│  │  │ LLM      │◄─┤  Agent   ├──┤  (local/cache) │  │  │
│  │  │ Engine   │  │  Loop    │  └───────┬────────┘  │  │
│  │  └──────────┘  └────┬─────┘          │           │  │
│  │                     │         ┌──────▼────────┐  │  │
│  │              ┌──────▼─────┐  │ Skill Server   │  │  │
│  │              │ Tool Bridge│  │ (optional CDN) │  │  │
│  │              │ MCP | REST │  └───────────────┘  │  │
│  │              └────────────┘                     │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

---

## 2. Package Structure (Monorepo)

```
local_llm_agent/
├── packages/
│   ├── llm-engine/          # WebGPU model loading & inference
│   ├── nano-agent/          # Agent loop, tool registry, context mgmt
│   ├── skill-store/         # Skill loading, caching, versioning
│   ├── tool-bridge/         # MCP client, REST tool adapter
│   ├── sdk/                 # Unified public API (re-exports all above)
│   └── react/               # Optional React bindings (<AgentProvider> etc.)
├── skills/                  # Built-in skill definitions
│   ├── web-search.skill.yaml
│   ├── code-interpreter.skill.yaml
│   ├── calendar.skill.yaml
│   ├── database-query.skill.yaml
│   └── ...
├── models/                  # Model config presets (not weights)
│   ├── phi-3-mini.json
│   ├── gemma-2b.json
│   ├── qwen2-0.5b.json
│   └── ...
├── docs/
├── examples/
│   ├── vanilla-js/
│   ├── react-demo/
│   └── nextjs-demo/
└── PLAN.md
```

---

## 3. Component Deep-Dive

### 3.1 `packages/llm-engine` — WebGPU Inference

**Responsibility:** Load quantized models, run inference on WebGPU, stream tokens.

**Key decisions:**
- **Runtime:** ONNX Runtime Web (`onnxruntime-web`) with WebGPU EP, or Transformers.js (HuggingFace) which wraps it.
- **Models:** GGUF or ONNX quantized (INT4/INT8) models under ~2GB for browser memory budgets.
- **Model hub:** Fetch from HuggingFace CDN with range-request progressive loading.

**API surface:**
```ts
interface LLMEngine {
  load(modelId: string, options?: LoadOptions): Promise<void>;
  generate(prompt: string, options?: GenerateOptions): AsyncIterable<string>;
  tokenize(text: string): number[];
  contextLength: number;
  isLoaded: boolean;
  unload(): void;
}
```

**Model config format (`models/phi-3-mini.json`):**
```json
{
  "id": "phi-3-mini-4k-instruct",
  "url": "https://huggingface.co/microsoft/Phi-3-mini-4k-instruct-onnx/resolve/main/...",
  "format": "onnx",
  "quantization": "int4",
  "contextLength": 4096,
  "requiredVRAM": "1.8GB",
  "chatTemplate": "{{ bos_token }}{% for msg in messages %}{{ '<|' + msg.role + '|>' + '\n' + msg.content + '<|end|>\n' }}{% endfor %}{% if add_generation_prompt %}{{ '<|assistant|>\n' }}{% endif %}"
}
```

---

### 3.2 `packages/nano-agent` — Agent Orchestrator

**Responsibility:** Run the agent loop: plan → call tools → observe → generate. Keep total size under ~5KB gzipped (hence "nano").

**Agent Loop (ReAct pattern):**
```
User Input + System Prompt
        │
        ▼
┌───────────────────────┐
│  LLM generates        │
│  Thought/Action/      │
│  Observation cycle    │◄──────────────┐
└───────┬───────────────┘               │
        │ Tool call detected?           │
        ▼ Yes                           │
┌───────────────────────┐               │
│  Tool Bridge executes │               │
│  skill/tool           │───────────────┘
└───────────────────────┘
        │ No
        ▼
  Final Response
```

**API surface:**
```ts
interface NanoAgent {
  run(input: string, context?: AgentContext): AsyncIterable<AgentEvent>;
  registerTool(tool: ToolDefinition): void;
  registerSkill(skill: SkillDefinition): void;
  abort(): void;
}

type AgentEvent =
  | { type: "thinking"; content: string }
  | { type: "tool_call"; tool: string; args: Record<string, unknown> }
  | { type: "tool_result"; tool: string; result: unknown }
  | { type: "token"; token: string }
  | { type: "done"; response: string };
```

**Context window management:**
- Sliding window with priority tiers (system prompt > recent turns > older turns > tool outputs)
- Token counting via engine's tokenizer
- Automatic summarization of overflow context

---

### 3.3 `packages/skill-store` — Skill Registry

**Responsibility:** Load, cache, validate, and version skill definitions. Skills can be bundled, fetched from CDN, or user-defined inline.

**Skill Definition Format (`skills/web-search.skill.yaml`):**

```yaml
# Skill: Web Search
id: web-search
name: "Web Search"
version: "1.2.0"
description: "Search the web and return structured results"
author: "local-llm-agent"
license: MIT
tags: [search, web, retrieval]

# What triggers this skill (used for auto-routing)
trigger:
  keywords: ["search", "find", "look up", "google", "web"]
  patterns:
    - "search for {query}"
    - "find information about {query}"

# The tool definition
tool:
  type: rest         # rest | mcp | function | browser-api
  method: GET
  url: "https://api.duckduckgo.com/?q={{query}}&format=json"
  headers:
    Accept: "application/json"
  
  # Parameter mapping: agent args → request
  parameters:
    query:
      type: string
      description: "Search query"
      required: true
  
  # Response transformation
  transform: |
    // JavaScript expression — runs sandboxed
    const items = response.RelatedTopics || [];
    return items.slice(0, 5).map(r => ({
      title: r.Text?.split(' - ')[0] || r.Text,
      url: r.FirstURL,
      snippet: r.Text
    }));

  # Error handling
  retry:
    maxAttempts: 2
    backoff: exponential

# How results are formatted for the LLM
resultTemplate: |
  Web search results for "{{query}}":
  {{#each results}}
  {{@index}}. **{{title}}** — {{snippet}} ({{url}})
  {{/each}}

# Required permissions (shown to user)
permissions:
  - network: "api.duckduckgo.com"
  - description: "Send search queries to DuckDuckGo"
```

**MCP Tool Skill (`skills/database-query.skill.yaml`):**
```yaml
id: database-query
name: "Database Query"
version: "1.0.0"
description: "Query a database via MCP server"
tags: [database, sql, mcp]

tool:
  type: mcp
  server:
    transport: sse          # sse | stdio (via WebWorker)
    url: "https://mcp.example.com/sse"
  
  # MCP tool name on the server
  toolName: "run_query"
  
  parameters:
    sql:
      type: string
      description: "SQL query to execute"
      required: true
  
  transform: |
    return { rows: response.rows, count: response.count };

resultTemplate: |
  Query returned {{count}} rows:
  {{#each rows}}
  {{json this}}
  {{/each}}

permissions:
  - network: "mcp.example.com"
  - description: "Execute database queries"
```

**Skill Store API:**
```ts
interface SkillStore {
  // Load from local bundled skills
  getBuiltin(id: string): SkillDefinition | undefined;
  listBuiltins(): SkillDefinition[];
  
  // Fetch from remote registry
  fetch(id: string, version?: string): Promise<SkillDefinition>;
  
  // Cache management (IndexedDB-backed)
  cache(id: string, skill: SkillDefinition): Promise<void>;
  getCached(id: string): Promise<SkillDefinition | undefined>;
  
  // User-defined inline skills
  register(skill: SkillDefinition): void;
  unregister(id: string): void;
}
```

---

### 3.4 `packages/tool-bridge` — Tool Execution

**Responsibility:** Execute tool calls from the agent. Supports REST APIs, MCP servers, browser APIs, and sandboxed JS functions.

**Bridge API:**
```ts
interface ToolBridge {
  execute(def: ToolDefinition, args: Record<string, unknown>): Promise<unknown>;
  
  // Transport adapters
  registerTransport(type: string, handler: TransportHandler): void;
}

interface TransportHandler {
  execute(def: ToolDefinition, args: Record<string, unknown>): Promise<unknown>;
}
```

**Built-in transports:**
| Transport | Description |
|-----------|-------------|
| `rest` | HTTP fetch with templating, retry, transform |
| `mcp` | Model Context Protocol (SSE + stdio via WebWorker) |
| `function` | Sandboxed JS execution (WebWorker + CSP) |
| `browser-api` | Geolocation, clipboard, notifications, etc. |

---

### 3.5 `packages/sdk` — Unified Public API

The thin entrypoint that composes all packages into a one-line setup.

```ts
import { createAgent } from '@local-llm-agent/sdk';

const agent = await createAgent({
  // LLM Engine
  model: 'phi-3-mini-4k-instruct',
  // or pass custom engine
  // engine: myCustomEngine,

  // Built-in skills to enable
  skills: ['web-search', 'calculator', 'code-interpreter'],

  // System prompt
  systemPrompt: 'You are a helpful assistant. Use tools when needed.',

  // Options
  maxSteps: 5,           // max tool-calling iterations
  temperature: 0.7,
  topP: 0.9,
});

// Stream agent events
for await (const event of agent.run('What is the weather in Tokyo?')) {
  switch (event.type) {
    case 'thinking':
      console.log('🤔', event.content);
      break;
    case 'tool_call':
      console.log('🔧 Calling', event.tool, event.args);
      break;
    case 'token':
      process.stdout.write(event.token);  // streaming
      break;
    case 'done':
      console.log('\n✅ Done');
      break;
  }
}
```

**Minimal bundle:** Tree-shakeable so apps only pay for what they use.
```
Full SDK:          ~50KB gzipped (with one model adapter)
Nano agent only:    ~5KB gzipped
Skill store only:   ~3KB gzipped
```

---

## 4. Data Flow (End-to-End)

```
┌─────────┐     ┌─────────────┐     ┌──────────┐     ┌─────────────┐
│  User   │────►│  Nano Agent │────►│ LLM      │────►│ Streaming   │
│  Input  │     │  (ReAct)    │     │ Engine   │     │ tokens      │
└─────────┘     └──────┬──────┘     └──────────┘     └─────────────┘
                       │
                       │ Tool call detected?
                       ▼
                ┌──────────────┐
                │ Skill Store  │──► Look up skill definition
                └──────┬───────┘
                       │
                       ▼
                ┌──────────────┐
                │ Tool Bridge  │──► Execute (REST / MCP / function)
                └──────┬───────┘
                       │
                       ▼
                ┌──────────────┐
                │ Transform    │──► Apply skill's transform & template
                │ & Format     │
                └──────┬───────┘
                       │
                       ▼
             Result appended to LLM context
                       │
                       ▼
                Back to LLM for next step or final answer
```

---

## 5. Skill File Distribution

### Local (Bundled)
Skills ship with the SDK under `skills/` and can be imported directly:
```ts
import webSearch from '@local-llm-agent/skills/web-search.skill.yaml';
agent.registerSkill(webSearch);
```

### Server-Side Registry (CDN)
A simple static file server hosts versioned skill files:
```
https://skills.local-llm-agent.dev/v1/web-search.skill.yaml
https://skills.local-llm-agent.dev/v1/calendar.skill.yaml
https://skills.local-llm-agent.dev/v1/manifest.json
```

`manifest.json`:
```json
{
  "version": "1",
  "skills": {
    "web-search": {
      "latest": "1.2.0",
      "url": "/v1/web-search.skill.yaml",
      "sha256": "abc123...",
      "size": 1024
    }
  }
}
```

### Caching Strategy
1. Check IndexedDB cache → 2. If stale, fetch with `If-None-Match` → 3. Fall back to bundled version
4. Validate SHA256 hash before execution
5. Skills execute in isolated WebWorker sandbox

---

## 6. Security Model

| Concern | Mitigation |
|---------|------------|
| Malicious skill files | SHA256 verification against registry, sandboxed execution |
| Network exfiltration | User-visible permission prompts per domain |
| LLM prompt injection | Input sanitization, role-based message framing |
| Resource exhaustion | Max steps, token budget, memory monitoring |
| Cross-origin | CORS-aware fetch with user-approved origins |

---

## 7. Implementation Phases

### Phase 1 — Foundation (Weeks 1-2)
- [x] Project scaffold (monorepo with pnpm/turborepo)
- [x] `llm-engine`: ONNX Runtime Web integration, single model (Phi-3-mini), basic token streaming
- [x] Skill definition schema & validator (JSON Schema)
- [x] `skill-store`: local bundled skill loading

### Phase 2 — Agent Core (Weeks 3-4)
- [x] `nano-agent`: ReAct loop, tool call parsing, context management
- [x] `tool-bridge`: REST transport, sandboxed function transport
- [x] End-to-end: user input → agent → tool → response

### Phase 3 — MCP & Developer Experience (Weeks 5-6)
- [x] MCP transport (SSE + WebWorker stdio bridge)
- [x] Remote skill registry + caching
- [x] React bindings (`@local-llm-agent/react`)
- [x] Permission system & user prompts

### Phase 4 — Polish & Ecosystem (Weeks 7-8)
- [x] Additional models (Gemma, Qwen, Llama)
- [x] More built-in skills (calendar, email, file system)
- [x] Documentation site, examples, playground
- [x] CI/CD, npm publishing, semantic versioning

---

## 8. Key Dependencies

| Package | Purpose |
|---------|---------|
| `onnxruntime-web` | WebGPU-accelerated model inference |
| `@modelcontextprotocol/sdk` | MCP client for SSE transport |
| `js-yaml` | Skill file parsing |
| `idb-keyval` | IndexedDB caching wrapper |
| `mustache` or `handlebars` | Result template rendering |

---

## 9. Competitive Landscape / Why This?

| Solution | LLM runs locally? | Agent loop? | MCP support? | Skill store? |
|----------|:---:|:---:|:---:|:---:|
| WebLLM (MLC) | ✅ | ❌ | ❌ | ❌ |
| Transformers.js | ✅ | ❌ | ❌ | ❌ |
| LangChain.js | ❌ (server) | ✅ | Partial | ❌ |
| OpenAI SDK | ❌ (API) | Partial | ❌ | ❌ |
| **This project** | ✅ | ✅ | ✅ | ✅ |

Unique value: **fully local LLM + agent + tool ecosystem in the browser, privacy-preserving, zero server inference cost.**

---

## 10. Open Questions

1. **Model format:** ONNX (via onnxruntime-web) vs GGUF (via transformers.js WIP WebGPU)? ONNX is more mature.
2. **Streaming from WebWorker:** Must bridge token streams via `postMessage` — need backpressure handling.
3. **WebGPU availability:** ~85% of Chrome users as of 2025. Fallback to WASM CPU inference?
4. **Skill marketplace:** Should users be able to publish/share custom skills? Requires trust model.
5. **Multi-modal:** Future support for vision models (Phi-3-vision, LLaVA)?
