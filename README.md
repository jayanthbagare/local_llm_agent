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

// Real in-browser inference (WebGPU / WASM). Model is downloaded once, then
// cached in the browser for subsequent loads.
const agent = await createAgent({
  model: 'qwen2-0.5b',
  skills: ['web-search', 'calculator', 'code-interpreter'],
  maxTokens: 256,
});

for await (const event of agent.run('What is 256 * 128?')) {
  if (event.type === 'token') process.stdout.write(event.token);
  if (event.type === 'tool_call') console.log('\n🔧 Calling:', event.tool);
  if (event.type === 'done') console.log('\n✅ Done');
}
```

## Architecture

```
@local-llm-agent/sdk  ←─ One import, everything unified
    ├── @local-llm-agent/llm-engine    Real WebGPU/WASM inference (transformers.js)
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

**Built-in skills** (enable via `createAgent({ skills: [...] })`):
| Skill id | Type | Description |
|----------|------|-------------|
| `web-search` | REST | DuckDuckGo web search (no API key) |
| `http-request` | REST | Call any REST/API endpoint (GET/POST/…) |
| `file-read` | Browser API | Read a file from a user-granted folder |
| `file-write` | Browser API | Write a file in the granted folder |
| `file-glob` | Browser API | Find files by glob (`**/*.ts`) |
| `mcp-call` | MCP | Invoke a tool on an MCP server (SSE) |

File tools use the browser's File System Access API — the user picks a folder
once. See `docs/api.md` → **Built-in Skills** for details and the
`setFileSystemRoot()` helper.

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
git clone https://github.com/jayanthbagare/local_llm_agent
cd local-llm-agent

# Install
pnpm install

# Build all packages
pnpm build

# Build the browser bundle for the root demo (dist-browser/sdk.js)
pnpm build:browser

# Run examples
cd examples/vanilla-js && pnpm dev
```

## Root demo (`index.html`) — real in-browser inference

The root `index.html` runs the **real** agent with **real** local LLM inference
(no simulation): it loads a quantized model and runs it in the browser via WebGPU
(WASM fallback) using
[`@huggingface/transformers`](https://github.com/huggingface/transformers.js).

```bash
pnpm install
pnpm build:browser   # produces dist-browser/sdk.js (agent loop + engine, bundled)
./run-server.sh      # serves at http://localhost:8000 (auto-builds if needed)
```

Open http://localhost:8000. The model **auto-loads** on page open and you can
chat. Arithmetic is handled by a real sandboxed `calculator` tool via the
agent's ReAct loop.

### Admin-baked model (end users don't choose)

End users do **not** pick a model. Whoever deploys the page configures a single
model via the `window.AGENT_CONFIG` block at the top of `index.html`:

```js
window.AGENT_CONFIG = {
  model: 'qwen2-0.5b',        // see Model Presets in docs/api.md
  local: false,               // true → self-host files under /models/<repo>/
  localModelPath: '/models/',
  modelUrl: null,             // override repo/folder name if needed
  systemPrompt: 'You are a concise local assistant...',
  maxSteps: 4,
  maxTokens: 256,
  temperature: 0.3,
};
```

### Download once, then cached

- The model is downloaded **at most once per user**. transformers.js stores the
  files in the browser's **Cache Storage** (`transformers-cache`), so subsequent
  visits load offline with **no network**. Verify in DevTools → Application →
  Cache Storage.
- `local: false` (default) downloads once from the HuggingFace CDN.
- `local: true` serves the model from **your own origin** under
  `localModelPath/<repo>/` (no HuggingFace dependency). The folder must mirror the
  HuggingFace repo layout (`onnx/model_q4f16.onnx`, `tokenizer.json`, `config.json`, ...).

### Notes

- `@huggingface/transformers` is loaded from a CDN via the `<script type="importmap">`
  in `index.html`; everything else is bundled into `dist-browser/sdk.js`.
- Requires **Chrome/Edge 113+** for WebGPU. Smaller models (e.g. Qwen2.5-0.5B) also
  run on the WASM CPU fallback, just slower — the page tells you which one is active.


## License

MIT
