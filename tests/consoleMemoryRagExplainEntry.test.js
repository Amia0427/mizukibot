const assert = require('assert');

const {
  main,
  normalizeMemoryRagExplainArgs,
  runMemoryRagExplain
} = require('../scripts/console');

module.exports = (async () => {
  assert.deepStrictEqual(
    normalizeMemoryRagExplainArgs(['u_real', '昨天聊了什么', '--facet', 'journal']),
    ['--user-id', 'u_real', '昨天聊了什么', '--facet', 'journal']
  );
  assert.deepStrictEqual(
    normalizeMemoryRagExplainArgs(['--user-id', 'u_real', '--query', '昨天聊了什么']),
    ['--user-id', 'u_real', '--query', '昨天聊了什么']
  );

  let parsedArgv = null;
  let runOptions = null;
  const memoryRagExplain = {
    parseArgs(argv) {
      parsedArgv = argv;
      return { userId: argv[1], query: argv[2], source: 'all' };
    },
    run(options) {
      runOptions = options;
      return Promise.resolve({ ok: true, input: options });
    }
  };

  const report = await runMemoryRagExplain(['u_real', '昨天聊了什么'], { memoryRagExplain });
  assert.strictEqual(report.ok, true);
  assert.deepStrictEqual(parsedArgv, ['--user-id', 'u_real', '昨天聊了什么']);
  assert.deepStrictEqual(runOptions, {
    userId: 'u_real',
    query: '昨天聊了什么',
    source: 'all'
  });

  parsedArgv = null;
  await main(['rag', 'u_real', '今天提到的寿司'], { memoryRagExplain });
  assert.deepStrictEqual(parsedArgv, ['--user-id', 'u_real', '今天提到的寿司']);

  console.log('consoleMemoryRagExplainEntry.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
