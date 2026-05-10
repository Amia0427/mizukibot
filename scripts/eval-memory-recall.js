#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { queryMemory } = require('../utils/memory-v3/query');
const {
  loadMemoryNodes,
  loadScopeProjection
} = require('../utils/memory-v3/storage');
const { runMemoryCli } = require('../utils/memoryCli');
const { buildDailyJournalDocsForAllUsers } = require('../utils/memory-v3/journalDocs');
const { loadPersonaModuleCatalog } = require('../utils/personaModules');
const {
  buildWorldbookDocuments,
  searchPersonaWorldbook
} = require('../utils/personaWorldbookSearch');
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
    autoGold: false,
    baseline: '',
    candidate: '',
    limit: 100,
    memoryCli: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--build-cases') args.buildCases = true;
    else if (item === '--auto-gold') args.autoGold = true;
    else if (item === '--baseline') {
      args.baseline = normalizeText(argv[index + 1]).toLowerCase();
      index += 1;
    } else if (item === '--candidate') {
      args.candidate = normalizeText(argv[index + 1]).toLowerCase();
      index += 1;
    } else if (item === '--limit') {
      args.limit = Math.max(1, Number(argv[index + 1] || 100) || 100);
      index += 1;
    } else if (item === '--memory-cli') {
      args.memoryCli = true;
    }
  }
  return args;
}

function normalizeSource(value = '') {
  return normalizeText(value).toLowerCase() || 'unknown';
}

function inferGoldFacet(doc = {}) {
  const source = normalizeSource(doc.source);
  const memoryKind = normalizeSource(doc.memoryKind);
  const slot = normalizeSource(doc.semanticSlot || doc.fieldKey || doc.type || doc.memoryKind);
  if (source === 'journal' || slot.includes('journal') || slot === 'episode') return 'journal';
  if (source === 'group' || source === 'jargon' || normalizeSource(doc.scopeType) === 'group') return 'group';
  if (source === 'style' || memoryKind === 'style' || slot.includes('style') || source === 'jargon') return 'style';
  if (slot.includes('relationship')) return 'relationship';
  if (slot.includes('identity') || slot.includes('persona')) return 'identity';
  if (slot.includes('like') || slot.includes('dislike') || slot.includes('preference') || slot === 'hobby') return 'preference';
  if (source === 'task' || slot.includes('task')) return 'task';
  return 'default';
}

function buildGoldQuery(doc = {}) {
  const facet = inferGoldFacet(doc);
  const canonical = normalizeText(doc.canonicalKey || doc.title || doc.moduleId || doc.id);
  const preview = normalizeText(doc.preview || doc.text || doc.purpose);
  const snippet = preview.split(/[。！？.!?\n]/).map(normalizeText).find(Boolean) || preview;
  const compactSnippet = snippet.length > 160 ? snippet.slice(0, 160) : snippet;
  if (facet === 'journal') {
    const day = normalizeText(doc.episodeDay || doc.title || '').slice(0, 10);
    return normalizeText(day ? `${day} ${compactSnippet}` : compactSnippet);
  }
  if (facet === 'worldbook') return normalizeText(`${canonical} ${compactSnippet}`);
  return normalizeText(canonical && canonical !== 'unknown' ? `${canonical} ${compactSnippet}` : compactSnippet);
}

function caseSortKey(item = {}) {
  return [
    normalizeSource(item.evalSource || item.source),
    normalizeText(item.userId),
    normalizeText(item.groupId),
    normalizeText(item.id || item.moduleId || item.nodeId)
  ].join('|');
}

function bucketGoldCases(cases = [], keyFn = (item) => item.source || item.facet || 'unknown') {
  const buckets = new Map();
  for (const item of Array.isArray(cases) ? cases : []) {
    const key = normalizeText(keyFn(item)) || 'unknown';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(item);
  }
  return Array.from(buckets.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, items]) => ({
      key,
      items: items.sort((a, b) => caseSortKey(a).localeCompare(caseSortKey(b)))
    }));
}

