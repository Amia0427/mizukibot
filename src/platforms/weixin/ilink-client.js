const crypto = require('crypto');

const pkg = require('../../../package.json');

const LOGIN_BASE_URL = 'https://ilinkai.weixin.qq.com';
const BASE_INFO = Object.freeze({
  channel_version: pkg.version,
  bot_agent: `MizukiBot/${pkg.version}`
});

function withTrailingSlash(value) {
  return value.endsWith('/') ? value : `${value}/`;
}

function createWechatUin() {
  const value = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(value), 'utf8').toString('base64');
}

function buildClientVersion(version) {
  const [major = 0, minor = 0, patch = 0] = String(version)
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

function createIlinkClient(options) {
  const fetchImpl = options.fetch;
  const baseUrl = withTrailingSlash(options.baseUrl);
  const token = String(options.token || '').trim();

  function commonHeaders() {
    return {
      'iLink-App-Id': 'bot',
      'iLink-App-ClientVersion': String(buildClientVersion(pkg.version))
    };
  }

  function authenticatedHeaders() {
    const headers = {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': createWechatUin(),
      ...commonHeaders()
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  async function readJson(response, label) {
    const body = await response.text();
    if (!response.ok) {
      const error = new Error(`${label} failed with HTTP ${response.status}`);
      error.code = 'ILINK_HTTP_ERROR';
      error.status = response.status;
      throw error;
    }
    try {
      return JSON.parse(body);
    } catch (_) {
      throw new Error(`${label} returned invalid JSON`);
    }
  }

  async function post(endpoint, body, requestOptions = {}) {
    const response = await fetchImpl(new URL(endpoint, baseUrl).toString(), {
      method: 'POST',
      headers: authenticatedHeaders(),
      body: JSON.stringify(body),
      ...(requestOptions.signal ? { signal: requestOptions.signal } : {})
    });
    return readJson(response, requestOptions.label || endpoint);
  }

  async function getUpdates(input = {}) {
    return post('ilink/bot/getupdates', {
      get_updates_buf: input.cursor ?? input.get_updates_buf ?? '',
      base_info: BASE_INFO
    }, { label: 'getUpdates', signal: input.signal });
  }

  async function sendMessage(body) {
    const response = await post('ilink/bot/sendmessage', {
      ...body,
      base_info: BASE_INFO
    }, { label: 'sendMessage' });
    if (response.ret && response.ret !== 0) {
      const error = new Error(`sendMessage failed with ret=${response.ret}`);
      error.code = 'ILINK_API_ERROR';
      error.ret = response.ret;
      throw error;
    }
    return response;
  }

  function getUploadUrl(body) {
    return post('ilink/bot/getuploadurl', {
      ...body,
      base_info: BASE_INFO
    }, { label: 'getUploadUrl' });
  }

  function getConfig(input) {
    return post('ilink/bot/getconfig', {
      ilink_user_id: input.ilinkUserId,
      context_token: input.contextToken,
      base_info: BASE_INFO
    }, { label: 'getConfig' });
  }

  function sendTyping(body) {
    return post('ilink/bot/sendtyping', {
      ...body,
      base_info: BASE_INFO
    }, { label: 'sendTyping' });
  }

  function notifyStart() {
    return post('ilink/bot/msg/notifystart', { base_info: BASE_INFO }, { label: 'notifyStart' });
  }

  function notifyStop(input = {}) {
    return post('ilink/bot/msg/notifystop', { base_info: BASE_INFO }, {
      label: 'notifyStop',
      signal: input.signal
    });
  }

  async function getQrCode(input = {}) {
    const url = new URL(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(input.botType || '3')}`, withTrailingSlash(LOGIN_BASE_URL));
    const response = await fetchImpl(url.toString(), {
      method: 'POST',
      headers: authenticatedHeaders(),
      body: JSON.stringify({ local_token_list: input.localTokenList || [] })
    });
    return readJson(response, 'getQrCode');
  }

  async function getQrCodeStatus(input) {
    const url = new URL('ilink/bot/get_qrcode_status', withTrailingSlash(LOGIN_BASE_URL));
    url.searchParams.set('qrcode', input.qrcode);
    if (input.verifyCode) url.searchParams.set('verify_code', input.verifyCode);
    const response = await fetchImpl(url.toString(), {
      method: 'GET',
      headers: commonHeaders(),
      ...(input.signal ? { signal: input.signal } : {})
    });
    return readJson(response, 'getQrCodeStatus');
  }

  return Object.freeze({
    getConfig,
    getQrCode,
    getQrCodeStatus,
    getUpdates,
    getUploadUrl,
    notifyStart,
    notifyStop,
    sendMessage,
    sendTyping
  });
}

module.exports = {
  BASE_INFO,
  LOGIN_BASE_URL,
  createIlinkClient
};
