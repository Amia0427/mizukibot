const assert = require('assert');

const {
  buildReplyTextVariants,
  finalizeReplyText
} = require('../api/runtimeV2/model/service');

module.exports = (async () => {
  const raw = '答复前<think>内部推理</think>答复后';
  const variants = buildReplyTextVariants(raw, '', { preserveThink: true });
  assert.strictEqual(variants.visibleText, raw);
  assert.strictEqual(variants.persistedText, '答复前答复后');

  const finalized = await finalizeReplyText(raw, '', {
    preserveThink: true,
    disableHumanizer: true
  });
  assert.strictEqual(finalized.visibleText, raw);
  assert.strictEqual(finalized.persistedText, '答复前答复后');

  console.log('modelServiceCot.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
