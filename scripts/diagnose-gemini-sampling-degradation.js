#!/usr/bin/env node

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const {
  analyzeMainReplyDegeneration,
  normalizeForRepeat,
  splitSentences
} = require('../utils/mainReplyDegenerationGuard');

const execFileAsync = promisify(execFile);

const PROJECT_ROOT = path.resolve(__dirname, '..');
const EXPORT_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'export-gemini-user-dialogues.js');
const DEFAULT_BEFORE_PATH = path.join(PROJECT_ROOT, 'artifacts', 'gemini-sampling-degradation-48h.json');
const DEFAULT_HOURS = 48;

const PATTERN_KEYS = [
  'template_like',
  'over_compliant',
  'stiff_rhythm',
  'repeated_tail'
];

const PATTERN_LABELS = {
  template_like: '模板化',
  over_compliant: '过顺从',
  stiff_rhythm: '节奏发僵',
  repeated_tail: '重复尾巴'
};

const TEMPLATE_CUE_PATTERNS = [
  { id: 'stylized_fixed_opening', pattern: /^(?:诶|欸|哎呀|呜哇|哈|噗)(?:[—\-~～…]+|[，,。！？!?])/u },
  { id: 'stock_reward_frame', pattern: /(?:特殊的?奖励|秘密小彩蛋|小彩蛋|犯规|安全距离|给你太多甜头|上瘾到停不下来)/u },
  { id: 'stock_judgement_frame', pattern: /(?:真是有够|胆子也太大|也太无情|查户口|找个台阶下|逻辑大崩坏)/u },
  { id: 'formulaic_relation_frame', pattern: /(?:全世界只有你一个人|不是那种.+而是|明明.+结果)/u }
];

const OVER_COMPLIANCE_PATTERNS = [
  { id: 'user_wish_yielding', pattern: /(?:你想|你要|你说).{0,12}(?:就|都可以|可以|行|满足)/u },
  { id: 'explicit_obedience', pattern: /(?:听你的|都听你|随你|你说了算|照做|服从|顺从|无条件)/u },
  { id: 'exclusive_reward', pattern: /(?:特殊的?奖励|奖励|小彩蛋|只给你|只有你|全世界只有你)/u }
];

function normalizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function countMatches(text = '', pattern) {
  const matches = String(text || '').match(pattern);
  return Array.isArray(matches) ? matches.length : 0;
}

function readArgValue(argv, index) {
  const item = String(argv[index] || '');
  const eq = item.indexOf('=');
  if (eq >= 0) return { value: item.slice(eq + 1), consumed: 0 };
  return { value: argv[index + 1], consumed: 1 };
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    before: '',
    after: '',
    file: '',
    text: false,
    json: false,
    help: false,
    limitExamples: 3,
    exportAfter: false,
    exportOut: '',
    diagOut: '',
    dataDir: '',
    hours: DEFAULT_HOURS,
    since: '',
    until: '',
    modelPattern: 'gemini',
    successOnly: true,
    requireMessage: true,
    includeSelfCheck: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const item = String(argv[i] || '').trim();
    const key = item.split('=')[0];
    if (key === '--help' || key === '-h') {
      options.help = true;
    } else if (key === '--before') {
      const { value, consumed } = readArgValue(argv, i);
      options.before = String(value || '');
      i += consumed;
    } else if (key === '--after') {
      const { value, consumed } = readArgValue(argv, i);
      options.after = String(value || '');
      i += consumed;
    } else if (key === '--file') {
      const { value, consumed } = readArgValue(argv, i);
      options.file = String(value || '');
      i += consumed;
    } else if (key === '--json') {
      options.json = true;
    } else if (key === '--text') {
      options.text = true;
    } else if (key === '--limit-examples') {
      const { value, consumed } = readArgValue(argv, i);
      options.limitExamples = Math.max(0, Math.floor(Number(value || 0) || 0));
      i += consumed;
    } else if (key === '--export-after' || key === '--export-current') {
      options.exportAfter = true;
    } else if (key === '--export-out') {
      const { value, consumed } = readArgValue(argv, i);
      options.exportOut = String(value || '');
      i += consumed;
    } else if (key === '--diag-out' || key === '--out') {
      const { value, consumed } = readArgValue(argv, i);
      options.diagOut = String(value || '');
      i += consumed;
    } else if (key === '--data-dir') {
      const { value, consumed } = readArgValue(argv, i);
      options.dataDir = String(value || '');
      i += consumed;
    } else if (key === '--hours') {
      const { value, consumed } = readArgValue(argv, i);
      options.hours = Math.max(1, Number(value || DEFAULT_HOURS) || DEFAULT_HOURS);
      i += consumed;
    } else if (key === '--since') {
      const { value, consumed } = readArgValue(argv, i);
      options.since = String(value || '');
      i += consumed;
    } else if (key === '--until') {
      const { value, consumed } = readArgValue(argv, i);
      options.until = String(value || '');
      i += consumed;
    } else if (key === '--model-pattern') {
      const { value, consumed } = readArgValue(argv, i);
      options.modelPattern = String(value || 'gemini');
      i += consumed;
    } else if (key === '--include-self-check') {
      options.includeSelfCheck = true;
    } else if (key === '--all-statuses') {
      options.successOnly = false;
    } else if (key === '--allow-missing-message') {
      options.requireMessage = false;
    }
  }

  if (!options.text && !options.json) options.text = true;
  return options;
}

