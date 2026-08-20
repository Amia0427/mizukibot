const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createWebAuditLogger, maskClientIp } = require('../web/auditLog');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-web-audit-'));
const logPath = path.join(tempRoot, 'web-audit.jsonl');
try {
  assert.strictEqual(maskClientIp('203.0.113.42'), '203.0.113.0');
  assert.strictEqual(maskClientIp('2001:db8::42'), '[redacted-ipv6]');
  const logger = createWebAuditLogger({ filePath: logPath });
  assert.strictEqual(logger.record({
    actor: 'web-admin',
    role: 'admin',
    method: 'POST',
    path: '/api/settings',
    status: 200,
    clientIp: '203.0.113.42',
    action: 'write'
  }), true);
  const line = fs.readFileSync(logPath, 'utf8').trim();
  assert.ok(line.includes('203.0.113.0'));
  assert.ok(!line.includes('203.0.113.42'));
  assert.ok(!line.includes('web-token'));
  console.log('webAuditLogSecurity.test.js passed');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