function roundRobinGoldCases(cases = [], limit = 100, keyFn = (item) => item.source || item.facet || 'unknown') {
  const max = Math.max(1, Number(limit || 100) || 100);
  const buckets = bucketGoldCases(cases, keyFn);
  const selected = [];
  let cursor = 0;
  while (selected.length < max && buckets.some((bucket) => bucket.items.length > 0)) {
    const bucket = buckets[cursor % buckets.length];
    const item = bucket.items.shift();
    if (item) selected.push(item);
    cursor += 1;
  }
  return selected;
}

function isStableMemoryGoldCase(item = {}) {
  const source = normalizeSource(item.targetSource || item.source);
  const facet = normalizeSource(item.facet);
  if (source === 'worldbook') return true;
  if (source === 'test' || source === 'unknown') return false;
  if (source === 'post_reply_worker' || source === 'self_improvement') return false;
  if (source === 'legacy_memories' || source === 'daily_journal_summary' || source === 'daily_journal_rollup') return false;
  if (source === 'direct_chat' || source === 'passive_group_reply' || source === 'bot_diary') return false;
  if (source === 'explicit') return false;
  if (facet === 'default' || facet === 'identity' || facet === 'relationship') return false;
  return ['journal', 'group', 'preference', 'style', 'task'].includes(facet);
}

