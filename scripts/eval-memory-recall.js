#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { queryMemory } = require('../utils/memory-v3/query');
const {
  ensureDir,
  safeReadJsonLines,
  atomicWriteText,
  normalizeText
} = require('../utils/memory-v3/helpers');

const OUT_DIR = path.join(__dirname, '..', 'artifacts', 'memory-recall-eval');
const CASES_FILE = path.join(OUT_DIR, 'cases.jsonl');

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    buildCases: false,
    baseline: '',
    candidate: '',
    limit: 100
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--build-cases') args.buildCases = true;
    else if (item === '--baseline') {
      args.baseline = normalizeText(argv[index + 1]).toLowerCase();
      index += 1;
    } else if (item === '--candidate') {
      args.candidate = normalizeText(argv[index + 1]).toLowerCase();
      index += 1;
    } else if (item === '--limit') {
      args.limit = Math.max(1, Number(argv[index + 1] || 100) || 100);
      index += 1;
    }
  }
  return args;
}

function readNapcatEvents(limit = 5000) {
  const file = config.FOLLOWER_NAPCAT_LOG_PATH || path.join(config.DATA_DIR, 'napcat-message-events.jsonl');
  return safeReadJsonLines(file).slice(-Math.max(1, limit));
}

function extractText(row = {}) {
  return normalizeText(
    row.raw_message
    || row.message
    || row.text
    || row.content
    || row.payload?.raw_message
    || row.payload?.message
  );
}

function extractUserId(row = {}) {
  return normalizeText(
    row.user_id
    || row.userId
    || row.sender?.user_id
    || row.payload?.user_id
    || row.payload?.sender?.user_id
  );
}

function extractGroupId(row = {}) {
  return normalizeText(row.group_id || row.groupId || row.payload?.group_id);
}

function classifyEvalFacet(text = '') {
  if (/(昨天|前天|今天|那天|日记|聊了什么|回忆)/i.test(text)) return 'journal';
  if (/(继续|上次|刚才|记得|之前|接着)/i.test(text)) return 'continuity';
  if (/(喜欢|不喜欢|偏好|称呼|名字)/i.test(text)) return 'preference';
  if (/(群里|大家|group)/i.test(text)) return 'group';
  if (/(风格|语气|口癖)/i.test(text)) return 'style';
  return 'default';
}

function looksLikeRecallCase(text = '') {
  return /(记得|回忆|上次|之前|昨天|前天|今天|那天|喜欢|不喜欢|偏好|名字|继续|日记|聊了什么|群里|风格|语气)/i.test(text);
}

function buildCases(args = {}) {
  const rows = readNapcatEvents(Math.max(1000, args.limit * 80));
  const cases = [];
  const seen = new Set();
  for (const row of rows.reverse()) {
    const text = extractText(row);
    const userId = extractUserId(row);
    if (!text || !userId || !looksLikeRecallCase(text)) continue;
    const key = `${userId}|${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cases.push({
      id: `case_${cases.length + 1}`,
      userId,
      groupId: extractGroupId(row),
      query: text,
      facet: classifyEvalFacet(text),
      expectedIds: [],
      createdAt: Number(row.time || row.timestamp || row.self_time || 0) || 0
    });
    if (cases.length >= args.limit) break;
  }
  ensureDir(OUT_DIR);
  atomicWriteText(CASES_FILE, cases.map((item) => JSON.stringify(item)).join('\n'));
  return cases;
}

function loadCases(limit = 100) {
  if (!fs.existsSync(CASES_FILE)) return buildCases({ limit });
  return safeReadJsonLines(CASES_FILE).slice(0, limit);
}

function configureMode(mode = '') {
  if (mode === 'lancedb') {
    config.MEMORY_VECTOR_STORE = 'lancedb';
    config.MEMORY_LANCEDB_READ_ENABLED = true;
  } else if (mode === 'shadow') {
    config.MEMORY_VECTOR_STORE = 'shadow';
    config.MEMORY_LANCEDB_READ_ENABLED = true;
  } else {
    config.MEMORY_VECTOR_STORE = 'local_jsonl';
    config.MEMORY_LANCEDB_READ_ENABLED = false;
  }
}

function percentile(values = [], p = 0.5) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index];
}

function countScopeLeaks(results = [], testCase = {}) {
  const userId = normalizeText(testCase.userId);
  const groupId = normalizeText(testCase.groupId);
  let leaks = 0;
  for (const item of Array.isArray(results) ? results : []) {
    const scopeType = normalizeText(item.scopeType).toLowerCase();
    if (scopeType === 'group') {
      if (normalizeText(item.groupId) && normalizeText(item.groupId) !== groupId) leaks += 1;
    } else if (normalizeText(item.userId) && normalizeText(item.userId) !== userId) {
      leaks += 1;
    }
  }
  return leaks;
}

async function runMode(mode = 'local_jsonl', cases = []) {
  configureMode(mode);
  const latencies = [];
  const sourceCoverage = {};
  let leakage = 0;
  let recallHits = 0;
  let reciprocalSum = 0;
  let judgedCases = 0;
  let promptChars = 0;
  const details = [];

  for (const testCase of cases) {
    const start = Date.now();
    const result = await queryMemory({
      userId: testCase.userId,
      groupId: testCase.groupId,
      query: testCase.query,
      facet: testCase.facet,
      topK: 8
    });
    const latencyMs = Date.now() - start;
    latencies.push(latencyMs);
    const results = Array.isArray(result.results) ? result.results : [];
    for (const item of results) {
      sourceCoverage[item.source || 'unknown'] = (sourceCoverage[item.source || 'unknown'] || 0) + 1;
    }
    leakage += countScopeLeaks(results, testCase);
    promptChars += normalizeText(result.digest).length;
    const expectedIds = Array.isArray(testCase.expectedIds) ? testCase.expectedIds.map(normalizeText).filter(Boolean) : [];
    if (expectedIds.length > 0) {
      judgedCases += 1;
      const rank = results.findIndex((item) => expectedIds.includes(normalizeText(item.id || item.nodeId))) + 1;
      if (rank > 0 && rank <= 8) {
        recallHits += 1;
        reciprocalSum += 1 / rank;
      }
    }
    details.push({
      id: testCase.id,
      latencyMs,
      resultIds: results.map((item) => item.id),
      sources: results.map((item) => item.source),
      lancedb: result.stats?.lancedb || null
    });
  }

  return {
    mode,
    cases: cases.length,
    judgedCases,
    recallAt8: judgedCases ? recallHits / judgedCases : null,
    mrrAt8: judgedCases ? reciprocalSum / judgedCases : null,
    sourceCoverage,
    leakage,
    avgPromptChars: cases.length ? promptChars / cases.length : 0,
    avgPromptTokenEstimate: cases.length ? Math.ceil((promptChars / cases.length) / 2) : 0,
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
    details
  };
}

async function main() {
  const args = parseArgs();
  ensureDir(OUT_DIR);
  if (args.buildCases) {
    const cases = buildCases(args);
    console.log(JSON.stringify({ ok: true, cases: cases.length, file: CASES_FILE }, null, 2));
    return;
  }

  const mode = args.candidate || args.baseline || 'local_jsonl';
  const cases = loadCases(args.limit);
  const result = await runMode(mode, cases);
  const outFile = path.join(OUT_DIR, `${mode}-${Date.now()}.json`);
  atomicWriteText(outFile, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ok: true, file: outFile, ...result, details: undefined }, null, 2));
}

main().catch((error) => {
  console.error('[eval-memory-recall] failed:', error && error.stack ? error.stack : String(error));
  process.exit(1);
});
