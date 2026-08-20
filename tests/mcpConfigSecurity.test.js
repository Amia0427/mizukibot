const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildMcpChildEnv } = require('../api/mcp/config');

const configPath = path.join(__dirname, '..', '.mcp.json');
const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const servers = parsed && parsed.mcpServers && typeof parsed.mcpServers === 'object'
  ? parsed.mcpServers
  : {};

for (const [serverName, server] of Object.entries(servers)) {
  const command = String(server.command || '').trim().toLowerCase();
  const args = Array.isArray(server.args) ? server.args.map(String) : [];
  assert.ok(!args.some((arg) => /@latest\b/i.test(arg)), `${serverName} must not use @latest`);

  assert.notStrictEqual(command, 'npx', `${serverName} must not use runtime npx downloads`);
}

const previousSecret = process.env.MCP_SECURITY_TEST_SECRET;
process.env.MCP_SECURITY_TEST_SECRET = 'must-not-enter-child';
const childEnv = buildMcpChildEnv({ MEMOS_API_KEY: 'explicit-server-secret' });
assert.strictEqual(childEnv.MEMOS_API_KEY, 'explicit-server-secret');
assert.strictEqual(childEnv.MCP_SECURITY_TEST_SECRET, undefined);
assert.strictEqual(childEnv.MIZUKIBOT_MCP_CHILD, '1');
if (previousSecret === undefined) delete process.env.MCP_SECURITY_TEST_SECRET;
else process.env.MCP_SECURITY_TEST_SECRET = previousSecret;

console.log('mcpConfigSecurity.test.js passed');
