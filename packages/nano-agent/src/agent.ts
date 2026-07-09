// ── Nano Agent ──
// Lightweight ReAct (Reasoning + Acting) agent loop.
// Orchestrates: user input → LLM reasoning → tool calls → observation → final answer.

import type { LLMEngine, Message, GenerateOptions, ToolDefinition, ToolCall } from '@local-llm-agent/llm-engine';
import { countMessageTokens } from '@local-llm-agent/llm-engine';
import type { SkillDefinition, SkillParameter } from '@local-llm-agent/skill-store';
import type { ToolBridge, ToolResult } from '@local-llm-agent/tool-bridge';

/** Events emitted during agent execution */
export type AgentEvent =
  | { type: 'thinking'; content: string }
  | { type: 'tool_call'; tool: string; args: Record<string, unknown> }
  | { type: 'tool_result'; tool: string; result: ToolResult }
  | { type: 'token'; token: string }
  | { type: 'done'; response: string; steps: number }
  | { type: 'error'; error: string };

/** Configuration for the NanoAgent */
export interface NanoAgentConfig {
  engine: LLMEngine;
  toolBridge: ToolBridge;
  /** Maximum agent steps (tool call + response cycles) */
  maxSteps?: number;
  /** System prompt prepended to every conversation */
  systemPrompt?: string;
  /** LLM generation options */
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  /** Max context tokens before summarization */
  maxContextTokens?: number;
}

const DEFAULT_SYSTEM_PROMPT = `You are a helpful AI assistant running locally in the browser.
You have access to tools. When you need to use a tool, respond with a JSON tool call block:

\`\`\`json
{
  "name": "tool_name",
  "arguments": { "arg1": "value1" }
}
\`\`\`

Think carefully before using tools. Explain your reasoning first, then make the tool call.
After receiving tool results, synthesize a clear, concise response for the user.`;

export class NanoAgent {
  private engine: LLMEngine;
  private toolBridge: ToolBridge;
  private config: Required<Omit<NanoAgentConfig, 'engine' | 'toolBridge'>>;
  private messages: Message[] = [];
  private skills = new Map<string, SkillDefinition>();
  private _aborted = false;

  constructor(config: NanoAgentConfig) {
    this.engine = config.engine;
    this.toolBridge = config.toolBridge;
    this.config = {
      maxSteps: config.maxSteps ?? 5,
      systemPrompt: config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      temperature: config.temperature ?? 0.7,
      topP: config.topP ?? 0.9,
      maxTokens: config.maxTokens ?? 2048,
      maxContextTokens: config.maxContextTokens ?? 8192,
    };
  }

  /** Register a skill for the agent to use */
  registerSkill(skill: SkillDefinition): void {
    this.skills.set(skill.id, skill);
  }

  /** Register multiple skills */
  registerSkills(skills: SkillDefinition[]): void {
    for (const skill of skills) this.registerSkill(skill);
  }

  /** Get registered skills */
  getSkills(): SkillDefinition[] {
    return [...this.skills.values()];
  }

  /** Get the current conversation messages */
  getMessages(): Message[] {
    return [...this.messages];
  }

  /** Set conversation messages (e.g., restore from history) */
  setMessages(messages: Message[]): void {
    this.messages = [...messages];
  }

  /** Clear conversation history */
  clearHistory(): void {
    this.messages = [];
  }