function printHelp() {
  console.log([
    'Usage: node scripts/diagnose-gemini-sampling-degradation.js [options]',
    '',
    'Compare exported Gemini dialogue samples for high-risk output patterns.',
    '',
    'Inputs:',
    '  --file <path>             Analyze one exported JSON/JSONL file.',
    '  --before <path>           Baseline export, usually pre-fix.',
    '  --after <path>            Current/post-fix export.',
    '  --export-after            Run export-gemini-user-dialogues.js and use it as --after.',
    '  --export-out <path>       File for --export-after, default data/exports/gemini-sampling-degradation-after-*.json.',
    '',
    'Export passthrough:',
    '  --hours <n>               Export window for --export-after, default 48.',
    '  --since <iso|epoch>       Export start for --export-after.',
    '  --until <iso|epoch>       Export end for --export-after.',
    '  --data-dir <path>         Data dir for --export-after.',
    '  --model-pattern <regex>   Model/provider pattern, default gemini.',
    '  --all-statuses            Do not pass --success-only to the exporter.',
    '  --allow-missing-message   Do not pass --require-message to the exporter.',
    '',
    'Output:',
    '  --text                    Brief text summary, default.',
    '  --json                    Machine-readable JSON report.',
    '  --diag-out <path>         Also write JSON report to a file.',
    '  --limit-examples <n>      Examples per pattern, default 3.'
  ].join('\n'));
}

function resolveInputPath(filePath) {
  const raw = String(filePath || '').trim();
  if (!raw) return '';
  return path.resolve(PROJECT_ROOT, raw);
}

function parseJsonl(text = '') {
  const metadata = {};
  const records = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row = null;
    try {
      row = JSON.parse(line);
    } catch (_) {
      continue;
    }
    if (row && row.type === 'metadata') Object.assign(metadata, row);
    if (row && row.type === 'conversation') records.push(row);
  }
  return { metadata, records };
}

async function readExportFile(filePath, label = '') {
  const fullPath = resolveInputPath(filePath);
  const text = await fsp.readFile(fullPath, 'utf8');
  const trimmed = text.trimStart();
  let parsed = null;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    parsed = JSON.parse(text);
  } else {
    parsed = parseJsonl(text);
  }

  const records = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.records)
    ? parsed.records
    : [];
  const metadata = Array.isArray(parsed) ? {} : { ...parsed };
  delete metadata.records;
  return {
    label: label || path.basename(fullPath),
    sourcePath: fullPath,
    metadata,
    records
  };
}

function getAssistantText(record = {}) {
  return normalizeText(
    record.assistant_reply_preview
    || record.assistant_reply
    || record.final_reply
    || record.finalReplyPreview
    || record.response_text
    || record.text
  );
}

