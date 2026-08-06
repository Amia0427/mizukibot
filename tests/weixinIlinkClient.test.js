const assert = require('assert');

const { createIlinkClient } = require('../src/platforms/weixin/ilink-client');

function jsonResponse(body, options = {}) {
  return {
    ok: options.ok !== false,
    status: options.status || 200,
    statusText: options.statusText || 'OK',
    async text() {
      return JSON.stringify(body);
    }
  };
}

(async () => {
  const calls = [];
  const responses = [
    { ret: 0, msgs: [], get_updates_buf: 'cursor-2' },
    { ret: 0 },
    { ret: 0, upload_param: 'upload-token' },
    { ret: 0, typing_ticket: 'ticket' },
    { ret: 0 },
    { ret: 0 },
    { ret: 0 }
  ];
  const client = createIlinkClient({
    baseUrl: 'https://api.example/root',
    token: 'secret-token',
    fetch: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(responses.shift());
    }
  });

  const updates = await client.getUpdates({ cursor: 'cursor-1' });
  await client.sendMessage({ msg: { to_user_id: 'wx-user', item_list: [] } });
  const upload = await client.getUploadUrl({ filekey: 'file-key', media_type: 3 });
  const config = await client.getConfig({ ilinkUserId: 'wx-user', contextToken: 'ctx' });
  await client.sendTyping({ ilink_user_id: 'wx-user', typing_ticket: 'ticket', status: 1 });
  await client.notifyStart();
  await client.notifyStop();

  assert.strictEqual(updates.get_updates_buf, 'cursor-2');
  assert.strictEqual(upload.upload_param, 'upload-token');
  assert.strictEqual(config.typing_ticket, 'ticket');
  assert.deepStrictEqual(calls.map((call) => call.url), [
    'https://api.example/root/ilink/bot/getupdates',
    'https://api.example/root/ilink/bot/sendmessage',
    'https://api.example/root/ilink/bot/getuploadurl',
    'https://api.example/root/ilink/bot/getconfig',
    'https://api.example/root/ilink/bot/sendtyping',
    'https://api.example/root/ilink/bot/msg/notifystart',
    'https://api.example/root/ilink/bot/msg/notifystop'
  ]);
  assert.ok(calls.every((call) => call.init.headers.Authorization === 'Bearer secret-token'));
  assert.ok(calls.every((call) => call.init.headers.AuthorizationType === 'ilink_bot_token'));
  assert.ok(calls.every((call) => call.init.headers['X-WECHAT-UIN']));
  assert.deepStrictEqual(JSON.parse(calls[0].init.body), {
    get_updates_buf: 'cursor-1',
    base_info: { channel_version: '1.0.0', bot_agent: 'MizukiBot/1.0.0' }
  });
  assert.deepStrictEqual(JSON.parse(calls[3].init.body), {
    ilink_user_id: 'wx-user',
    context_token: 'ctx',
    base_info: { channel_version: '1.0.0', bot_agent: 'MizukiBot/1.0.0' }
  });

  const loginCalls = [];
  const loginClient = createIlinkClient({
    baseUrl: 'https://ignored.example',
    fetch: async (url, init) => {
      loginCalls.push({ url, init });
      if (init.method === 'POST') {
        return jsonResponse({ qrcode: 'opaque-qr', qrcode_img_content: 'https://qr.example/image' });
      }
      return jsonResponse({
        status: 'confirmed',
        bot_token: 'new-token',
        ilink_bot_id: 'bot-id',
        ilink_user_id: 'wx-user',
        baseurl: 'https://assigned.example'
      });
    }
  });
  const qr = await loginClient.getQrCode({ botType: '3', localTokenList: ['old-token'] });
  const status = await loginClient.getQrCodeStatus({ qrcode: qr.qrcode, verifyCode: '123456' });

  assert.strictEqual(loginCalls[0].url, 'https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3');
  assert.deepStrictEqual(JSON.parse(loginCalls[0].init.body), { local_token_list: ['old-token'] });
  assert.strictEqual(loginCalls[0].init.headers.AuthorizationType, 'ilink_bot_token');
  assert.ok(loginCalls[0].init.headers['X-WECHAT-UIN']);
  assert.strictEqual(
    loginCalls[1].url,
    'https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=opaque-qr&verify_code=123456'
  );
  assert.strictEqual(loginCalls[1].init.method, 'GET');
  assert.strictEqual(loginCalls[1].init.headers.AuthorizationType, undefined);
  assert.strictEqual(status.bot_token, 'new-token');

  const errorClient = createIlinkClient({
    baseUrl: 'https://api.example',
    token: 'secret-token',
    fetch: async () => jsonResponse({ ret: 7, errmsg: 'denied' })
  });
  await assert.rejects(
    errorClient.sendMessage({ msg: {} }),
    (error) => error.code === 'ILINK_API_ERROR'
      && error.ret === 7
      && !error.message.includes('denied')
  );

  const httpErrorClient = createIlinkClient({
    baseUrl: 'https://api.example',
    token: 'secret-token',
    fetch: async () => jsonResponse({ context_token: 'must-not-leak' }, {
      ok: false,
      status: 401
    })
  });
  await assert.rejects(
    httpErrorClient.notifyStart(),
    (error) => error.code === 'ILINK_HTTP_ERROR'
      && error.status === 401
      && !error.message.includes('must-not-leak')
  );

  console.log('weixinIlinkClient.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
