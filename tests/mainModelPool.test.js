const assert = require('assert');

const {
  normalizeCandidates,
  shuffleMainModelCandidates,
  runMainModelPool
} = require('../utils/mainModelPool');

function buildError(message) {
  return new Error(message);
}

module.exports = (async () => {
  const candidates = [
    { slot: 1, apiBaseUrl: 'https://one.example', apiKey: 'test-key-1', model: 'one', provider: 'openai_compatible' },
    { slot: 2, apiBaseUrl: 'https://two.example', apiKey: 'test-key-2', model: 'two', provider: 'openai_compatible' },
    { slot: 3, apiBaseUrl: 'https://one.example', apiKey: 'test-key-1', model: 'one', provider: 'openai_compatible' },
    { slot: 4, apiBaseUrl: 'https://four.example', apiKey: 'test-key-4', model: '', provider: 'openai_compatible' }
  ];
  const normalized = normalizeCandidates(candidates);
  assert.deepStrictEqual(normalized.map((item) => item.slot), [1, 2]);

  const shuffled = shuffleMainModelCandidates(normalized, () => 0);
  assert.deepStrictEqual(shuffled.map((item) => item.slot), [2, 1]);

  const attempts = [];
  const result = await runMainModelPool(normalized, async (candidate) => {
    attempts.push(candidate.slot);
    if (candidate.slot === 2) throw buildError('slot 2 failed');
    return { slot: candidate.slot };
  }, {
    random: () => 0
  });
  assert.deepStrictEqual(attempts, [2, 1]);
  assert.deepStrictEqual(result, { slot: 1 });

  await assert.rejects(
    () => runMainModelPool(normalized, async (candidate) => {
      if (candidate.slot === 2) throw buildError('first failed');
      throw buildError('second failed');
    }, { random: () => 0 }),
    (error) => {
      assert.deepStrictEqual(error.mainModelPoolAttempts.map((item) => item.slot), ['2', '1']);
      assert.strictEqual(new Set(error.mainModelPoolAttempts.map((item) => item.slot)).size, 2);
      return true;
    }
  );

  await assert.rejects(
    () => runMainModelPool(normalized, async () => {
      throw buildError('stop here');
    }, {
      random: () => 0,
      shouldContinue: () => false
    }),
    /stop here/
  );

  console.log('mainModelPool.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
