const fs = require('fs');
const path = require('path');
const config = require('../config');

const DEFAULT_OLD_DAYS = 14;
const DEFAULT_DONE_JOB_DAYS = 7;
const DEFAULT_IMAGE_CACHE_DAYS = 7;
const DEFAULT_MAX_LOG_BYTES = 100 * 1024 * 1024;

function normalizeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeText(value = '') {
  return String(value || '').trim();
}

function formatMb(bytes = 0) {
  return Math.round((normalizeNumber(bytes, 0) / 1024 / 1024) * 10) / 10;
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    apply: false,
    json: true,
    oldDays: DEFAULT_OLD_DAYS,
    doneJobDays: DEFAULT_DONE_JOB_DAYS,
    imageCacheDays: DEFAULT_IMAGE_CACHE_DAYS,
    maxLogBytes: DEFAULT_MAX_LOG_BYTES,
    dataDir: config.DATA_DIR
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = normalizeText(argv[index]);
    if (item === '--apply') args.apply = true;
    else if (item === '--text') args.json = false;
    else if (item === '--data-dir') {
      args.dataDir = argv[index + 1] || args.dataDir;
      index += 1;
    } else if (item.startsWith('--data-dir=')) {
      args.dataDir = item.slice('--data-dir='.length);
    } else if (item === '--old-days') {
      args.oldDays = normalizeNumber(argv[index + 1], args.oldDays);
      index += 1;
    } else if (item.startsWith('--old-days=')) {
      args.oldDays = normalizeNumber(item.slice('--old-days='.length), args.oldDays);
    } else if (item === '--done-job-days') {
      args.doneJobDays = normalizeNumber(argv[index + 1], args.doneJobDays);
      index += 1;
    } else if (item.startsWith('--done-job-days=')) {
      args.doneJobDays = normalizeNumber(item.slice('--done-job-days='.length), args.doneJobDays);
    } else if (item === '--image-cache-days') {
      args.imageCacheDays = normalizeNumber(argv[index + 1], args.imageCacheDays);
      index += 1;
    } else if (item.startsWith('--image-cache-days=')) {
      args.imageCacheDays = normalizeNumber(item.slice('--image-cache-days='.length), args.imageCacheDays);
    } else if (item === '--max-log-mb') {
      args.maxLogBytes = normalizeNumber(argv[index + 1], DEFAULT_MAX_LOG_BYTES / 1024 / 1024) * 1024 * 1024;
      index += 1;
    } else if (item.startsWith('--max-log-mb=')) {
      args.maxLogBytes = normalizeNumber(item.slice('--max-log-mb='.length), DEFAULT_MAX_LOG_BYTES / 1024 / 1024) * 1024 * 1024;
    }
  }
  return args;
}

function safeStat(filePath = '') {
  try {
    return fs.statSync(filePath);
  } catch (_) {
    return null;
  }
}

function safeReadDir(dirPath = '') {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (_) {
    return [];
  }
}

function walkFiles(rootDir = '') {
  const root = path.resolve(String(rootDir || ''));
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of safeReadDir(current)) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile()) {
        const stat = safeStat(fullPath);
        if (stat) out.push({ path: fullPath, size: Number(stat.size || 0), mtimeMs: Number(stat.mtimeMs || 0) });
      }
    }
  }
  return out;
}

function isInsidePath(candidate = '', root = '') {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  const a = process.platform === 'win32' ? resolvedCandidate.toLowerCase() : resolvedCandidate;
  const b = process.platform === 'win32' ? resolvedRoot.toLowerCase() : resolvedRoot;
  return a === b || a.startsWith(b + path.sep);
}

function addCandidate(candidates, dataDir, file, category, reason) {
  if (!file || !isInsidePath(file.path, dataDir)) return;
  candidates.push({
    category,
    reason,
    path: file.path,
    relativePath: path.relative(dataDir, file.path),
    bytes: file.size,
    mb: formatMb(file.size),
    mtimeMs: file.mtimeMs
  });
}

function collectDirectorySummary(dataDir = '') {
  return safeReadDir(dataDir)
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dirPath = path.join(dataDir, entry.name);
      const files = walkFiles(dirPath);
      const bytes = files.reduce((sum, file) => sum + file.size, 0);
      return {
        name: entry.name,
        path: dirPath,
        files: files.length,
        bytes,
        mb: formatMb(bytes)
      };
    })
    .sort((a, b) => b.bytes - a.bytes);
}

