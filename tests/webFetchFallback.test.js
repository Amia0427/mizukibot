const assert = require('assert');
const axios = require('axios');

const { TOOL_EXECUTORS } = require('../api/toolExecutors');

module.exports = (async () => {
  const originalGet = axios.get;
  try {
    axios.get = async () => {
      const error = new Error('request blocked');
      error.code = 'ERR_BAD_REQUEST';
      error.response = { status: 403, data: 'Cloudflare attention required' };
      throw error;
    };
    const url = 'https://93.184.216.34/docs';
    const out = await TOOL_EXECUTORS.web_fetch({ url });
    assert.ok(String(out).includes(`链接：${url}`));
    assert.ok(String(out).includes('标题：页面抓取受限'));
    assert.ok(!String(out).startsWith('页面提取失败：'));
  } finally {
    axios.get = originalGet;
  }

  console.log('webFetchFallback.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
