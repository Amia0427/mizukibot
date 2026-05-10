const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function clearProjectCache() {
  const projectRoot = path.resolve(__dirname, '..') + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(projectRoot)) delete require.cache[key];
  }
}

function restoreEnv(snapshot = {}) {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(snapshot)) {
    process.env[key] = value;
  }
}

module.exports = (() => {
  const snapshot = { ...process.env };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-mcp-lazy-'));
  const configPath = path.join(tempDir, '.mcp.json');

  try {
    fs.writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        fetch: {
          command: 'node',
          args: ['missing-local-mcp-server.js', 'fetch']
        }
      }
    }), 'utf8');

    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.DATA_DIR = path.join(tempDir, 'data');
    process.env.MIZUKI_MCP_CONFIG = configPath;
    process.env.MCP_DISCOVERY_MODE = 'lazy';
    process.env.MCP_WARM_ON_RUNTIME_INIT = 'false';
    process.env.MCP_SESSION_IDLE_TTL_MS = '10';
    clearProjectCache();

    const runtime = require('../api/mcpRuntime');
    runtime.clearMcpRuntimeCaches();

    return runtime.discoverMcpTools().then((tools) => {
      assert.ok(tools.some((item) => item.functionName === 'mcp_fetch_fetch_url'));
      assert.strictEqual(runtime.__getMcpSessionPoolSize(), 0);
      return runtime.callMcpTool('fetch', 'fetch_url', { url: 'https://example.com' });
    }).then((result) => {
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.fallback, true);
      assert.strictEqual(result.diagnostic.mode, 'static_replacement');
      assert.strictEqual(runtime.__getMcpSessionPoolSize(), 0);
      runtime.cleanupIdleMcpSessions(Date.now() + 1000);
      assert.strictEqual(runtime.__getMcpSessionPoolSize(), 0);
      console.log('mcpLazyDiscovery.test.js passed');
    }).finally(() => {
      runtime.clearMcpRuntimeCaches();
      restoreEnv(snapshot);
      clearProjectCache();
    });
  } catch (error) {
    restoreEnv(snapshot);
    clearProjectCache();
    throw error;
  }
})();
