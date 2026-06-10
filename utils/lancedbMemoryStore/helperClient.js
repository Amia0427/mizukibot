const { spawn } = require('child_process');
const path = require('path');
const config = require('../../config');

function safeSearchFailure(reason = 'helper_unavailable') {
  return { ok: false, skipped: true, reason, rows: [], results: [] };
}

function shouldUseLanceDbHelper() {
  return config.LOW_RESOURCE_LANCEDB_HELPER_ENABLED === true
    && config.MIZUKIBOT_RUNTIME_ROLE === 'main';
}

function buildHelperPayload(kind = '', queryEmbedding = [], context = {}, options = {}) {
  return {
    kind,
    queryEmbedding: Array.isArray(queryEmbedding) ? queryEmbedding : [],
    context: context && typeof context === 'object' ? context : {},
    options: {
      limit: options.limit,
      timeoutMs: options.timeoutMs,
      tableName: options.tableName,
      lancedbTimeoutMs: options.lancedbTimeoutMs,
      lancedbTableName: options.lancedbTableName,
      dir: options.dir,
      partitionMode: options.partitionMode,
      bucketCount: options.bucketCount
    }
  };
}

function searchLanceDbWithHelper(kind = '', queryEmbedding = [], context = {}, options = {}) {
  if (!shouldUseLanceDbHelper()) return null;
  const timeoutMs = Math.max(
    500,
    Number(options.helperTimeoutMs || config.LOW_RESOURCE_LANCEDB_HELPER_TIMEOUT_MS || 2500) || 2500
  );
  const scriptPath = path.resolve(__dirname, '../../scripts/lancedb-search-helper.js');
  const payload = JSON.stringify(buildHelperPayload(kind, queryEmbedding, context, options));

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(process.execPath, [scriptPath], {
      cwd: path.resolve(__dirname, '../..'),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        MIZUKIBOT_RUNTIME_ROLE: 'lancedb_helper'
      }
    });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch (_) {}
      finish(safeSearchFailure('helper_timeout'));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      finish(safeSearchFailure(`helper_error:${error.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(safeSearchFailure(`helper_exit_${code}:${stderr.trim().slice(0, 160)}`));
        return;
      }
      try {
        const result = JSON.parse(stdout || '{}');
        finish({
          ...safeSearchFailure('helper_empty'),
          ...result,
          helper: true
        });
      } catch (error) {
        finish(safeSearchFailure(`helper_parse_failed:${error.message}`));
      }
    });

    child.stdin.end(payload);
  });
}

module.exports = {
  buildHelperPayload,
  safeSearchFailure,
  searchLanceDbWithHelper,
  shouldUseLanceDbHelper
};
