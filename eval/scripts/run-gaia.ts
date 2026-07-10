#!/usr/bin/env node
// ── GAIA benchmark harness ──
// Runs NanoAgent (+ OllamaEngine) against the GAIA validation set's
// no-file-attachment subset, scores answers with the official GAIA
// exact-match rule, and writes a results JSON + summary.
//
// Usage:
//   npx tsx eval/scripts/run-gaia.ts --model qwen2.5:7b --limit 10
//   npx tsx eval/scripts/run-gaia.ts --model llama3.2 --limit 10 --offset 10
//
// Only ONE Ollama model should be tested at a time (RAM is limited on this
// machine) — the script itself only ever loads the one model you pass via
// --model, and does not attempt to run multiple models concurrently. Stop
// the model in Ollama (`ollama stop <model>`) after a run if you want to
// free RAM before starting the next one.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAgent } from '../../packages/sdk/src/index.ts';
import { OllamaEngine } from '../../packages/llm-engine/src/ollama.ts';
import { questionScorer } from './gaia-scorer.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

interface GaiaTask {
  task_id: string;
  question: string;
  level: number;
  final_answer: string;
}

interface TaskResult {
  task_id: string;
  level: number;
  question: string;
  expected: string;
  predicted: string;
  correct: boolean;
  steps: number;
  tool_calls: number;
  duration_ms: number;
  error: string | null;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : 'true';
      opts[key] = val;
    }
  }
  return {
    model: opts.model || 'qwen2.5:7b',
    limit: opts.limit ? parseInt(opts.limit, 10) : 10,
    offset: opts.offset ? parseInt(opts.offset, 10) : 0,
    level: opts.level ? parseInt(opts.level, 10) : undefined,
    ollamaBaseUrl: opts['base-url'] || 'http://localhost:11434',
    outFile: opts.out || null,
    maxSteps: opts['max-steps'] ? parseInt(opts['max-steps'], 10) : 10,
    maxTokens: opts['max-tokens'] ? parseInt(opts['max-tokens'], 10) : 800,
    temperature: opts.temperature ? parseFloat(opts.temperature) : 0.2,
    timeoutMs: opts['timeout-ms'] ? parseInt(opts['timeout-ms'], 10) : 120_000,
  };
}

const SYSTEM_PROMPT =
  'You are a careful research assistant answering benchmark questions that have a single, ' +
  'exact, checkable final answer. You MUST: (1) identify every fact you need before answering, ' +
  '(2) look up EACH missing fact individually with a tool — never guess or estimate a number ' +
  'you could look up, (3) use the calculator tool for every arithmetic step — never compute in ' +
  'your head, (4) only give a FINAL answer after all lookups and calculations are done. ' +
  'Your FINAL answer must be as short as possible: just the number, word, or short phrase asked ' +
  'for — no units unless explicitly requested, no explanation, no punctuation unless part of the ' +
  'answer itself. Available tools: calculator (arithmetic), web-search (Wikipedia-backed search), ' +
  'wikipedia (read a specific Wikipedia page — pass a "find" keyword to get the exact passage). ' +
  'Give your final answer prefixed with FINAL:.';

function calculatorSkill() {
  return {
    id: 'calculator',
    name: 'Calculator',
    version: '1.0.0',
    description: 'Evaluates a mathematical expression and returns the numeric result.',
    tool: {
      type: 'function' as const,
      execute: 'return String(eval(params.expression));',
      parameters: {
        expression: { type: 'string' as const, description: 'Math expression, e.g. "256 * 128"', required: true },
      },
    },
    resultTemplate: '{{expression}} = {{result}}',
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`Timed out after ${ms}ms`));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