function getUserText(record = {}) {
  return normalizeText(record.clean_text || record.raw_message || record.user_text || record.prompt || record.message);
}

function matchPatternIds(text = '', entries = []) {
  return entries
    .filter((entry) => entry.pattern.test(text))
    .map((entry) => entry.id);
}

function extractOpeningKey(text = '') {
  const normalized = normalizeText(text);
  if (!normalized) return '';
  const fixed = normalized.match(/^(诶|欸|哎呀|呜哇|哈|噗|嗯哼|啊这)(?:[—\-~～…]+|[，,。！？!?])?/u);
  if (fixed) return fixed[0].trim();
  const firstClause = normalized.split(/[，,。！？!?；;：:\n]/u)[0] || '';
  return firstClause.length <= 8 ? firstClause : firstClause.slice(0, 8);
}

function extractTailParticleStats(text = '') {
  const counts = {};
  for (const sentence of splitSentences(text)) {
    const stripped = String(sentence || '')
      .replace(/[。！？!?；;，,、~～\s.]+$/g, '')
      .trim();
    const match = stripped.match(/([呢喔哦嘛啦呀吧呐哟])$/u);
    if (!match) continue;
    counts[match[1]] = (counts[match[1]] || 0) + 1;
  }
  let top = { particle: '', count: 0 };
  for (const [particle, count] of Object.entries(counts)) {
    if (count > top.count) top = { particle, count };
  }
  return { counts, top };
}

function analyzeHighRiskText(text = '', record = {}) {
  const normalized = normalizeText(text);
  const userText = getUserText(record);
  const compact = normalizeForRepeat(normalized);
  const sentences = splitSentences(normalized);
  const degeneration = analyzeMainReplyDegeneration(normalized, { minChars: 48 });
  const templateCues = matchPatternIds(normalized, TEMPLATE_CUE_PATTERNS);
  const complianceCues = matchPatternIds(normalized, OVER_COMPLIANCE_PATTERNS);
  const stylizedPauseCount = countMatches(normalized, /(?:——|--|……|\.{3,}|~{2,}|～{2,})/g);
  const interjectionCount = countMatches(normalized, /(?:诶|欸|呜哇|哎呀|哈|噗)(?:[—\-~～…]+|[，,。！？!?])/gu);
  const tailStats = extractTailParticleStats(normalized);
  const averageSentenceChars = sentences.length
    ? sentences.reduce((total, sentence) => total + normalizeForRepeat(sentence).length, 0) / sentences.length
    : 0;
  const fixedOpening = templateCues.includes('stylized_fixed_opening');
  const shortPromptOverExpanded = normalizeForRepeat(userText).length > 0
    && normalizeForRepeat(userText).length <= 20
    && compact.length >= 120;

  const templateReasons = [];
  if (fixedOpening) templateReasons.push('fixed_opening');
  if (templateCues.length >= 2) templateReasons.push('stock_formula_cues');
  if (shortPromptOverExpanded && templateCues.length >= 1) templateReasons.push('short_prompt_overexpanded_with_formula');

  const overCompliantReasons = [...complianceCues];

  const stiffReasons = [];
  if (stylizedPauseCount >= 2) stiffReasons.push('repeated_stylized_pauses');
  if (interjectionCount >= 2) stiffReasons.push('repeated_interjection_beats');
  if (fixedOpening && compact.length >= 80) stiffReasons.push('long_reply_after_fixed_opening');
  if (sentences.length >= 4 && averageSentenceChars >= 36) stiffReasons.push('long_even_sentence_blocks');

  const repeatedTailReasons = [];
  if (degeneration.degenerated) repeatedTailReasons.push(...degeneration.reasons.map((reason) => `degeneration_${reason}`));
  if (tailStats.top.count >= 3) repeatedTailReasons.push(`same_tail_particle_${tailStats.top.particle}`);

  return {
    textChars: normalized.length,
    compactChars: compact.length,
    sentenceCount: sentences.length,
    openingKey: extractOpeningKey(normalized),
    topTailParticle: tailStats.top,
    patterns: {
      template_like: {
        hit: templateReasons.length > 0,
        reasons: templateReasons
      },
      over_compliant: {
        hit: overCompliantReasons.length > 0,
        reasons: overCompliantReasons
      },
      stiff_rhythm: {
        hit: stiffReasons.length > 0,
        reasons: stiffReasons
      },
      repeated_tail: {
        hit: repeatedTailReasons.length > 0,
        reasons: repeatedTailReasons
      }
    },
    degeneration
  };
}

