const assert = require('assert');

const { TOOL_EXECUTORS } = require('../api/toolExecutors');

module.exports = (async () => {
  const out = await TOOL_EXECUTORS.web_fetch({ url: 'https://platform.openai.com/docs' });
  assert.ok(String(out).includes('链接：https://platform.openai.com/docs'));
  assert.ok(
    String(out).includes('标题：页面抓取受限')
    || String(out).includes('标题：')
  );
  assert.ok(!String(out).startsWith('页面提取失败：'));

  console.log('webFetchFallback.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
