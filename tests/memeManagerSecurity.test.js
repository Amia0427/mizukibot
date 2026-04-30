const assert = require('assert');
const axios = require('axios');

const {
  consumePendingUploadFromMessage,
  startUploadSession
} = require('../core/memeManager');

async function withAxiosGetStub(stub, fn) {
  const original = axios.get;
  axios.get = stub;
  try {
    await fn();
  } finally {
    axios.get = original;
  }
}

(async () => {
  await withAxiosGetStub(async () => {
    throw new Error('axios.get should not be called for unsafe meme image URLs');
  }, async () => {
    startUploadSession({ groupId: '10001', userId: '20002', categoryName: 'test' });
    const result = await consumePendingUploadFromMessage({
      post_type: 'message',
      message_type: 'group',
      group_id: '10001',
      user_id: '20002',
      raw_message: '[CQ:image,file=x,url=http://127.0.0.1/private.png]'
    });

    assert.strictEqual(result.consumed, true);
    assert.match(result.replyText, /图片来源地址不安全/);
  });

  console.log('memeManagerSecurity.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
