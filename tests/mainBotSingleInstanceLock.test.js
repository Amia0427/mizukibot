const assert = require('assert');
const fs = require('fs');
const path = require('path');

module.exports = (() => {
  const indexPath = path.join(__dirname, '..', 'index.js');
  const source = fs.readFileSync(indexPath, 'utf8');

  assert.ok(
    source.includes('if (existingPid === process.pid)') &&
      source.includes("Failed to replace self-owned lock file"),
    'main bot should replace a lock that already points at its own pid'
  );
  assert.ok(
    source.indexOf('if (existingPid === process.pid)') <
      source.indexOf("console.error('[Startup] MizukiBot is already running"),
    'self-owned lock handling should run before already-running detection'
  );

  console.log('mainBotSingleInstanceLock.test.js passed');
})();