function collectFootprint(options = {}) {
  const dataDir = path.resolve(String(options.dataDir || config.DATA_DIR));
  const nowMs = normalizeNumber(options.nowMs, Date.now());
  const oldCutoffMs = nowMs - Math.max(0, normalizeNumber(options.oldDays, DEFAULT_OLD_DAYS)) * 24 * 60 * 60 * 1000;
  const doneJobCutoffMs = nowMs - Math.max(0, normalizeNumber(options.doneJobDays, DEFAULT_DONE_JOB_DAYS)) * 24 * 60 * 60 * 1000;
  const imageCutoffMs = nowMs - Math.max(0, normalizeNumber(options.imageCacheDays, DEFAULT_IMAGE_CACHE_DAYS)) * 24 * 60 * 60 * 1000;
  const maxLogBytes = Math.max(0, normalizeNumber(options.maxLogBytes, DEFAULT_MAX_LOG_BYTES));
  const candidates = [];

  const rootFiles = walkFiles(dataDir).filter((file) => path.dirname(file.path) === dataDir);
  for (const name of ['model-calls.ndjson', 'request-trace.ndjson']) {
    const file = rootFiles.find((item) => path.basename(item.path) === name);
    if (file && file.size > maxLogBytes) addCandidate(candidates, dataDir, file, 'large_log', `larger_than_${formatMb(maxLogBytes)}MB`);
  }

  for (const file of walkFiles(path.join(dataDir, 'langgraph_v2_checkpoints'))) {
    if (file.mtimeMs > 0 && file.mtimeMs < oldCutoffMs) {
      addCandidate(candidates, dataDir, file, 'old_checkpoint', `older_than_${options.oldDays || DEFAULT_OLD_DAYS}_days`);
    }
  }

  for (const file of walkFiles(path.join(dataDir, 'inbound_image_cache'))) {
    if (file.mtimeMs > 0 && file.mtimeMs < imageCutoffMs) {
      addCandidate(candidates, dataDir, file, 'old_inbound_image', `older_than_${options.imageCacheDays || DEFAULT_IMAGE_CACHE_DAYS}_days`);
    }
  }

  for (const file of walkFiles(path.join(dataDir, 'post_reply_jobs', 'done'))) {
    if (file.mtimeMs > 0 && file.mtimeMs < doneJobCutoffMs) {
      addCandidate(candidates, dataDir, file, 'old_post_reply_done_job', `older_than_${options.doneJobDays || DEFAULT_DONE_JOB_DAYS}_days`);
    }
  }

  const totalBytes = walkFiles(dataDir).reduce((sum, file) => sum + file.size, 0);
  return {
    schemaVersion: 'data_footprint_inspection_v1',
    checkedAt: new Date(nowMs).toISOString(),
    dataDir,
    apply: false,
    totals: {
      bytes: totalBytes,
      mb: formatMb(totalBytes)
    },
    directories: collectDirectorySummary(dataDir).slice(0, 30),
    candidates,
    candidateTotals: {
      files: candidates.length,
      bytes: candidates.reduce((sum, file) => sum + file.bytes, 0),
      mb: formatMb(candidates.reduce((sum, file) => sum + file.bytes, 0))
    }
  };
}

function applyCandidates(report = {}) {
  const deleted = [];
  const failed = [];
  const dataDir = report.dataDir;
  for (const candidate of Array.isArray(report.candidates) ? report.candidates : []) {
    if (!isInsidePath(candidate.path, dataDir)) {
      failed.push({ ...candidate, error: 'outside_data_dir' });
      continue;
    }
    try {
      fs.unlinkSync(candidate.path);
      deleted.push(candidate);
    } catch (error) {
      failed.push({ ...candidate, error: error?.message || String(error) });
    }
  }
  return {
    deletedFiles: deleted.length,
    deletedBytes: deleted.reduce((sum, file) => sum + Number(file.bytes || 0), 0),
    deletedMB: formatMb(deleted.reduce((sum, file) => sum + Number(file.bytes || 0), 0)),
    failedFiles: failed.length,
    failedSamples: failed.slice(0, 20)
  };
}

function formatText(report = {}) {
  const lines = [
    `data-footprint: ${report.totals?.mb || 0}MB in ${report.dataDir}`,
    `candidates: files=${report.candidateTotals?.files || 0} reclaimable=${report.candidateTotals?.mb || 0}MB apply=${report.apply === true}`
  ];
  for (const dir of Array.isArray(report.directories) ? report.directories.slice(0, 10) : []) {
    lines.push(`- ${dir.name}: ${dir.mb}MB files=${dir.files}`);
  }
  if (report.applyResult) {
    lines.push(`apply: deleted=${report.applyResult.deletedFiles} deletedMB=${report.applyResult.deletedMB} failed=${report.applyResult.failedFiles}`);
  }
  return lines.join('\n');
}

function main() {
  const args = parseArgs();
  const report = collectFootprint(args);
  if (args.apply) {
    report.apply = true;
    report.applyResult = applyCandidates(report);
  }
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatText(report));
}

if (require.main === module) main();

module.exports = {
  applyCandidates,
  collectFootprint,
  formatText,
  parseArgs
};
