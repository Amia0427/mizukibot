const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-qzone-client-'));
process.env.DATA_DIR = tempRoot;
process.env.API_KEY = process.env.API_KEY || 'test-key';
process.env.HTTP_ACCEPT_LANGUAGE = 'zh-CN,zh;q=0.9,en;q=0.8';

const { publishQzonePost, uploadQzoneImage } = require('../api/qzoneClient');

function createActionClient() {
  return {
    async callAction(action) {
      if (action === 'get_login_info') return { user_id: '12345' };
      if (action === 'get_credentials') {
        return {
          cookies: 'uin=o12345; p_skey=test_skey;',
          uin: '12345'
        };
      }
      throw new Error(`unexpected action: ${action}`);
    }
  };
}

(async () => {
  const publishCalls = [];
  const published = await publishQzonePost('我把杯子放回桌边，差点忘了刚刚想说什么。', {
    actionClient: createActionClient(),
    httpClient: {
      async post(url, body, options = {}) {
        publishCalls.push({ url, body, options });
        return { data: '{"code":0}' };
      }
    }
  });

  assert.strictEqual(published.success, true);
  assert.strictEqual(publishCalls.length, 1);
  assert.strictEqual(publishCalls[0].options.headers.Accept, '*/*');
  assert.strictEqual(publishCalls[0].options.headers['Accept-Language'], 'zh-CN,zh;q=0.9,en;q=0.8');
  assert.strictEqual(publishCalls[0].options.headers['Cache-Control'], 'no-cache');
  assert.strictEqual(publishCalls[0].options.headers.Pragma, 'no-cache');

  const imagePath = path.join(tempRoot, 'qzone-image.png');
  fs.writeFileSync(imagePath, Buffer.from('fake-image'));
  const uploadCalls = [];
  const uploaded = await uploadQzoneImage(imagePath, {
    actionClient: createActionClient(),
    uploadUrl: 'https://upload.example.test/cgi_upload_image',
    httpClient: {
      async post(url, body, options = {}) {
        uploadCalls.push({ url, body, options });
        return {
          data: [
            '<albumid>a</albumid>',
            '<lloc>l</lloc>',
            '<sloc>s</sloc>',
            '<type>1</type>',
            '<height>10</height>',
            '<width>20</width>',
            '<pre>https://example.test/pre?bo=prebo</pre>',
            '<url>https://example.test/url?bo=urlbo</url>'
          ].join('')
        };
      }
    }
  });

  assert.strictEqual(uploaded.success, true);
  assert.strictEqual(uploadCalls.length, 1);
  assert.strictEqual(uploadCalls[0].options.headers.Accept, '*/*');
  assert.strictEqual(uploadCalls[0].options.headers['Accept-Language'], 'zh-CN,zh;q=0.9,en;q=0.8');
  assert.strictEqual(uploadCalls[0].options.headers['Cache-Control'], 'no-cache');
  assert.strictEqual(uploadCalls[0].options.headers.Pragma, 'no-cache');

  console.log('qzoneClient.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
