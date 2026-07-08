# Local LLM Agent

> **Drop-in browser-native LLM agent SDK** — runs entirely in the browser with WebGPU acceleration, MCP tool calling, and portable skill definitions.

## What is this?

A JavaScript/TypeScript SDK that lets any web app have:
- 🤖 **Local LLM inference** via WebGPU (no server, no API keys)
- 🧠 **Agent loop** (ReAct pattern) for autonomous tool use
- 🔧 **Tool calling** via REST APIs, MCP servers, or sandboxed JS
- 📦 **Portable skill files** — bundled locally or fetched from a CDN
- 🔒 **Privacy-first** — all data stays in the browser

## Quick Start

```bash
npm install @local-llm-agent/sdk
```

```ts
import { createAgent } from '@local-llm-agent/sdk';

const agent = await createAgent({
  model: 'phi-3-mini-4k-instruct',
  skills: ['web-search', 'calculator', 'code-interpreter'],
});

for await (const event of agent.run('What is 256 * 128, and search the web for "WebGPU adoption 2025"?')) {
  if (event.type === 'token') process.stdout.write(event.token);
  if (event.type === 'tool_call') console.log('\n🔧 Calling:', event.tool);
  if (event.type === 'done') console.log('\n✅ Done');
}
```

## Architecture

```
@local-llm-agent/sdk  ←─ One import, everything unified
    ├── @local-llm-agent/llm-engine    WebGPU inference (ONNX Runtime Web)
    ├── @local-llm-agent/nano-agent    ReAct agent loop (~5KB gzipped)
    ├── @local-llm-agent/skill-store   Skill registry + IndexedDB cache
    └── @local-llm-agent/tool-bridge   REST, MCP, sandboxed function execution
```

## Skill Files

Skills are portable YAML definitions. Bundle them or fetch from a CDN:

```yaml
# skills/web-search.skill.yaml
id: web-search
version: "1.2.0"
tool:
  type: rest
  url: "https://api.duckduckgo.com/?q={{query}}&format=json"
  parameters:
    query:
      type: string
      required: true
resultTemplate: |
  Results for "{{query}}":
  {{#each results}}{{@index}}. {{title}} — {{url}}{{/each}}
```

**Built-in skills:**
| Skill | Type | Description |
|-------|------|-------------|
| `web-search` | REST | DuckDuckGo web search |
| `calculator` | Function | Sandboxed math evaluator |
| `code-interpreter` | Function | Sandboxed JS execution |
| `calendar` | Browser API | Calendar read/write |
| `file-system` | Browser API | File read/write |
| `database-query` | MCP | SQL via MCP server |

## Supported Models

| Model | Size | Context | Notes |
|-------|------|---------|-------|
| Phi-3 Mini (4K) | ~2.2 GB | 4K | Recommended default |
| Gemma 2 (2B) | ~1.6 GB | 8K | Good reasoning/size ratio |
| Qwen 2 (0.5B) | ~0.6 GB | 32K | Fastest, tiny footprint |

Models are fetched on-demand from HuggingFace CDN and cached in IndexedDB.

## Requirements

- **Browser:** Chrome 113+, Edge 113+ (WebGPU support)
- **Memory:** 4GB+ RAM recommended for Phi-3 Mini
- **Fallback:** WASM CPU inference when WebGPU not available (slower)

## Development

```bash
# Clone
git clone https://github.com/your-org/local-llm-agent
cd local-llm-agent

# Install
pnpm install

# Build all packages
pnpm build

# Run examples
cd examples/vanilla-js && pnpm dev
```

## License

MIT