function increment(map, key) {
  if (!key) return;
  map[key] = (map[key] || 0) + 1;
}

function topEntries(map, limit = 5) {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

function compactExample(record = {}, analysis = {}) {
  return {
    request_id: record.request_id || record.id || '',
    message_id: record.message_id || '',
    user: getUserText(record).slice(0, 80),
    assistant: getAssistantText(record).slice(0, 180),
    reasons: Object.fromEntries(
      PATTERN_KEYS
        .filter((key) => analysis.patterns[key].hit)
        .map((key) => [key, analysis.patterns[key].reasons])
    )
  };
}

function summarizeDataset(dataset = {}, options = {}) {
  const limitExamples = Number.isFinite(options.limitExamples) ? options.limitExamples : 3;
  const records = Array.isArray(dataset.records) ? dataset.records : [];
  const patternSummary = Object.fromEntries(PATTERN_KEYS.map((key) => [key, {
    label: PATTERN_LABELS[key],
    count: 0,
    rate: 0,
    reasonCounts: {},
    examples: []
  }]));
  const openingCounts = {};
  const tailParticleCounts = {};
  const evaluated = [];
  let replyRecords = 0;
  let anyHighRiskCount = 0;

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const text = getAssistantText(record);
    if (!text) continue;
    replyRecords += 1;
    const analysis = analyzeHighRiskText(text, record);
    evaluated.push({ index, record, analysis });
    increment(openingCounts, analysis.openingKey);
    if (analysis.topTailParticle.particle) {
      increment(tailParticleCounts, analysis.topTailParticle.particle);
    }
    const hitKeys = PATTERN_KEYS.filter((key) => analysis.patterns[key].hit);
    if (hitKeys.length > 0) anyHighRiskCount += 1;
    for (const key of hitKeys) {
      const item = patternSummary[key];
      item.count += 1;
      for (const reason of analysis.patterns[key].reasons) {
        increment(item.reasonCounts, reason);
      }
      if (item.examples.length < limitExamples) {
        item.examples.push(compactExample(record, analysis));
      }
    }
  }

  for (const key of PATTERN_KEYS) {
    patternSummary[key].rate = replyRecords ? Number((patternSummary[key].count / replyRecords).toFixed(4)) : 0;
    patternSummary[key].topReasons = topEntries(patternSummary[key].reasonCounts, 6);
  }

  return {
    label: dataset.label || '',
    sourcePath: dataset.sourcePath || '',
    exportWindow: dataset.metadata?.export_window || null,
    models: dataset.metadata?.summary?.models || [],
    recordCount: records.length,
    replyRecords,
    missingReplyRecords: records.length - replyRecords,
    anyHighRisk: {
      count: anyHighRiskCount,
      rate: replyRecords ? Number((anyHighRiskCount / replyRecords).toFixed(4)) : 0
    },
    patterns: patternSummary,
    topOpenings: topEntries(openingCounts, 8),
    topTailParticles: topEntries(tailParticleCounts, 8),
    evaluatedCount: evaluated.length
  };
}

function comparePattern(before, after, key) {
  const beforeItem = before.patterns[key];
  const afterItem = after.patterns[key];
  const deltaCount = afterItem.count - beforeItem.count;
  const deltaRate = Number((afterItem.rate - beforeItem.rate).toFixed(4));
  return {
    label: PATTERN_LABELS[key],
    before: {
      count: beforeItem.count,
      rate: beforeItem.rate
    },
    after: {
      count: afterItem.count,
      rate: afterItem.rate
    },
    deltaCount,
    deltaRate,
    direction: deltaRate < -0.005 ? 'down' : deltaRate > 0.005 ? 'up' : 'flat'
  };
}

