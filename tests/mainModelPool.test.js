const assert = require('assert');

const {
  normalizeCandidates,
  shuffleMainModelCandidates,
  runMainModelPool
} = require('../utils/mainModelPool');

function buildError(message) {
  return new Error(message);
}

function createRandomSequence(values = []) {
  let index = 0;
  return () => {
    const value = index < values.length ? values[index] : values[values.length - 1];
    index += 1;
    return value;
  };
}

module.exports = (async () => {
  const candidates = [
    { slot: 1, apiBaseUrl: 'https://one.example', apiKey: 'test-key-1', model: 'one', provider: 'openai_compatible', weight: 3 },
    { slot: 2, apiBaseUrl: 'https://two.example', apiKey: 'test-key-2', model: 'two', provider: 'openai_compatible', weight: 1 },
    { slot: 3, apiBaseUrl: 'https://one.example', apiKey: 'test-key-1', model: 'one', provider: 'openai_compatible', weight: 9 },
    { slot: 4, apiBaseUrl: 'https://four.example', apiKey: 'test-key-4', model: '', provider: 'openai_compatible' }
  ];
  const normalized = normalizeCandidates(candidates);
  assert.deepStrictEqual(normalized.map((item) => item.slot), [1, 2]);
  assert.deepStrictEqual(normalized.map((item) => item.weight), [3, 1]);

  const shuffled = shuffleMainModelCandidates(normalized, createRandomSequence([0.75, 0.2]));
  assert.deepStrictEqual(shuffled.map((item) => item.slot), [2, 1]);

  const attempts = [];
  const result = await runMainModelPool(normalized, async (candidate) => {
    attempts.push(candidate.slot);
    if (candidate.slot === 2) throw buildError('slot 2 failed');
    return { slot: candidate.slot };
  }, {
    random: createRandomSequence([0.75, 0.2])
  });
  assert.deepStrictEqual(attempts, [2, 1]);
  assert.deepStrictEqual(result, { slot: 1 });

  await assert.rejects(
    () => runMainModelPool(normalized, async (candidate) => {
      if (candidate.slot === 2) throw buildError('first failed');
      throw buildError('second failed');
    }, { random: createRandomSequence([0.75, 0.2]) }),
    (error) => {
      assert.deepStrictEqual(error.mainModelPoolAttempts.map((item) => item.slot), ['2', '1']);
      assert.strictEqual(new Set(error.mainModelPoolAttempts.map((item) => item.slot)).size, 2);
      assert.deepStrictEqual(error.mainModelPoolAttempts.map((item) => item.weight), [1, 3]);
      return true;
    }
  );

  await assert.rejects(
    () => runMainModelPool(normalized, async () => {
      throw buildError('stop here');
    }, {
      random: createRandomSequence([0.75]),
      shouldContinue: () => false
    }),
    /stop here/
  );

  console.log('mainModelPool.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
