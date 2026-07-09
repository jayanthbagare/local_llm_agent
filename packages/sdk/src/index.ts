// ── SDK: Unified Public API ──
// One import to get the full local LLM agent experience.
// Composes llm-engine, nano-agent, skill-store, and tool-bridge.

import { SimulatedEngine, WebGPUEngine, TransformersEngine } from '@local-llm-agent/llm-engine';
import { NanoAgent } from '@local-llm-agent/nano-agent';
import { SkillStore } from '@local-llm-agent/skill-store';
import { BUILTIN_SKILLS } from '@local-llm-agent/skill-store';
import { AgentHarness } from '@local-llm-agent/harness';
import type { AgentFile, HarnessOptions } from '@local-llm-agent/harness';
import { ToolBridge, createToolBridge } from '@local-llm-agent/tool-bridge';
import type { LLMEngine, LoadOptions } from '@local-llm-agent/llm-engine';
import type { NanoAgentConfig, AgentEvent } from '@local-llm-agent/nano-agent';
import type { SkillDefinition } from '@local-llm-agent/skill-store';

/** Options for creating a complete agent with createAgent() */
export interface CreateAgentOptions {
  /** Model ID to load (e.g., 'phi-3-mini-4k') */
  model?: string;
  /** Model load options */
  loadOptions?: Partial<LoadOptions>;
  /** Use simulated engine (no WebGPU required) */
  simulated?: boolean;
  /** Custom engine instance */
  engine?: LLMEngine;
  /** System prompt */
  systemPrompt?: string;
  /** Maximum agent steps per query */
  maxSteps?: number;
  /** Temperature for generation */
  temperature?: number;
  /** Top-P for generation */
  topP?: number;
  /** Max tokens per generation */
  maxTokens?: number;
  /** Skill IDs to enable (loads from bundled skills) */
  skills?: string[];
  /** Custom skill definitions */
  customSkills?: SkillDefinition[];
  /** Skill store options */
  skillStoreOptions?: { registryUrl?: string; allowRemote?: boolean; cacheTTL?: number };
}

/** The complete agent instance returned by createAgent */
export interface Agent {
  /** Run the agent with a user query */
  run(input: string): AsyncIterable<AgentEvent>;
  /** Register a new skill at runtime */
  registerSkill(skill: SkillDefinition): void;
  /** Register multiple skills */
  registerSkills(skills: SkillDefinition[]): void;
  /** Fetch a skill from remote registry */
  fetchSkill(id: string): Promise<SkillDefinition>;
  /** Get all registered skills */
  getSkills(): SkillDefinition[];
  /** Get engine info */
  getEngine(): LLMEngine;
  /**
   * Pre-authorize a local directory for the file tools (file-read/write/glob).
   * Pass a handle from `showDirectoryPicker()` invoked in a user gesture.
   */
  setFileSystemRoot(handle: unknown): void;
  /** Abort current execution */
  abort(): void;
  /** Clear conversation history */
  clearHistory(): void;
  /** Unload the model and free resources */
  destroy(): Promise<void>;
}

/**
 * Create a complete agent with one call.
 *
 * @example
 * ```ts
 * const agent = await createAgent({
 *   model: 'phi-3-mini-4k',
 *   skills: ['calculator'],
 *   simulated: true, // for testing without WebGPU
 * });
 *
 * for await (const event of agent.run('What is 42 * 2?')) {
 *   if (event.type === 'thinking') console.log('🤔', event.content);
 *   if (event.type === 'tool_call') console.log('🔧', event.tool);
 *   if (event.type === 'done') console.log('✅', event.response);
 * }
 * ```
 */
export async function createAgent(options: CreateAgentOptions = {}): Promise<Agent> {
  // 1. Create or use engine
  let engine: LLMEngine;
  if (options.engine) {
    engine = options.engine;
  } else if (options.simulated) {
    engine = new SimulatedEngine();
  } else {
    // Real in-browser inference via transformers.js (WebGPU, WASM fallback).
    // Fall back to the simulated engine only when no browser runtime exists.
    if (typeof navigator !== 'undefined') {
      engine = new TransformersEngine();
    } else {
      engine = new SimulatedEngine();
    }
  }

  // 2. Load model
  if (!engine.isLoaded() && (options.model || options.loadOptions)) {
    await engine.load({
      modelId: options.model || 'phi-3-mini-4k',
      ...options.loadOptions,
    });
  } else if (!engine.isLoaded() && !options.engine) {
    // Load simulated by default if no model specified
    await engine.load({ modelId: 'simulated' });
  }

  // 3. Create skill store, pre-loaded with the bundled built-in skills so
  //    `skills: ['web-search', 'file-read', ...]` resolves without a network.
  const skillStore = new SkillStore(options.skillStoreOptions);
  skillStore.registerBuiltins(BUILTIN_SKILLS);

  // 4. Create tool bridge
  const toolBridge = createToolBridge();

  // 5. Create agent
  const nanoAgentConfig: NanoAgentConfig = {
    engine,
    toolBridge,
    systemPrompt: options.systemPrompt,
    maxSteps: options.maxSteps,
    temperature: options.temperature,
    topP: options.topP,
    maxTokens: options.maxTokens,
  };

  const agent = new NanoAgent(nanoAgentConfig);

  // 6. Register custom skills
  if (options.customSkills) {
    agent.registerSkills(options.customSkills);
    for (const skill of options.customSkills) {
      skillStore.registerBuiltin(skill);
    }
  }

  // 7. Register built-in skills from store
  if (options.skills) {
    for (const skillId of options.skills) {
      const skill = skillStore.getBuiltin(skillId);
      if (skill) {
        agent.registerSkill(skill);
      } else {
        // Try to fetch from remote
        try {
          const fetched = await skillStore.fetch(skillId);
          agent.registerSkill(fetched);
        } catch {
          console.warn(`Skill "${skillId}" not found locally or remotely`);
        }
      }
    }
  }

  // 8. Return unified interface
  return {
    run: (input: string) => agent.run(input),
    registerSkill: (skill: SkillDefinition) => agent.registerSkill(skill),
    registerSkills: (skills: SkillDefinition[]) => agent.registerSkills(skills),
    fetchSkill: (id: string) => skillStore.fetch(id),
    getSkills: () => agent.getSkills(),
    getEngine: () => engine,
    setFileSystemRoot: (handle: unknown) => toolBridge.setFileSystemRoot(handle),
    abort: () => agent.abort(),
    clearHistory: () => agent.clearHistory(),
    destroy: async () => {
      agent.abort();
      await engine.unload();
    },
  };
}