function buildComparison(beforeSummary, afterSummary) {
  const patterns = Object.fromEntries(PATTERN_KEYS.map((key) => [key, comparePattern(beforeSummary, afterSummary, key)]));
  const anyDeltaRate = Number((afterSummary.anyHighRisk.rate - beforeSummary.anyHighRisk.rate).toFixed(4));
  return {
    beforeLabel: beforeSummary.label,
    afterLabel: afterSummary.label,
    anyHighRisk: {
      before: beforeSummary.anyHighRisk,
      after: afterSummary.anyHighRisk,
      deltaCount: afterSummary.anyHighRisk.count - beforeSummary.anyHighRisk.count,
      deltaRate: anyDeltaRate,
      direction: anyDeltaRate < -0.005 ? 'down' : anyDeltaRate > 0.005 ? 'up' : 'flat'
    },
    patterns
  };
}

function buildSummaryLines(report) {
  const lines = [];
  if (report.mode === 'compare') {
    const before = report.before;
    const after = report.after;
    lines.push(`before ${before.replyRecords}/${before.recordCount} replies, any high-risk ${before.anyHighRisk.count} (${formatRate(before.anyHighRisk.rate)})`);
    lines.push(`after ${after.replyRecords}/${after.recordCount} replies, any high-risk ${after.anyHighRisk.count} (${formatRate(after.anyHighRisk.rate)})`);
    for (const key of PATTERN_KEYS) {
      const item = report.comparison.patterns[key];
      lines.push(`${item.label}: ${item.before.count} (${formatRate(item.before.rate)}) -> ${item.after.count} (${formatRate(item.after.rate)}), ${formatDeltaRate(item.deltaRate)}`);
    }
    if (after.replyRecords === 0) {
      lines.push('after has no assistant reply previews; output-quality comparison is incomplete');
    } else if (report.comparison.anyHighRisk.direction === 'down') {
      lines.push(`overall high-risk rate decreased by ${formatDeltaRate(report.comparison.anyHighRisk.deltaRate)}`);
    } else if (report.comparison.anyHighRisk.direction === 'up') {
      lines.push(`overall high-risk rate increased by ${formatDeltaRate(report.comparison.anyHighRisk.deltaRate)}`);
    } else {
      lines.push('overall high-risk rate is flat');
    }
    return lines;
  }

  const only = report.dataset;
  lines.push(`${only.replyRecords}/${only.recordCount} records have assistant reply previews`);
  lines.push(`any high-risk ${only.anyHighRisk.count} (${formatRate(only.anyHighRisk.rate)})`);
  for (const key of PATTERN_KEYS) {
    const item = only.patterns[key];
    lines.push(`${item.label}: ${item.count} (${formatRate(item.rate)})`);
  }
  if (only.missingReplyRecords > 0) {
    lines.push(`${only.missingReplyRecords} records have no assistant reply preview and are excluded from pattern rates`);
  }
  return lines;
}

function buildDiagnosticReport({ beforeDataset = null, afterDataset = null, singleDataset = null, limitExamples = 3 } = {}) {
  if (beforeDataset && afterDataset) {
    const before = summarizeDataset(beforeDataset, { limitExamples });
    const after = summarizeDataset(afterDataset, { limitExamples });
    const report = {
      schemaVersion: 'gemini_sampling_degradation_compare_v1',
      generatedAt: new Date().toISOString(),
      mode: 'compare',
      before,
      after,
      comparison: buildComparison(before, after)
    };
    report.summary = buildSummaryLines(report);
    return report;
  }

  const dataset = summarizeDataset(singleDataset || beforeDataset || afterDataset || {}, { limitExamples });
  const report = {
    schemaVersion: 'gemini_sampling_degradation_compare_v1',
    generatedAt: new Date().toISOString(),
    mode: 'single',
    dataset
  };
  report.summary = buildSummaryLines(report);
  return report;
}

