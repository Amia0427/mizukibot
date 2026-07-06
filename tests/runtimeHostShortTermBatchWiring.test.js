const assert = require('assert');
const fs = require('fs');
const path = require('path');

module.exports = (() => {
  const filePath = path.join(__dirname, '..', 'api', 'runtimeV2', 'host', 'index.js');
  const source = fs.readFileSync(filePath, 'utf8');

  assert.ok(
    source.includes("const { withSessionContextBatch } = require('../../../utils/shortTermSessionStore');"),
    'runtime host should import short-term session batch helper'
  );
  assert.ok(
    source.includes('appendShortTermHistory,\r\n    withSessionContextBatch,')
      || source.includes('appendShortTermHistory,\n    withSessionContextBatch,'),
    'persist node should receive short-term session batch helper'
  );

  console.log('runtimeHostShortTermBatchWiring.test.js passed');
})();
