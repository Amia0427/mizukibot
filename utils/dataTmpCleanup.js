const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const DEFAULT_FAILED_SAMPLE_LIMIT = 20;

function normalizeForCompare(filePath) {
  const resolved = path.resolve(String(filePath || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isInsidePath(candidate, root) {
  const normalizedCandidate = normalizeForCompare(candidate);
  const normalizedRoot = normalizeForCompare(root);
  return normalizedCandidate === normalizedRoot
    || normalizedCandidate.startsWith(normalizedRoot + path.sep);
}

function shouldSkipPath(candidate, excludedRoots = []) {
  return excludedRoots.some((root) => isInsidePath(candidate, root));
}

function cleanupStaleDataTmpFiles(options = {}) {
  if (!options.dataDir) {
    return {
      ok: false,
      error: 'missing_data_dir',
      deletedFiles: 0,
      deletedBytes: 0,
      failedFiles: 0
    };
  }

  const dataDir = path.resolve(String(options.dataDir));
  const maxAgeMs = Number.isFinite(Number(options.maxAgeMs))
    ? Math.max(0, Number(options.maxAgeMs))
    : DEFAULT_MAX_AGE_MS;
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const failedSampleLimit = Number.isInteger(options.failedSampleLimit)
    ? Math.max(0, options.failedSampleLimit)
    : DEFAULT_FAILED_SAMPLE_LIMIT;
  const excludedRoots = (Array.isArray(options.excludeDirs) ? options.excludeDirs : [])
    .filter(Boolean)
    .map((item) => path.resolve(String(item)));

  const summary = {
    ok: true,
    dataDir,
    maxAgeMs,
    scannedFiles: 0,
    deletedFiles: 0,
    deletedBytes: 0,
    skippedFreshFiles: 0,
    skippedExcludedFiles: 0,
    failedFiles: 0,
    failedSamples: []
  };

  if (!fs.existsSync(dataDir)) return summary;

  const stack = [dataDir];
  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!isInsidePath(currentDir, dataDir) || shouldSkipPath(currentDir, excludedRoots)) continue;

    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (error) {
      summary.failedFiles += 1;
      if (summary.failedSamples.length < failedSampleLimit) {
        summary.failedSamples.push({ path: currentDir, error: error?.message || String(error) });
      }
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (!isInsidePath(fullPath, dataDir)) continue;

      if (entry.isDirectory()) {
        if (!shouldSkipPath(fullPath, excludedRoots)) stack.push(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.tmp')) continue;

      summary.scannedFiles += 1;
      if (shouldSkipPath(fullPath, excludedRoots)) {
        summary.skippedExcludedFiles += 1;
        continue;
      }

      let stat = null;
      try {
        stat = fs.statSync(fullPath);
      } catch (error) {
        summary.failedFiles += 1;
        if (summary.failedSamples.length < failedSampleLimit) {
          summary.failedSamples.push({ path: fullPath, error: error?.message || String(error) });
        }
        continue;
      }

      if ((nowMs - Number(stat.mtimeMs || 0)) < maxAgeMs) {
        summary.skippedFreshFiles += 1;
        continue;
      }

      try {
        fs.unlinkSync(fullPath);
        summary.deletedFiles += 1;
        summary.deletedBytes += Number(stat.size || 0);
      } catch (error) {
        summary.failedFiles += 1;
        if (summary.failedSamples.length < failedSampleLimit) {
          summary.failedSamples.push({ path: fullPath, error: error?.message || String(error) });
        }
      }
    }
  }

  return summary;
}

module.exports = {
  DEFAULT_MAX_AGE_MS,
  cleanupStaleDataTmpFiles,
  isInsidePath
};
