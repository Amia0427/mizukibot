const assert = require('assert');
const fs = require('fs');
const path = require('path');

module.exports = (() => {
  const filePath = path.join(__dirname, '..', 'api', 'runtimeV2', 'host.js');
  const source = fs.readFileSync(filePath, 'utf8');

  assert.ok(
    source.includes("options.persistedReplyText = String(out?.output?.persistedReplyText || out?.output?.finalReply || out?.output?.draftReply || '').trim();"),
    'host should expose persistedReplyText to upper layers'
  );
  assert.ok(
    source.includes("options.displayReplyText = String(out?.output?.displayReply || '').trim();"),
    'host should expose displayReplyText to upper layers'
  );
  assert.ok(
    source.includes("sanitizeUserFacingText(out?.output?.displayReply || out?.output?.finalReply || out?.output?.draftReply || '', {"),
    'host should prefer displayReply when returning the user-visible text'
  );

  console.log('runtimeHostCotSource.test.js passed');
})();
