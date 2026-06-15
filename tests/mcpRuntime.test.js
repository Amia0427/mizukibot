const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

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

function createFakeMcpChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  child.stdin = {
    write(payload) {
      const lines = Buffer.from(payload).toString('utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      for (const line of lines) {
        const message = JSON.parse(line);
        if (!message.id) continue;
        if (message.method === 'initialize') {
          child.stdout.emit('data', Buffer.from(JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: {}
            }
          }) + '\n', 'utf8'));
        } else if (message.method === 'tools/list') {
          child.stdout.emit('data', Buffer.from(JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              tools: [{
                name: 'ping',
                description: 'Ping test tool',
                inputSchema: { type: 'object', properties: {} }
              }]
            }
          }) + '\n', 'utf8'));
        }
      }
      return true;
    }
  };
  return child;
}

module.exports = (async () => {
  const snapshot = { ...process.env };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-mcp-runtime-'));
  const configPath = path.join(tempDir, '.mcp.json');
  const childProcess = require('child_process');
  const originalSpawn = childProcess.spawn;
  let runtime = null;

  try {
    fs.writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        shared: {
          command: 'node',
          args: ['fake-mcp-server.js'],
          protocolMode: 'line'
        }
      }
    }), 'utf8');

    process.env.API_KEY = process.env.API_KEY || 'test-key';
    process.env.DATA_DIR = path.join(tempDir, 'data');
    process.env.MIZUKI_MCP_CONFIG = configPath;
    process.env.MCP_DISCOVERY_MODE = 'warm';
    process.env.MCP_WARM_ON_RUNTIME_INIT = 'false';
    clearProjectCache();

    let spawnCount = 0;
    let reentrantDiscovery = null;
    const spawnedChildren = [];
    childProcess.spawn = () => {
      spawnCount += 1;
      const child = createFakeMcpChild();
      spawnedChildren.push(child);
      if (spawnCount === 1) {
        reentrantDiscovery = runtime.discoverMcpServerTools('shared', { configPath });
      }
      return child;
    };

    runtime = require('../api/mcpRuntime');
    runtime.clearMcpRuntimeCaches();

    const tools = await runtime.discoverMcpServerTools('shared', { configPath });
    const reentrantTools = await reentrantDiscovery;
    assert.strictEqual(spawnCount, 1);
    assert.strictEqual(runtime.__getMcpSessionPoolSize(), 1);
    assert.deepStrictEqual(tools.map((item) => item.toolName), ['ping']);
    assert.deepStrictEqual(reentrantTools.map((item) => item.toolName), ['ping']);

    const child = spawnedChildren[0];
    assert.strictEqual(child.stdout.listenerCount('data'), 1);
    assert.strictEqual(child.stderr.listenerCount('data'), 1);
    assert.strictEqual(child.listenerCount('error'), 1);
    assert.strictEqual(child.listenerCount('exit'), 1);

    runtime.clearMcpRuntimeCaches();
    assert.strictEqual(child.stdout.listenerCount('data'), 0);
    assert.strictEqual(child.stderr.listenerCount('data'), 0);
    assert.strictEqual(child.listenerCount('error'), 0);
    assert.strictEqual(child.listenerCount('exit'), 0);
    assert.strictEqual(child.killed, true);
    assert.strictEqual(runtime.__getMcpSessionPoolSize(), 0);

    console.log('mcpRuntime.test.js passed');
  } finally {
    try {
      if (runtime) runtime.clearMcpRuntimeCaches();
    } catch (_) {}
    childProcess.spawn = originalSpawn;
    restoreEnv(snapshot);
    clearProjectCache();
  }
})();
