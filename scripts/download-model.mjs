#!/usr/bin/env node
/**
 * HuggingFace Model Downloader for Local LLM Agent
 *
 * Usage:
 *   node scripts/download-model.mjs <model-name>
 *   node scripts/download-model.mjs "microsoft/Phi-3-mini-4k-instruct-onnx"
 *   node scripts/download-model.mjs --search "phi-3 mini onnx"
 *   node scripts/download-model.mjs --search "gemma 2b" --prefer onnx
 */

import fs from 'node:fs';
import path from 'node:path';
import { createWriteStream } from 'node:fs';

const HF_API_BASE = 'https://huggingface.co/api';
const OUTPUT_DIR = path.resolve(process.cwd(), 'downloaded_models');

const PRIORITY_FILES = [
  /\.onnx$/i,
  /tokenizer\.json$/i,
  /tokenizer_config\.json$/i,
  /config\.json$/i,
  /generation_config\.json$/i,
  /preprocessor_config\.json$/i,
  /vocab\.json$/i,
  /merges\.txt$/i,
  /special_tokens_map\.json$/i,
];

const ONNX_PATTERNS = [/\.onnx$/i, /onnx/i, /ort/i, /webgpu/i];

// ── CLI ──

function parseArgs() {
  const args = process.argv.slice(2);
  const flags = { query: '', search: false, prefer: 'onnx', output: null, skipExisting: true };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--search' || arg === '-s') flags.search = true;
    else if (arg === '--prefer' || arg === '-p') flags.prefer = args[++i] || 'onnx';
    else if (arg === '--output' || arg === '-o') flags.output = args[++i];
    else if (arg === '--force' || arg === '-f') flags.skipExisting = false;
    else if (arg === '--help' || arg === '-h') { printHelp(); process.exit(0); }
    else if (!arg.startsWith('-')) flags.query = arg;
    i++;
  }

  if (!flags.query) { console.error('Error: Model name or search query required.\n'); printHelp(); process.exit(1); }
  return flags;
}

function printHelp() {
  console.log(`
  🤖 HuggingFace Model Downloader for Local LLM Agent

  Usage:
    node scripts/download-model.mjs <model-id>            Download a specific model
    node scripts/download-model.mjs --search "<query>"    Search HuggingFace for models

  Options:
    --search, -s     Search HuggingFace instead of direct download
    --prefer, -p     Preferred format (onnx, safetensors)
    --output, -o     Output directory [default: ./downloaded_models]
    --force, -f      Re-download existing files
    --help, -h       Show this help

  Examples:
    node scripts/download-model.mjs microsoft/Phi-3-mini-4k-instruct-onnx
    node scripts/download-model.mjs --search "phi-3 mini onnx"
    node scripts/download-model.mjs --search "qwen 0.5b onnx"
  `);
}

// ── HuggingFace API ──

async function fetchJSON(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${url}: ${resp.statusText}`);
  return resp.json();
}

async function searchModels(query, limit = 10) {
  const url = `${HF_API_BASE}/models?search=${encodeURIComponent(query)}&sort=downloads&direction=-1&limit=${limit}&full=false`;
  const results = await fetchJSON(url);

  // Also search with "onnx" appended
  if (!query.toLowerCase().includes('onnx')) {
    const onnxUrl = `${HF_API_BASE}/models?search=${encodeURIComponent(query + ' onnx')}&sort=downloads&direction=-1&limit=${Math.floor(limit / 2)}&full=false`;
    try {
      const onnxResults = await fetchJSON(onnxUrl);
      const existingIds = new Set(results.map(r => r.id));
      for (const r of onnxResults) {
        if (!existingIds.has(r.id)) results.push(r);
      }
    } catch { /* ignore */ }
  }

  return results.slice(0, limit);
}

async function getModelInfo(modelId) {
  return fetchJSON(`${HF_API_BASE}/models/${modelId}`);
}

async function downloadFile(modelId, filePath, outputPath, revision = 'main') {
  const url = `https://huggingface.co/${modelId}/resolve/${revision}/${filePath}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} downloading ${filePath}`);

  const totalSize = parseInt(resp.headers.get('content-length') || '0', 10);

  // Ensure directory
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (!resp.body) throw new Error(`No body for ${filePath}`);

  const reader = resp.body.getReader();
  const writeStream = createWriteStream(outputPath);
  let downloaded = 0;
  const startTime = Date.now();
  const fileLabel = path.basename(filePath);
  let lastLog = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      writeStream.write(Buffer.from(value));
      downloaded += value.length;

      const now = Date.now();
      if (now - lastLog < 200) continue;
      lastLog = now;

      if (totalSize > 0) {
        const pct = ((downloaded / totalSize) * 100).toFixed(1);
        const elapsed = (Date.now() - startTime) / 1000;
        const speed = (downloaded / (1024 * 1024)) / Math.max(elapsed, 0.1);
        process.stdout.write(`\r  ${fileLabel}: ${pct}% (${(downloaded / 1024 / 1024).toFixed(1)} MB) — ${speed.toFixed(1)} MB/s`);
      } else {
        process.stdout.write(`\r  ${fileLabel}: ${(downloaded / 1024 / 1024).toFixed(1)} MB`);
      }
    }
    process.stdout.write('\n');
  } finally {
    writeStream.end();
    await new Promise(resolve => writeStream.on('finish', resolve));
  }
}

// ── Model Selection ──

function isOnnxFile(filename) {
  return ONNX_PATTERNS.some(p => p.test(filename));
}

function isPriorityFile(filename) {
  return PRIORITY_FILES.some(p => p.test(filename)) || isOnnxFile(filename);
}