function goldCanonicalKey(item = {}) {
  const facet = normalizeText(item.facet);
  let canonical = normalizeText(item.canonicalKey || item.query).toLowerCase();
  if (facet === 'style') {
    canonical = canonical
      .replace(/^style\s*/i, '')
      .replace(/\b(style|语气|偏好|常用|回应|表达|口语化|轻松|自然|亲切|俏皮|温柔|安抚|带一点|一点|的|和|用)\b/gi, ' ')
      .replace(/[，。、“”"':：；;（）()~…]/g, ' ');
  }
  return [
    normalizeText(item.userId),
    normalizeText(item.groupId),
    facet,
    normalizeText(canonical)
  ].join('|');
}

function keepUniqueGoldCases(cases = []) {
  const counts = new Map();
  for (const item of Array.isArray(cases) ? cases : []) {
    const key = goldCanonicalKey(item);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return (Array.isArray(cases) ? cases : []).filter((item) => (counts.get(goldCanonicalKey(item)) || 0) === 1);
}

function buildMemoryGoldCases(limit = 100) {
  const nodes = loadMemoryNodes()
    .filter((node) => normalizeText(node.id) && normalizeText(node.text))
    .filter((node) => normalizeText(node.status || 'active').toLowerCase() !== 'archived')
    .filter((node) => normalizeText(node.userId) || normalizeText(node.scopeType).toLowerCase() === 'group')
    .map((node) => {
      const facet = inferGoldFacet(node);
      const query = buildGoldQuery(node);
      if (!query) return null;
      return {
        id: `gold-memory:${node.id}`,
        evalSource: 'memory',
        userId: normalizeText(node.userId),
        groupId: normalizeText(node.groupId),
        query,
        facet,
        expectedIds: [normalizeText(node.id)],
        source: normalizeSource(node.scopeType) === 'group' ? 'group' : normalizeSource(node.source || node.memoryKind || 'memory'),
        targetSource: normalizeSource(node.source || node.memoryKind || 'memory'),
        canonicalKey: normalizeText(node.canonicalKey || node.text).toLowerCase(),
        createdAt: Number(node.updatedAt || node.createdAt || 0) || 0
      };
    })
    .filter((item) => item && item.userId && item.query && isStableMemoryGoldCase(item));

  const journals = buildDailyJournalDocsForAllUsers({ includeSegments: true })
    .map((doc) => {
      const query = buildGoldQuery(doc);
      if (!query) return null;
      return {
        id: `gold-journal:${doc.id}`,
        evalSource: 'memory',
        userId: normalizeText(doc.userId),
        groupId: '',
        query,
        facet: 'journal',
        expectedIds: [normalizeText(doc.id)],
        source: 'journal',
        targetSource: 'journal',
        canonicalKey: normalizeText(doc.id),
        createdAt: Number(doc.updatedAt || 0) || 0
      };
    })
    .filter((item) => item && item.userId && item.query && isStableMemoryGoldCase(item));

  return roundRobinGoldCases(keepUniqueGoldCases(nodes.concat(journals)), limit, (item) => `${item.facet}:${item.targetSource || item.source}`);
}

function buildWorldbookGoldCases(limit = 100) {
  const catalog = loadPersonaModuleCatalog();
  return buildWorldbookDocuments(catalog)
    .map((doc) => {
      const moduleId = normalizeText(doc.moduleId || doc.id);
      const query = buildGoldQuery({
        ...doc,
        source: 'worldbook',
        semanticSlot: 'worldbook'
      });
      if (!moduleId || !query) return null;
      return {
        id: `gold-worldbook:${moduleId}`,
        evalSource: 'worldbook',
        userId: '',
        groupId: '',
        query,
        facet: 'worldbook',
        expectedIds: [moduleId],
        source: 'worldbook',
        targetSource: 'worldbook',
        createdAt: Number(doc.fileMtimeMs || 0) || 0
      };
    })
    .filter(Boolean)
    .sort((a, b) => caseSortKey(a).localeCompare(caseSortKey(b)))
    .slice(0, Math.max(1, Number(limit || 100) || 100));
}

function buildAutoGoldCases(limit = 100) {
  const max = Math.max(1, Number(limit || 100) || 100);
  const worldbookLimit = Math.max(1, Math.min(Math.ceil(max * 0.2), 40));
  const memoryLimit = Math.max(1, max - worldbookLimit);
  const cases = buildMemoryGoldCases(memoryLimit).concat(buildWorldbookGoldCases(worldbookLimit));
  return roundRobinGoldCases(cases, max, (item) => item.facet || item.targetSource || item.source);
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

function loadCases(limit = 100, options = {}) {
  if (options.autoGold === true) return buildAutoGoldCases(limit);
  if (!fs.existsSync(CASES_FILE)) return buildCases({ limit });
  const cases = safeReadJsonLines(CASES_FILE).slice(0, limit);
  return cases.some((item) => normalizeExpectedIds(item).length > 0) ? cases : buildAutoGoldCases(limit);
}

function normalizeExpectedIds(testCase = {}) {
  const explicit = Array.isArray(testCase.expectedIds) ? testCase.expectedIds : [];
  const aliases = Array.isArray(testCase.expected_ids) ? testCase.expected_ids : [];
  return explicit.concat(aliases).map(normalizeText).filter(Boolean);
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

function emptyStageStats() {
  return {
    queryEmbeddingMs: [],
    lancedbSearchMs: [],
    localLexicalMs: [],
    fusionMs: [],
    rerankMs: [],
    totalMs: []
  };
}

function addStageStats(stageStats = emptyStageStats(), timings = {}) {
  for (const key of Object.keys(stageStats)) {
    const value = Number(timings?.[key]);
    if (Number.isFinite(value)) stageStats[key].push(value);
  }
}

function summarizeStageStats(stageStats = emptyStageStats()) {
  const out = {};
  for (const [key, values] of Object.entries(stageStats)) {
    out[key] = {
      p50Ms: percentile(values, 0.5),
      p95Ms: percentile(values, 0.95)
    };
  }
  return out;
}

function incrementMetric(map = {}, key = 'unknown', amount = 1) {
  const normalized = normalizeText(key) || 'unknown';
  map[normalized] = (map[normalized] || 0) + amount;
}

function ensureSourceMetrics(metrics = {}, source = 'unknown') {
  const key = normalizeText(source) || 'unknown';
  if (!metrics[key]) {
    metrics[key] = {
      cases: 0,
      judgedCases: 0,
      recallHits: 0,
      reciprocalSum: 0,
      emptyResults: 0,
      noVisibleCandidates: 0
    };
  }
  return metrics[key];
}

function finalizeGroupedMetrics(metrics = {}) {
  const out = {};
  for (const [key, value] of Object.entries(metrics)) {
    out[key] = {
      cases: value.cases,
      judgedCases: value.judgedCases,
      recallAt8: value.judgedCases ? value.recallHits / value.judgedCases : null,
      mrrAt8: value.judgedCases ? value.reciprocalSum / value.judgedCases : null,
      emptyResultRate: value.cases ? value.emptyResults / value.cases : 0,
      noVisibleCandidateRate: value.cases ? value.noVisibleCandidates / value.cases : 0
    };
  }
  return out;
}

function countScopeLeaks(results = [], testCase = {}) {
  const userId = normalizeText(testCase.userId);
  const groupId = normalizeText(testCase.groupId);
  const scope = loadScopeProjection();
  const allowedGroups = new Set([
    groupId,
    ...(Array.isArray(scope.users?.[userId]?.groups) ? scope.users[userId].groups : [])
  ].map(normalizeText).filter(Boolean));
  let leaks = 0;
  for (const item of Array.isArray(results) ? results : []) {
    const scopeType = normalizeText(item.scopeType).toLowerCase();
    if (scopeType === 'group') {
      if (normalizeText(item.groupId) && !allowedGroups.has(normalizeText(item.groupId))) leaks += 1;
    } else if (normalizeText(item.userId) && normalizeText(item.userId) !== userId) {
      leaks += 1;
    }
  }
  return leaks;
}

async function runMode(mode = 'local_jsonl', cases = [], options = {}) {
  configureMode(mode);
  const mainLatencies = [];
  const memoryCliLatencies = [];
  const stageStats = emptyStageStats();
  const sourceCoverage = {};
  const fallbackCounts = {};
  const bySourceRaw = {};
  const byFacetRaw = {};
  let leakage = 0;
  let recallHits = 0;
  let reciprocalSum = 0;
  let judgedCases = 0;
  let promptChars = 0;
  let emptyResults = 0;
  let noVisibleCandidates = 0;
  const details = [];

  for (const testCase of cases) {
    const start = Date.now();
    const isWorldbookCase = normalizeText(testCase.evalSource || testCase.source) === 'worldbook' || normalizeText(testCase.facet) === 'worldbook';
    let result = null;
    if (isWorldbookCase) {
      const catalog = loadPersonaModuleCatalog();
      const worldbookResult = await searchPersonaWorldbook(catalog, {
        query: testCase.query,
        limit: 8
      });
      result = {
        results: Array.isArray(worldbookResult.results) ? worldbookResult.results : [],
        stats: {
          worldbook: worldbookResult.diagnostics || null
        },
        diagnostics: {}
      };
    } else {
      result = await queryMemory({
        userId: testCase.userId,
        groupId: testCase.groupId,
        query: testCase.query,
        facet: testCase.facet,
        topK: 8
      });
      addStageStats(stageStats, result.stats?.timings || result.diagnostics?.timings || {});
    }
    const latencyMs = Date.now() - start;
    mainLatencies.push(latencyMs);
    let memoryCli = null;
    if (options.memoryCli === true) {
      const cliStart = Date.now();
      const cliResult = await runMemoryCli(`mem search --query "${testCase.query.replace(/"/g, '\\"')}" --source all --limit 8`, {
        userId: testCase.userId,
        groupId: testCase.groupId
      });
      memoryCli = {
        latencyMs: Date.now() - cliStart,
        ok: cliResult?.ok !== false,
        count: Number(cliResult?.count || cliResult?.results?.length || 0) || 0
      };
      memoryCliLatencies.push(memoryCli.latencyMs);
    }
    const results = Array.isArray(result.results) ? result.results : [];
    for (const item of results) {
      sourceCoverage[item.source || 'unknown'] = (sourceCoverage[item.source || 'unknown'] || 0) + 1;
    }
    if (!isWorldbookCase) leakage += countScopeLeaks(results, testCase);
    promptChars += normalizeText(result.digest).length;
    const expectedIds = normalizeExpectedIds(testCase);
    const sourceMetric = ensureSourceMetrics(bySourceRaw, testCase.targetSource || testCase.source || testCase.evalSource || 'unknown');
    const facetMetric = ensureSourceMetrics(byFacetRaw, testCase.facet || 'default');
    sourceMetric.cases += 1;
    facetMetric.cases += 1;
    if (results.length === 0) {
      emptyResults += 1;
      sourceMetric.emptyResults += 1;
      facetMetric.emptyResults += 1;
    }
    const fallbackReason = normalizeText(result.stats?.lancedb?.fallbackReason || result.stats?.worldbook?.embedding?.fallbackReason || '');
    if (fallbackReason) incrementMetric(fallbackCounts, fallbackReason);
    if (/no_visible_candidates/.test(fallbackReason)) {
      noVisibleCandidates += 1;
      sourceMetric.noVisibleCandidates += 1;
      facetMetric.noVisibleCandidates += 1;
    }
    if (expectedIds.length > 0) {
      judgedCases += 1;
      sourceMetric.judgedCases += 1;
      facetMetric.judgedCases += 1;
      const rank = results.findIndex((item) => expectedIds.includes(normalizeText(item.id || item.nodeId || item.moduleId))) + 1;
      if (rank > 0 && rank <= 8) {
        recallHits += 1;
        reciprocalSum += 1 / rank;
        sourceMetric.recallHits += 1;
        sourceMetric.reciprocalSum += 1 / rank;
        facetMetric.recallHits += 1;
        facetMetric.reciprocalSum += 1 / rank;
      }
    }
    details.push({
      id: testCase.id,
      evalSource: testCase.evalSource || '',
      userId: testCase.userId || '',
      groupId: testCase.groupId || '',
      latencyMs,
      resultIds: results.map((item) => item.id || item.nodeId || item.moduleId),
      query: testCase.query,
      facet: testCase.facet || '',
      source: testCase.source || '',
      targetSource: testCase.targetSource || '',
      expectedIds,
      sources: results.map((item) => item.source),
      lancedb: result.stats?.lancedb || null,
      worldbook: result.stats?.worldbook || null,
      timings: result.stats?.timings || result.diagnostics?.timings || null,
      memoryCli
    });
  }

  return {
    mode,
    cases: cases.length,
    judgedCases,
    recallAt8: judgedCases ? recallHits / judgedCases : null,
    mrrAt8: judgedCases ? reciprocalSum / judgedCases : null,
    sourceCoverage,
    fallbackCounts,
    leakage,
    emptyResultRate: cases.length ? emptyResults / cases.length : 0,
    noVisibleCandidateRate: cases.length ? noVisibleCandidates / cases.length : 0,
    bySource: finalizeGroupedMetrics(bySourceRaw),
    byFacet: finalizeGroupedMetrics(byFacetRaw),
    avgPromptChars: cases.length ? promptChars / cases.length : 0,
    avgPromptTokenEstimate: cases.length ? Math.ceil((promptChars / cases.length) / 2) : 0,
    p50LatencyMs: percentile(mainLatencies, 0.5),
    p95LatencyMs: percentile(mainLatencies, 0.95),
    latency: {
      main: {
        p50Ms: percentile(mainLatencies, 0.5),
        p95Ms: percentile(mainLatencies, 0.95)
      },
      memoryCli: {
        enabled: options.memoryCli === true,
        p50Ms: percentile(memoryCliLatencies, 0.5),
        p95Ms: percentile(memoryCliLatencies, 0.95)
      },
      stages: summarizeStageStats(stageStats)
    },
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
  const cases = loadCases(args.limit, {
    autoGold: args.autoGold
  });
  const result = await runMode(mode, cases, {
    memoryCli: args.memoryCli
  });
  const outFile = path.join(OUT_DIR, `${mode}-${Date.now()}.json`);
  atomicWriteText(outFile, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ok: true, file: outFile, ...result, details: undefined }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[eval-memory-recall] failed:', error && error.stack ? error.stack : String(error));
    process.exit(1);
  }).then(() => {
    process.exit(0);
  });
}

module.exports = {
  buildCases,
  buildAutoGoldCases,
  buildMemoryGoldCases,
  buildWorldbookGoldCases,
  countScopeLeaks,
  isStableMemoryGoldCase,
  loadCases,
  normalizeExpectedIds,
  parseArgs,
  percentile,
  runMode
};