async function runTask(
  task: GaiaTask,
  opts: ReturnType<typeof parseArgs>,
): Promise<TaskResult> {
  const start = Date.now();
  let steps = 0;
  let toolCalls = 0;
  let predicted = '';
  let error: string | null = null;

  const engine = new OllamaEngine({ baseUrl: opts.ollamaBaseUrl, model: opts.model });

  try {
    const agent = await createAgent({
      engine,
      loadOptions: {},
      systemPrompt: SYSTEM_PROMPT,
      maxSteps: opts.maxSteps,
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
      skills: ['web-search', 'wikipedia'],
      customSkills: [calculatorSkill()],
    });

    const iterate = async () => {
      for await (const event of agent.run(task.question)) {
        if (event.type === 'tool_call') toolCalls++;
        if (event.type === 'done') {
          predicted = event.response;
          steps = event.steps;
        }
        if (event.type === 'error') {
          error = event.error;
        }
      }
    };

    await withTimeout(iterate(), opts.timeoutMs, () => {
      agent.abort();
    });
  } catch (err) {
    error = (err as Error)?.message || String(err);
  } finally {
    try {
      await engine.unload();
    } catch {
      /* ignore */
    }
  }

  const correct = !error && questionScorer(predicted, task.final_answer);

  return {
    task_id: task.task_id,
    level: task.level,
    question: task.question,
    expected: task.final_answer,
    predicted,
    correct,
    steps,
    tool_calls: toolCalls,
    duration_ms: Date.now() - start,
    error,
  };
}

async function main() {
  const opts = parseArgs();

  const dataPath = join(REPO_ROOT, 'eval', 'gaia', 'validation_no_file.json');
  if (!existsSync(dataPath)) {
    console.error(`Missing dataset file: ${dataPath}`);
    console.error('Run the GAIA export step first (see conversation history / eval/scripts/export-gaia.py).');
    process.exit(1);
  }

  let tasks: GaiaTask[] = JSON.parse(readFileSync(dataPath, 'utf-8'));
  if (opts.level) tasks = tasks.filter((t) => t.level === opts.level);
  tasks = tasks.slice(opts.offset, opts.offset + opts.limit);

  console.log(`Model: ${opts.model}`);
  console.log(`Tasks: ${tasks.length} (offset=${opts.offset}, limit=${opts.limit}${opts.level ? `, level=${opts.level}` : ''})`);
  console.log(`Ollama: ${opts.ollamaBaseUrl}`);
  console.log('');

  const results: TaskResult[] = [];
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    process.stdout.write(`[${i + 1}/${tasks.length}] ${task.task_id.slice(0, 8)} (L${task.level}) `);
    const result = await runTask(task, opts);
    results.push(result);
    const mark = result.correct ? '✓' : '✗';
    const short = result.error ? `ERROR: ${result.error}` : `got="${result.predicted}" expected="${result.expected}"`;
    console.log(`${mark} ${(result.duration_ms / 1000).toFixed(1)}s ${short}`);
  }

  const correctCount = results.filter((r) => r.correct).length;
  const errorCount = results.filter((r) => r.error).length;
  const accuracy = results.length > 0 ? correctCount / results.length : 0;

  const summary = {
    model: opts.model,
    total: results.length,
    correct: correctCount,
    errors: errorCount,
    accuracy,
    by_level: [1, 2, 3].map((lvl) => {
      const lvlResults = results.filter((r) => r.level === lvl);
      return {
        level: lvl,
        total: lvlResults.length,
        correct: lvlResults.filter((r) => r.correct).length,
      };
    }),
    avg_duration_ms: results.length > 0 ? results.reduce((s, r) => s + r.duration_ms, 0) / results.length : 0,
    avg_steps: results.length > 0 ? results.reduce((s, r) => s + r.steps, 0) / results.length : 0,
  };

  console.log('');
  console.log('── Summary ──');
  console.log(`Model:    ${summary.model}`);
  console.log(`Accuracy: ${correctCount}/${results.length} (${(accuracy * 100).toFixed(1)}%)`);
  console.log(`Errors:   ${errorCount}`);
  for (const lvl of summary.by_level) {
    if (lvl.total > 0) console.log(`  Level ${lvl.level}: ${lvl.correct}/${lvl.total}`);
  }
  console.log(`Avg duration: ${(summary.avg_duration_ms / 1000).toFixed(1)}s, avg steps: ${summary.avg_steps.toFixed(1)}`);

  const resultsDir = join(REPO_ROOT, 'eval', 'results');
  mkdirSync(resultsDir, { recursive: true });
  const outFile =
    opts.outFile ||
    join(resultsDir, `${opts.model.replace(/[:/]/g, '-')}_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(outFile, JSON.stringify({ summary, results }, null, 2));
  console.log(`\nWrote results to ${outFile}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