function scoreModel(model, prefer) {
  let score = 0;
  if (model.id.toLowerCase().includes('onnx')) score += 10;
  if (model.id.toLowerCase().includes('instruct')) score += 5;
  if (model.tags?.includes('conversational')) score += 3;
  if (prefer === 'onnx' && model.id.toLowerCase().includes('onnx')) score += 8;
  if (model.downloads) score += Math.log10(model.downloads + 1) * 0.5;
  if (model.likes) score += model.likes * 0.01;
  return score;
}

function selectFiles(files, prefer) {
  const selected = [];
  for (const file of files) {
    if (isPriorityFile(file.rfilename)) selected.push(file);
  }
  if (prefer === 'onnx' && !selected.some(f => isOnnxFile(f.rfilename))) {
    console.warn('  ⚠️  No ONNX files found. Look for models with "onnx" in the name.');
  }
  return selected;
}

function formatSize(bytes) {
  if (bytes > 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  if (bytes > 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  if (bytes > 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}

// ── Main ──

async function main() {
  const flags = parseArgs();
  const outputDir = flags.output || OUTPUT_DIR;

  console.log('🤖 HuggingFace Model Downloader\n');

  let modelId;

  if (flags.search) {
    console.log(`🔍 Searching for: "${flags.query}"\n`);
    const results = await searchModels(flags.query, 15);

    if (results.length === 0) {
      console.error('No models found. Try a different query.');
      process.exit(1);
    }

    const scored = results.map(m => ({ model: m, score: scoreModel(m, flags.prefer) }));
    scored.sort((a, b) => b.score - a.score);

    console.log('Top matching models:\n');
    scored.slice(0, 10).forEach(({ model }, i) => {
      const check = i === 0 ? '⭐' : '  ';
      const dl = model.downloads ? `${Math.round(model.downloads / 1000)}K` : '?';
      const tags = model.tags?.slice(0, 4).join(', ') || '';
      console.log(`  ${check} ${i + 1}. ${model.id}`);
      console.log(`      Downloads: ${dl} | Tags: ${tags || 'none'}\n`);
    });

    const top = scored[0];
    console.log(`✅ Auto-selecting top match: ${top.model.id} (score: ${top.score.toFixed(1)})`);
    modelId = top.model.id;
  } else {
    modelId = flags.query;
  }

  console.log(`\n📦 Model: ${modelId}`);
  console.log(`📂 Output: ${outputDir}/${modelId.replace(/\//g, '_')}\n`);

  // Fetch file listing
  console.log('📋 Fetching file listing...');
  let modelInfo;
  let files;
  try {
    modelInfo = await getModelInfo(modelId);
    files = modelInfo.siblings || [];
  } catch (err) {
    console.error(`\n❌ Failed: ${err.message}`);
    console.error(`   Check: https://huggingface.co/${modelId}`);
    process.exit(1);
  }

  if (!files || files.length === 0) {
    console.error('No files found in this model repository.');
    process.exit(1);
  }

  // Select files
  const toDownload = selectFiles(files, flags.prefer);

  if (toDownload.length === 0) {
    console.log('\n⚠️  No matching files. Listing available files:\n');
    files.slice(0, 40).forEach(f => {
      const size = f.lfs?.size || f.size || 0;
      console.log(`  - ${f.rfilename} (${formatSize(size)})`);
    });
    console.log('\n💡 Try a model with "onnx" to get browser-compatible files.');
    process.exit(0);
  }

  // Summary
  const totalSize = toDownload.reduce((sum, f) => sum + (f.lfs?.size || f.size || 0), 0);
  console.log(`\n📥 ${toDownload.length} file(s) (${formatSize(totalSize)} total):\n`);
  toDownload.forEach(f => {
    const size = f.lfs?.size || f.size || 0;
    console.log(`  - ${f.rfilename} (${formatSize(size)})`);
  });
  console.log('');

  // Download
  const modelDir = path.join(outputDir, modelId.replace(/\//g, '_'));
  let success = 0, skipped = 0, failed = 0;

  for (const file of toDownload) {
    const outputPath = path.join(modelDir, file.rfilename);

    if (flags.skipExisting && fs.existsSync(outputPath)) {
      const stat = fs.statSync(outputPath);
      const expectedSize = file.lfs?.size || file.size || 0;
      if (expectedSize === 0 || stat.size === expectedSize) {
        console.log(`  ⏭️  ${file.rfilename} (cached)`);
        skipped++;
        continue;
      }
    }

    try {
      await downloadFile(modelId, file.rfilename, outputPath);
      success++;
    } catch (err) {
      console.error(`  ❌ ${file.rfilename} — ${err.message}`);
      failed++;
    }
  }

  // Write info
  const infoPath = path.join(modelDir, 'model-info.json');
  fs.writeFileSync(infoPath, JSON.stringify({
    modelId,
    downloadedAt: new Date().toISOString(),
    files: toDownload.map(f => f.rfilename),
    pipeline_tag: modelInfo.pipeline_tag,
    tags: modelInfo.tags,
  }, null, 2));

  // Summary
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`\n✅ Done!  Downloaded: ${success}  Skipped: ${skipped}  Failed: ${failed}`);
  console.log(`   Location: ${modelDir}/`);
  console.log(`   Info:     ${infoPath}`);
  console.log(`\n💡 Use with the agent:`);
  console.log(`   engine.load({ modelUrl: '${modelDir}/model.onnx' })`);
}

main().catch(err => {
  console.error(`\n❌ Fatal: ${err.message}`);
  process.exit(1);
});
