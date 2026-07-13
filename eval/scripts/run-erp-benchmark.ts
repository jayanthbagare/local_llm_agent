// ── ERP Throughput-Accounting benchmark harness ──
// Runs NanoAgent (+ OllamaEngine) against the synthetic ERP dataset generated
// by generate-erp-benchmark.ts. Each task asks the agent to look up figures
// via a sandboxed "erp-report" tool scoped to ONE company's period extract
// (work centers, products, routings, demand, operating expenses) and answer
// a Theory-of-Constraints throughput-accounting question. Scored with
// erp-scorer.ts (type-aware: number / product-or-workcenter-name / yes-no).
//
// Usage:
//   npx tsx eval/scripts/run-erp-benchmark.ts --model qwen2.5:7b --limit 16
//   npx tsx eval/scripts/run-erp-benchmark.ts --model llama3.2 --level 3
//
// Only ONE Ollama model is tested at a time (mirrors run-gaia.ts).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAgent } from '../../packages/sdk/src/index.ts';
import { OllamaEngine } from '../../packages/llm-engine/src/ollama.ts';
import type { SkillDefinition } from '../../packages/skill-store/src/types.ts';
import { scoreAnswer, type AnswerType } from './erp-scorer.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

interface WorkCenter {
  id: string;
  name: string;
  availableMinutes: number;
}
interface Product {
  id: string;
  name: string;
  price: number;
  totallyVariableCost: number;
  throughputPerUnit: number;
  demandUnits: number;
  routing: Record<string, number>;
}
interface Company {
  id: string;
  name: string;
  period: string;
  workCenters: WorkCenter[];
  products: Product[];
  operatingExpenses: number;
}
interface ErpTask {
  task_id: string;
  company_id: string;
  level: 1 | 2 | 3;
  type: string;
  question: string;
  expected_answer: string;
  answer_type: AnswerType;
}

interface TaskResult {
  task_id: string;
  company_id: string;
  level: number;
  type: string;
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
    limit: opts.limit ? parseInt(opts.limit, 10) : 999,
    offset: opts.offset ? parseInt(opts.offset, 10) : 0,
    level: opts.level ? (parseInt(opts.level, 10) as 1 | 2 | 3) : undefined,
    type: opts.type,
    ollamaBaseUrl: opts['base-url'] || 'http://localhost:11434',
    outFile: opts.out || null,
    maxSteps: opts['max-steps'] ? parseInt(opts['max-steps'], 10) : 8,
    maxTokens: opts['max-tokens'] ? parseInt(opts['max-tokens'], 10) : 600,
    temperature: opts.temperature ? parseFloat(opts.temperature) : 0.2,
    timeoutMs: opts['timeout-ms'] ? parseInt(opts['timeout-ms'], 10) : 90_000,
  };
}

const SYSTEM_PROMPT =
  'You are a financial analyst who uses Theory-of-Constraints THROUGHPUT ACCOUNTING (not traditional ' +
  'cost/margin accounting) to answer questions about a manufacturer\'s current period. You MUST use the ' +
  '"erp-report" tool to look up every fact you need (work centers, products, routings, demand, operating ' +
  'expenses) — never guess or assume a number. Use the "calculator" tool for every arithmetic step — never ' +
  'compute in your head. Key definitions: throughput per unit = selling price minus totally variable cost. ' +
  'A work center is the constraint if satisfying full market demand for every product would require more ' +
  'minutes than it has available. Under the constraint, prioritize products by throughput PER CONSTRAINT-' +
  'MINUTE (T/CU = throughput per unit ÷ minutes required at the constraint per unit), NOT by throughput per ' +
  'unit alone — those two rankings can differ. The optimal mix produces the highest-T/CU product up to its ' +
  'market demand, then the next, and so on, until the constraint\'s available minutes run out (the last ' +
  'product in the sequence may be only partially produced). Total throughput = sum of (units produced × ' +
  'throughput per unit) across all products. Net profit = total throughput − operating expenses. Give your ' +
  'FINAL answer as short as possible: just the number, name, or Yes/No asked for — no units, no explanation ' +
  'unless explicitly requested. Give your final answer prefixed with FINAL:.';