  /** Run the agent on user input */
  async *run(input: string): AsyncIterable<AgentEvent> {
    this._aborted = false;

    // Add user message
    this.messages.push({ role: 'user', content: input });
    this._trimContext();

    let steps = 0;

    while (steps < this.config.maxSteps && !this._aborted) {
      steps++;

      // Build system prompt with tool descriptions
      const tools = this._buildToolDefinitions();
      const systemPrompt = this._buildSystemPrompt(tools);

      // Prepare messages for LLM
      const generationMessages: Message[] = [
        { role: 'system', content: systemPrompt },
        ...this.messages,
      ];

      // Generate response
      const genOptions: GenerateOptions = {
        messages: generationMessages,
        temperature: this.config.temperature,
        topP: this.config.topP,
        maxTokens: this.config.maxTokens,
        tools: tools.length > 0 ? tools : undefined,
        onToken: (token) => {
          // Emit token events for better streaming
          if (!token.includes('```json')) {
            // We'll emit thinking events instead of raw tokens
          }
        },
      };

      const result = await this.engine.generate(genOptions);
      const responseText = result.text;

      // Emit thinking event
      yield { type: 'thinking', content: responseText };

      // Check for tool calls
      if (result.toolCalls && result.toolCalls.length > 0) {
        for (const toolCall of result.toolCalls) {
          yield { type: 'tool_call', tool: toolCall.name, args: toolCall.arguments };

          // Execute tool
          const toolResult = await this._executeTool(toolCall);
          yield { type: 'tool_result', tool: toolCall.name, result: toolResult };

          // Add tool result to messages
          const formattedResult = this._formatToolResult(toolCall.name, toolResult);
          this.messages.push({
            role: 'tool',
            content: formattedResult,
            name: toolCall.name,
            toolCallId: toolCall.id,
          });
        }
        // Continue loop for next reasoning step
        continue;
      }

      // No tool calls — this is the final response
      this.messages.push({ role: 'assistant', content: responseText });
      yield { type: 'done', response: responseText, steps };
      return;
    }

    // Max steps reached
    if (!this._aborted) {
      const finalMsg = 'I wasn\'t able to complete the task within the allowed steps. Please try a simpler query.';
      this.messages.push({ role: 'assistant', content: finalMsg });
      yield { type: 'done', response: finalMsg, steps };
    }
  }

  /** Abort the current agent run */
  abort(): void {
    this._aborted = true;
    this.engine.abort();
    this.toolBridge.abort();
  }

  // ── Private ──

  private _buildSystemPrompt(tools: ToolDefinition[]): string {
    let prompt = this.config.systemPrompt;

    if (tools.length > 0) {
      prompt += '\n\n## Available Tools\n\n';
      for (const tool of tools) {
        prompt += `### ${tool.function.name}\n`;
        prompt += `${tool.function.description}\n`;
        prompt += `Parameters: ${JSON.stringify(tool.function.parameters)}\n\n`;
      }
    }

    return prompt;
  }

  private _buildToolDefinitions(): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    for (const skill of this.skills.values()) {
      tools.push({
        type: 'function',
        function: {
          name: skill.id,
          description: skill.description || skill.name,
          parameters: this._skillParamsToOpenAI(skill.tool.parameters || {}),
        },
      });
    }
    return tools;
  }

  private _skillParamsToOpenAI(params: Record<string, SkillParameter>): Record<string, unknown> {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [name, param] of Object.entries(params)) {
      properties[name] = {
        type: param.type,
        description: param.description,
      };
      if (param.enum) (properties[name] as any).enum = param.enum;
      if (param.required) required.push(name);
    }

    return {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
    };
  }

  private async _executeTool(toolCall: ToolCall): Promise<ToolResult> {
    const skill = this.skills.get(toolCall.name);
    if (!skill) {
      return {
        success: false,
        error: `Unknown tool: ${toolCall.name}`,
        duration: 0,
      };
    }

    return this.toolBridge.execute(skill.tool, toolCall.arguments);
  }

  private _formatToolResult(name: string, result: ToolResult): string {
    if (!result.success) {
      return `Error executing ${name}: ${result.error}`;
    }

    const skill = this.skills.get(name);
    if (skill?.resultTemplate && result.data) {
      try {
        return this.toolBridge.applyTemplate(
          skill.resultTemplate,
          result.data as Record<string, unknown>,
          {} as any, // args already applied
        );
      } catch {
        // Fall back to JSON
      }
    }

    return JSON.stringify(result.data, null, 2);
  }

  private _trimContext(): void {
    // Ensure context doesn't exceed max tokens
    while (this.messages.length > 0) {
      const total = countMessageTokens(this.messages);
      if (total <= this.config.maxContextTokens) break;

      // Remove oldest non-system messages first
      const nonSystemIdx = this.messages.findIndex(m => m.role !== 'system');
      if (nonSystemIdx === -1) break;
      this.messages.splice(nonSystemIdx, 1);
    }
  }
}

/** Create a NanoAgent with default configuration */
export function createNanoAgent(config: NanoAgentConfig): NanoAgent {
  return new NanoAgent(config);
}