/** Options for createAgentHarness(). */
export interface CreateHarnessOptions
  extends Partial<Pick<HarnessOptions, 'concurrency' | 'defaultSystemPrompt' | 'triggerDeps' | 'extraSkills'>> {
  /** Model id to load into the shared engine (e.g. 'qwen2-0.5b'). */
  model?: string;
  /** Model load options. */
  loadOptions?: Partial<LoadOptions>;
  /** Use the simulated engine (no WebGPU / no download). */
  simulated?: boolean;
  /** Provide a pre-built engine (skips creation/loading). */
  engine?: LLMEngine;
  /** Agent files (tasks) to register up front. */
  tasks?: AgentFile[];
  /** Also auto-discover <script type="application/agent+json"> tasks (browser). */
  discover?: boolean;
  /** Start (arm) triggers immediately (default true). */
  autoStart?: boolean;
}

/**
 * Create an event-driven multi-task harness backed by one shared, loaded
 * engine. Tasks can be passed inline, and/or discovered from the page.
 *
 * @example
 * ```ts
 * const harness = await createAgentHarness({
 *   model: 'qwen2-0.5b',
 *   discover: true,        // read <script type="application/agent+json"> blocks
 * });
 * harness.on((e) => console.log(e));
 * ```
 */
export async function createAgentHarness(options: CreateHarnessOptions = {}): Promise<AgentHarness> {
  // 1. Create + load a shared engine (same policy as createAgent).
  let engine: LLMEngine;
  if (options.engine) {
    engine = options.engine;
  } else if (options.simulated) {
    engine = new SimulatedEngine();
  } else {
    engine = typeof navigator !== 'undefined' ? new TransformersEngine() : new SimulatedEngine();
  }
  if (!engine.isLoaded() && (options.model || options.loadOptions)) {
    await engine.load({ modelId: options.model || 'qwen2-0.5b', ...options.loadOptions });
  } else if (!engine.isLoaded() && !options.engine) {
    await engine.load({ modelId: 'simulated' });
  }

  // 2. Build the harness.
  const harness = new AgentHarness({
    engine,
    concurrency: options.concurrency,
    defaultSystemPrompt: options.defaultSystemPrompt,
    triggerDeps: options.triggerDeps,
    extraSkills: options.extraSkills,
  });

  // 3. Register tasks (inline + discovered).
  const files: AgentFile[] = [...(options.tasks ?? [])];
  if (options.discover) {
    const { discoverAgentFiles } = await import('@local-llm-agent/harness');
    files.push(...discoverAgentFiles());
  }
  for (const file of files) harness.addTask(file);

  // 4. Arm triggers.
  if (options.autoStart !== false) harness.start();

  return harness;
}
const SDK = {
  createAgent,
  createAgentHarness,
  AgentHarness,
  SimulatedEngine,
  WebGPUEngine,
  TransformersEngine,
  NanoAgent,
  SkillStore,
  ToolBridge,
  createToolBridge,
  BUILTIN_SKILLS,
};

export default SDK;

// Re-export the harness API for multi-task, event-driven agents.
export {
  AgentHarness,
  createHarness,
  parseAgentFile,
  normalizeAgentFile,
  validateAgentFile,
  discoverAgentFiles,
  fetchAgentFile,
  createTrigger,
  renderTemplate,
} from '@local-llm-agent/harness';

export type {
  AgentFile,
  Trigger,
  TriggerType,
  ManualTrigger,
  EventTrigger,
  ScheduleTrigger,
  ConcurrencyPolicy,
  HarnessEvent,
  HarnessOptions,
} from '@local-llm-agent/harness';

// Re-export built-in skills so apps can inspect / customize them.
export {
  BUILTIN_SKILLS,
  getBuiltinSkill,
  webSearchSkill,
  httpRequestSkill,
  fileReadSkill,
  fileWriteSkill,
  fileGlobSkill,
  mcpCallSkill,
} from '@local-llm-agent/skill-store';

// Re-export key types for convenience
export type {
  LLMEngine,
  LoadOptions,
  Message,
  GenerateOptions,
  GenerateResult,
  Token,
  ToolCall,
  ToolDefinition,
  ModelInfo,
} from '@local-llm-agent/llm-engine';

export type {
  NanoAgentConfig,
  AgentEvent,
} from '@local-llm-agent/nano-agent';

export type {
  SkillDefinition,
  SkillTool,
  SkillTrigger,
  SkillParameter,
} from '@local-llm-agent/skill-store';

export type {
  ToolResult,
  TransportHandler,
} from '@local-llm-agent/tool-bridge';