function calculatorSkill(): SkillDefinition {
  return {
    id: 'calculator',
    name: 'Calculator',
    version: '1.0.0',
    description: 'Evaluates a mathematical expression and returns the numeric result.',
    tool: {
      type: 'function',
      execute: 'return String(eval(params.expression));',
      parameters: {
        expression: { type: 'string', description: 'Math expression, e.g. "4160 - 2010"', required: true },
      },
    },
    resultTemplate: '{{expression}} = {{result}}',
  };
}

/**
 * Builds a sandboxed "erp-report" tool scoped to a single company. The
 * company's data is embedded as a JSON literal in the generated `execute`
 * code (FunctionTransport runs it via `new Function(...)` with no file/
 * network access — see packages/tool-bridge/src/bridge.ts), so the agent
 * must call the tool with an `action` to retrieve any figure; nothing is
 * pre-loaded into the prompt.
 */
function erpReportSkill(company: Company): SkillDefinition {
  const dataLiteral = JSON.stringify(company);
  return {
    id: 'erp-report',
    name: 'ERP Report',
    version: '1.0.0',
    description:
      `Look up ${company.name}'s current-period ERP data: work centers (available minutes), products ` +
      `(price, totally variable cost, market demand, routing minutes per work center), and operating ` +
      `expenses. Call with an "action" to retrieve specific data — never guess these numbers.`,
    tool: {
      type: 'function',
      parameters: {
        action: {
          type: 'string',
          description:
            'One of: "list_work_centers", "list_products", "get_product" (needs productName), ' +
            '"get_work_center" (needs workCenterName), "get_operating_expenses", "get_routing" ' +
            '(needs productName; returns minutes required per work center for that product).',
          required: true,
          enum: [
            'list_work_centers',
            'list_products',
            'get_product',
            'get_work_center',
            'get_operating_expenses',
            'get_routing',
          ],
        },
        productName: { type: 'string', description: 'Product name, e.g. "Product A"' },
        workCenterName: { type: 'string', description: 'Work center name, e.g. "Cutting"' },
      },
      execute: `
        const data = ${dataLiteral};
        const action = params.action;
        const norm = (s) => String(s || '').toLowerCase().trim();
        const findProduct = (name) => data.products.find((p) => norm(p.name) === norm(name) || norm(p.name).includes(norm(name)));
        const findWc = (name) => data.workCenters.find((w) => norm(w.name) === norm(name) || norm(w.name).includes(norm(name)));
        const wcNameById = (id) => { const w = data.workCenters.find((x) => x.id === id); return w ? w.name : id; };

        if (action === 'list_work_centers') {
          return { workCenters: data.workCenters.map((w) => ({ name: w.name, availableMinutes: w.availableMinutes })) };
        }
        if (action === 'list_products') {
          return { products: data.products.map((p) => ({ name: p.name, price: p.price, totallyVariableCost: p.totallyVariableCost, throughputPerUnit: p.throughputPerUnit, demandUnits: p.demandUnits })) };
        }
        if (action === 'get_product') {
          const p = findProduct(params.productName);
          if (!p) return { error: 'Product not found. Use list_products to see valid names.' };
          const routing = {};
          for (const wcId of Object.keys(p.routing)) routing[wcNameById(wcId)] = p.routing[wcId];
          return { name: p.name, price: p.price, totallyVariableCost: p.totallyVariableCost, throughputPerUnit: p.throughputPerUnit, demandUnits: p.demandUnits, minutesPerUnitByWorkCenter: routing };
        }
        if (action === 'get_work_center') {
          const w = findWc(params.workCenterName);
          if (!w) return { error: 'Work center not found. Use list_work_centers to see valid names.' };
          return { name: w.name, availableMinutes: w.availableMinutes };
        }
        if (action === 'get_operating_expenses') {
          return { operatingExpenses: data.operatingExpenses, period: data.period, company: data.name };
        }
        if (action === 'get_routing') {
          const p = findProduct(params.productName);
          if (!p) return { error: 'Product not found. Use list_products to see valid names.' };
          const routing = {};
          for (const wcId of Object.keys(p.routing)) routing[wcNameById(wcId)] = p.routing[wcId];
          return { product: p.name, minutesPerUnitByWorkCenter: routing };
        }
        return { error: 'Unknown action. Use one of: list_work_centers, list_products, get_product, get_work_center, get_operating_expenses, get_routing.' };
      `,
    },
    // No resultTemplate: the tool bridge's template engine is regex-only
    // (no conditionals), and results here are structured objects that vary
    // per action — falls back to pretty-printed JSON (see NanoAgent's
    // _formatToolResult), which is exactly what we want the model to read.
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
  task: ErpTask,
  company: Company,
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
      customSkills: [erpReportSkill(company), calculatorSkill()],
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

  const correct = !error && scoreAnswer(predicted, task.expected_answer, task.answer_type);

  return {
    task_id: task.task_id,
    company_id: task.company_id,
    level: task.level,
    type: task.type,
    question: task.question,
    expected: task.expected_answer,
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

  const companiesPath = join(REPO_ROOT, 'eval', 'erp', 'companies.json');
  const tasksPath = join(REPO_ROOT, 'eval', 'erp', 'tasks.json');
  if (!existsSync(companiesPath) || !existsSync(tasksPath)) {
    console.error(`Missing dataset files under eval/erp/.`);
    console.error('Generate them first: npx tsx eval/scripts/generate-erp-benchmark.ts');
    process.exit(1);
  }

  const companies: Company[] = JSON.parse(readFileSync(companiesPath, 'utf-8'));
  const companyById = new Map(companies.map((c) => [c.id, c]));

  let tasks: ErpTask[] = JSON.parse(readFileSync(tasksPath, 'utf-8'));
  if (opts.level) tasks = tasks.filter((t) => t.level === opts.level);
  if (opts.type) tasks = tasks.filter((t) => t.type === opts.type);
  tasks = tasks.slice(opts.offset, opts.offset + opts.limit);

  console.log(`Model: ${opts.model}`);
  console.log(
    `Tasks: ${tasks.length} (offset=${opts.offset}, limit=${opts.limit}${opts.level ? `, level=${opts.level}` : ''}${opts.type ? `, type=${opts.type}` : ''})`,
  );
  console.log(`Ollama: ${opts.ollamaBaseUrl}`);
  console.log('');

  const results: TaskResult[] = [];
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const company = companyById.get(task.company_id);
    if (!company) {
      console.log(`[${i + 1}/${tasks.length}] ${task.task_id} SKIPPED (company ${task.company_id} not found)`);
      continue;
    }
    process.stdout.write(`[${i + 1}/${tasks.length}] ${task.task_id} (L${task.level} ${task.type}) `);
    const result = await runTask(task, company, opts);
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
    by_type: Array.from(new Set(results.map((r) => r.type))).map((type) => {
      const typeResults = results.filter((r) => r.type === type);
      return {
        type,
        total: typeResults.length,
        correct: typeResults.filter((r) => r.correct).length,
      };
    }),
    avg_duration_ms: results.length > 0 ? results.reduce((s, r) => s + r.duration_ms, 0) / results.length : 0,
    avg_steps: results.length > 0 ? results.reduce((s, r) => s + r.steps, 0) / results.length : 0,
    avg_tool_calls: results.length > 0 ? results.reduce((s, r) => s + r.tool_calls, 0) / results.length : 0,
  };

  console.log('');
  console.log('── Summary ──');
  console.log(`Model:    ${summary.model}`);
  console.log(`Accuracy: ${correctCount}/${results.length} (${(accuracy * 100).toFixed(1)}%)`);
  console.log(`Errors:   ${errorCount}`);
  for (const lvl of summary.by_level) {
    if (lvl.total > 0) console.log(`  Level ${lvl.level}: ${lvl.correct}/${lvl.total}`);
  }
  console.log('By type:');
  for (const t of summary.by_type) {
    console.log(`  ${t.type}: ${t.correct}/${t.total}`);
  }
  console.log(
    `Avg duration: ${(summary.avg_duration_ms / 1000).toFixed(1)}s, avg steps: ${summary.avg_steps.toFixed(1)}, avg tool calls: ${summary.avg_tool_calls.toFixed(1)}`,
  );

  const resultsDir = join(REPO_ROOT, 'eval', 'results');
  mkdirSync(resultsDir, { recursive: true });
  const outFile =
    opts.outFile ||
    join(
      resultsDir,
      `erp-${opts.model.replace(/[:/]/g, '-')}_${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    );
  writeFileSync(outFile, JSON.stringify({ summary, results }, null, 2));
  console.log(`\nWrote results to ${outFile}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