function formatRate(rate) {
  return `${(Number(rate || 0) * 100).toFixed(1)}%`;
}

function formatDeltaRate(rate) {
  const points = Number(rate || 0) * 100;
  return `${points >= 0 ? '+' : ''}${points.toFixed(1)}pp`;
}

function formatBriefText(report) {
  const lines = ['Gemini 采样退化对比诊断'];
  for (const line of report.summary || []) {
    lines.push(`- ${line}`);
  }
  if (report.mode === 'single') {
    const top = report.dataset.topOpenings.slice(0, 4).map((item) => `${item.value}=${item.count}`).join(', ');
    if (top) lines.push(`- top openings: ${top}`);
  } else {
    const beforeTop = report.before.topOpenings.slice(0, 3).map((item) => `${item.value}=${item.count}`).join(', ');
    const afterTop = report.after.topOpenings.slice(0, 3).map((item) => `${item.value}=${item.count}`).join(', ');
    if (beforeTop) lines.push(`- before top openings: ${beforeTop}`);
    if (afterTop) lines.push(`- after top openings: ${afterTop}`);
  }
  return `${lines.join('\n')}\n`;
}

function defaultExportOut() {
  const stamp = new Date().toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[-:]/g, '')
    .replace('T', '-');
  return path.join(PROJECT_ROOT, 'data', 'exports', `gemini-sampling-degradation-after-${stamp}.json`);
}

async function runExporter(options = {}) {
  const outPath = path.resolve(PROJECT_ROOT, options.exportOut || defaultExportOut());
  const args = [EXPORT_SCRIPT, '--format', 'json', '--out', outPath, '--model-pattern', options.modelPattern || 'gemini'];
  if (options.dataDir) args.push('--data-dir', path.resolve(PROJECT_ROOT, options.dataDir));
  if (options.since) args.push('--since', options.since);
  if (options.until) args.push('--until', options.until);
  if (!options.since) args.push('--hours', String(options.hours || DEFAULT_HOURS));
  if (options.includeSelfCheck) args.push('--include-self-check');
  if (options.successOnly) args.push('--success-only');
  if (options.requireMessage) args.push('--require-message');
  await execFileAsync(process.execPath, args, {
    cwd: PROJECT_ROOT,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024
  });
  return outPath;
}

async function runDiagnostic(options = parseArgs()) {
  if (options.exportAfter) {
    options.after = await runExporter(options);
  }

  let report;
  if (options.file) {
    const dataset = await readExportFile(options.file, path.basename(options.file));
    report = buildDiagnosticReport({ singleDataset: dataset, limitExamples: options.limitExamples });
  } else if (options.before || options.after) {
    const beforeDataset = options.before ? await readExportFile(options.before, 'before') : null;
    const afterDataset = options.after ? await readExportFile(options.after, 'after') : null;
    report = beforeDataset && afterDataset
      ? buildDiagnosticReport({ beforeDataset, afterDataset, limitExamples: options.limitExamples })
      : buildDiagnosticReport({ singleDataset: beforeDataset || afterDataset, limitExamples: options.limitExamples });
  } else if (fs.existsSync(DEFAULT_BEFORE_PATH)) {
    const dataset = await readExportFile(DEFAULT_BEFORE_PATH, path.basename(DEFAULT_BEFORE_PATH));
    report = buildDiagnosticReport({ singleDataset: dataset, limitExamples: options.limitExamples });
  } else {
    throw new Error('missing input: pass --file, --before/--after, or --export-after');
  }

  if (options.diagOut) {
    const diagOut = path.resolve(PROJECT_ROOT, options.diagOut);
    await fsp.mkdir(path.dirname(diagOut), { recursive: true });
    await fsp.writeFile(diagOut, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }

  return report;
}

async function main() {
  const options = parseArgs();
  if (options.help) {
    printHelp();
    return;
  }
  const report = await runDiagnostic(options);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    process.stdout.write(formatBriefText(report));
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  analyzeHighRiskText,
  buildDiagnosticReport,
  formatBriefText,
  parseArgs,
  readExportFile,
  runDiagnostic,
  summarizeDataset
};
