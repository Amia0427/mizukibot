const assert = require('assert');

const {
  analyzeMainReplyDegeneration,
  buildMainReplyDegenerationRepairInstruction,
  trimMainReplyDegeneratedTail
} = require('../utils/mainReplyDegenerationGuard');

module.exports = (async () => {
  const looping = [
    '我懂你的意思，就是这件事其实有点复杂。',
    '我懂你的意思，就是这件事其实有点复杂。',
    '我懂你的意思，就是这件事其实有点复杂。',
    '我懂你的意思，就是这件事其实有点复杂。'
  ].join('');
  const loopAnalysis = analyzeMainReplyDegeneration(looping);
  assert.strictEqual(loopAnalysis.degenerated, true);
  assert.ok(loopAnalysis.reasons.includes('repeated_sentence'));
  assert.ok(loopAnalysis.score > 0);

  const ngramLoop = '喜欢你不是因为某一个标签，而是因为你说话时会认真接住我。'.repeat(6);
  const ngramAnalysis = analyzeMainReplyDegeneration(ngramLoop);
  assert.strictEqual(ngramAnalysis.degenerated, true);
  assert.ok(ngramAnalysis.reasons.includes('repeated_ngram'));
  assert.ok(!Object.prototype.hasOwnProperty.call(ngramAnalysis.metrics, 'topNgram'));
  assert.ok(ngramAnalysis.metrics.topNgramLength > 0);

  const normal = '我最喜欢你的地方，是你会把很小的事也认真放在心上。不是那种用力表演的温柔，是聊天里慢慢露出来的稳定感。';
  const normalAnalysis = analyzeMainReplyDegeneration(normal);
  assert.strictEqual(normalAnalysis.degenerated, false);
  assert.deepStrictEqual(normalAnalysis.reasons, []);

  const trimmed = trimMainReplyDegeneratedTail('先说结论。你适合先从立直和振听开始。你适合先从立直和振听开始。你适合先从立直和振听开始。');
  assert.strictEqual(trimmed, '先说结论。你适合先从立直和振听开始。');

  const instruction = buildMainReplyDegenerationRepairInstruction(loopAnalysis);
  assert.ok(instruction.includes('sampling degeneration'));
  assert.ok(instruction.includes('Do not repeat'));

  console.log('mainReplyDegenerationGuard.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
