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
    ├── @local-llm-agent/llm-engine    Real WebGPU/WASM (transformers.js) or local Ollama inference
    ├── @local-llm-agent/nano-agent    ReAct agent loop (~5KB gzipped)
    ├── @local-llm-agent/skill-store   Skill registry + IndexedDB cache
    ├── @local-llm-agent/tool-bridge   REST, MCP, sandboxed function execution
    └── @local-llm-agent/harness       Multi-task, event-driven orchestration
```

### Inference engines

| Engine | Where it runs | Notes |
|--------|---------------|-------|
| `TransformersEngine` | In-browser (WebGPU, WASM fallback) | Default. No server, no API keys. |
| `OllamaEngine` | Local [Ollama](https://ollama.com) server (Node/CLI) | Streams real tokens from `ollama serve` over `/api/chat`. Lets an agent use much larger/more capable models than fit in a browser's WASM/WebGPU memory ceiling. Disables extended "thinking" mode by default so responses land in `content` instead of silently exhausting the token budget on hidden chain-of-thought. |
| `SimulatedEngine` | Anywhere | Deterministic, no model download — used for tests/dev. |

## Skill Files

Skills are portable definitions (bundled in `packages/skill-store/src/builtins.ts`,
or authored as JSON/YAML and fetched from a CDN). The shape:

```yaml
# a web-search skill definition
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
| `web-search` | REST | **Real general web search** via DuckDuckGo's HTML results page (no API key). Reaches arbitrary sites — GitHub, museum/library catalogs, government docs, news — not just Wikipedia. |
| `wikipedia` | REST | Read a specific Wikipedia page (`find` a keyword) |
| `http-request` | REST | Call any REST/API endpoint (GET/POST/…) |
| `file-read` | Browser API | Read a file from a user-granted folder |
| `file-write` | Browser API | Write a file in the granted folder |
| `file-glob` | Browser API | Find files by glob (`**/*.ts`) |
| `mcp-call` | MCP | Invoke a tool on an MCP server (SSE) |

> `web-search` used to be Wikipedia-only, which meant the agent could never
> reach GitHub, news, or non-Wikipedia reference sites — a real capability
> ceiling confirmed by the GAIA benchmark below. It now parses DuckDuckGo's
> HTML results page (a browser User-Agent + Referer header avoids the
> bot-detection challenge page for light, occasional use).

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


## Multi-task harness (event-driven agents)

A single page can declare **many tasks**, each with its own trigger, all sharing
one loaded model. Triggers: **manual** (prompt/API), **event** (a DOM value
change, click, submit, or custom event), and **schedule** (interval or a soft
cron that runs while the tab is open).

Declare tasks inline and let the harness discover them:

```html
<script type="application/agent+json">
{ "id": "field-watcher", "systemPrompt": "React to changes.",
  "trigger": { "type": "event", "target": "#price", "on": "change",
               "promptTemplate": "Price changed to {{value}}. Summarize." } }
</script>
```

```ts
import { createAgentHarness } from '@local-llm-agent/sdk';

const harness = await createAgentHarness({ model: 'qwen2-0.5b', discover: true });
harness.on((e) => console.log(e.type, e.taskId));
harness.runTask('chat', 'Hello');   // manual run
```

See `examples/harness-demo/` (manual + event + schedule on one page) and
`docs/api.md` → **@local-llm-agent/harness** for the full API.


## Using a local Ollama model (bigger than a browser can hold)

For models too large for WebGPU/WASM memory, point the agent at a local
[Ollama](https://ollama.com) server instead of the browser engine:

```ts
import { createAgent, OllamaEngine } from '@local-llm-agent/sdk';

const engine = new OllamaEngine({ baseUrl: 'http://localhost:11434', model: 'qwen2.5:7b' });
const agent = await createAgent({ engine, skills: ['web-search', 'wikipedia'] });
```

Requires `ollama serve` running locally with the model pulled (`ollama pull qwen2.5:7b`).
`index.html` uses this engine by default (see `window.AGENT_CONFIG`).

## GAIA benchmark harness

`eval/scripts/run-gaia.ts` runs `NanoAgent` + `OllamaEngine` against the
[GAIA benchmark](https://huggingface.co/datasets/gaia-benchmark/GAIA) validation
set (no-file-attachment subset) and scores answers with GAIA's own exact-match
rule (ported from smolagents' `gaia_scorer.py`):

```bash
npx tsx eval/scripts/run-gaia.ts --model qwen2.5:7b --limit 10
```

One Ollama model is tested at a time (RAM-limited dev machine) — the script
never loads more than the one model passed via `--model`.

**Findings so far:** switching `web-search` from Wikipedia-only to real
DuckDuckGo search took a 10-task smoke test (qwen2.5:7b) from **0/10 → 1/10**
correct, with several additional near-misses (right data, wrong format/off-by-
one) that were previously impossible because the task required GitHub/museum
sources the old tool couldn't reach at all. A fuller 127-task run scored
**6/127 (4.7%)** overall (Level 1: 2/42, Level 2: 4/66, Level 3: 0/19),
averaging ~41s and ~3.3 steps per task — illustrating how much headroom
remains for a 7B local model on multi-step, tool-using benchmark tasks.

The GAIA dataset and per-run result files are **gitignored**: GAIA's license
prohibits resharing the dataset outside a gated/private repo, and result files
quote verbatim question/answer text from it.


## ERP throughput-accounting benchmark

A second, self-contained benchmark for cases where the goal is a **domain-specific
task set over ERP-shaped data** rather than a general-knowledge benchmark like
GAIA. It tests whether an agent can apply Theory-of-Constraints **throughput
accounting** (not traditional cost/margin accounting) to a synthetic
manufacturer's period data — work centers, products, routings, market demand,
operating expenses:

```bash
# 1. Generate the synthetic dataset + tasks (deterministic, safe to regenerate)
npx tsx eval/scripts/generate-erp-benchmark.ts --companies 8 --seed 42

# 2. Run the agent against it
npx tsx eval/scripts/run-erp-benchmark.ts --model qwen2.5:7b --limit 16
```

Each task scopes the agent to ONE company via a sandboxed `erp-report` tool
(`list_products`, `get_product`, `list_work_centers`, `get_operating_expenses`,
...) plus a `calculator` tool — nothing is pre-loaded into the prompt, so the
agent must look up every figure and compute the answer itself. Three levels:

1. **Level 1** — single-fact lookup (e.g. "what's Product A's throughput per unit?")
2. **Level 2** — ranking/mix reasoning (highest T/CU product, units in the optimal mix)
3. **Level 3** — full aggregation (total throughput, net profit) **and a "trap"
   question**: does the highest-margin-per-unit product match the highest-T/CU
   product? (Answer is "No" whenever a traditional cost-accounting view would
   prioritize the wrong product under the constraint — this is the whole point
   of throughput accounting.)

**Findings so far** (qwen2.5:7b, 16-task sample): **8/16 (50%)** overall —
**4/4 (100%)** on Level 1 lookups, **2/6 (33%)** on Level 2 ranking/mix, and
**2/6 (33%)** on Level 3. Notably, the model got **2/2 "trap" questions right**
(it doesn't naively equate margin-per-unit with T/CU) but failed every
multi-step total-throughput/net-profit aggregation — a real gap in chained
tool-call + arithmetic reliability, not a step-budget artifact (confirmed by
re-running with a larger step/token budget).

This dataset is entirely synthetic and generated by the script above (unlike
GAIA, it has no license restriction), so `eval/erp/companies.json` and
`eval/erp/tasks.json` are safe to commit and regenerate.


## License

MIT
