const assert = require('assert');
const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, '..', '.mcp.json');
const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const servers = parsed && parsed.mcpServers && typeof parsed.mcpServers === 'object'
  ? parsed.mcpServers
  : {};

function extractPackageVersion(arg = '') {
  const value = String(arg || '').trim();
  if (!value || /^https?:\/\//i.test(value)) return '';
  if (value.startsWith('@')) {
    const secondAt = value.indexOf('@', 1);
    return secondAt >= 0 ? value.slice(secondAt + 1) : '';
  }
  const at = value.indexOf('@');
  return at >= 0 ? value.slice(at + 1) : '';
}

for (const [serverName, server] of Object.entries(servers)) {
  const command = String(server.command || '').trim().toLowerCase();
  const args = Array.isArray(server.args) ? server.args.map(String) : [];
  assert.ok(!args.some((arg) => /@latest\b/i.test(arg)), `${serverName} must not use @latest`);

  if (command !== 'npx') continue;
  const packageArgs = args.filter((arg) => !arg.startsWith('-'));
  assert.ok(packageArgs.length > 0, `${serverName} npx command must name a package`);
  for (const packageArg of packageArgs) {
    const version = extractPackageVersion(packageArg);
    assert.ok(version && version.toLowerCase() !== 'latest', `${serverName} npx package must pin a version`);
  }
}

console.log('mcpConfigSecurity.test.js passed');
