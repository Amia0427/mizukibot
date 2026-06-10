const fs = require('fs');
const path = require('path');
const axios = require('axios');
const config = require('../config');
const { getNapCatActionClient, NapCatActionError } = require('./napcatActionClient');

function parseCookieString(cookieText = '') {
  const text = String(cookieText || '').trim();
  const cookieMap = {};
  if (!text) return cookieMap;

  for (const part of text.split(';')) {
    const item = String(part || '').trim();
    if (!item) continue;
    const eqIndex = item.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = item.slice(0, eqIndex).trim();
    const value = item.slice(eqIndex + 1).trim();
    if (!key) continue;
    cookieMap[key] = value;
  }

  return cookieMap;
}

function calcGtk(skey = '') {
  let hash = 5381;
  for (const char of String(skey || '')) {
    hash += (hash << 5) + char.charCodeAt(0);
  }
  return String(hash & 0x7fffffff);
}

function normalizeUin(uin = '') {
  const digits = String(uin || '').replace(/[^\d]/g, '');
  if (!digits) return '';
  return digits.startsWith('0') ? digits : digits;
}

function resolveCookieBundle(cookieText = '', uin = '') {
  const cookie = String(cookieText || '').trim();
  const cookieMap = parseCookieString(cookie);
  const skey = String(cookieMap.p_skey || cookieMap.skey || '').trim();
  return {
    cookie,
    cookieMap,
    uin: normalizeUin(uin || cookieMap.uin || cookieMap.p_uin || ''),
    skey,
    gtk: skey ? calcGtk(skey) : ''
  };
}

function isSuccessfulQzoneResponse(text = '') {
  return /"code"\s*:\s*0/.test(String(text || ''));
}

function clampTimeoutMs(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1000, Math.floor(n));
}

function createHttpClient(options = {}) {
  return options.httpClient || axios;
}

async function getLoginInfo(actionClient = getNapCatActionClient()) {
  const info = await actionClient.callAction('get_login_info');
  return info && typeof info === 'object' ? info : {};
}

async function resolveQzoneCredentials(options = {}) {
  const actionClient = options.actionClient || getNapCatActionClient();
  const timeoutMs = clampTimeoutMs(
    options.timeoutMs || config.NAPCAT_ACTION_TIMEOUT_MS,
    15000
  );

  const loginInfo = await getLoginInfo(actionClient);
  const loginUin = normalizeUin(loginInfo.user_id || loginInfo.uin || '');

  try {
    const credentialData = await actionClient.callAction(
      'get_credentials',
      { domain: 'qzone.qq.com' },
      { timeoutMs }
    );
    const cookie = String(
      credentialData?.cookies
      || credentialData?.cookie
      || credentialData?.cookie_string
      || ''
    ).trim();
    const bundle = resolveCookieBundle(cookie, credentialData?.uin || loginUin);
    if (!bundle.cookie) {
      throw new NapCatActionError('NapCat credentials returned empty cookie', {
        action: 'get_credentials'
      });
    }
    return {
      source: 'napcat_credentials',
      ...bundle
    };
  } catch (error) {
    const cookieData = await actionClient.callAction(
      'get_cookies',
      { domain: 'qzone.qq.com' },
      { timeoutMs }
    );
    const cookie = String(
      cookieData?.cookies
      || cookieData?.cookie
      || cookieData?.cookie_string
      || ''
    ).trim();
    const bundle = resolveCookieBundle(cookie, cookieData?.uin || loginUin);
    if (!bundle.cookie) {
      throw new NapCatActionError('NapCat cookies returned empty cookie', {
        action: 'get_cookies'
      });
    }
    return {
      source: 'napcat_cookies',
      fallbackError: error,
      ...bundle
    };
  }
}

function resolveManualCookieBundle() {
  const bundle = resolveCookieBundle(
    String(config.QZONE_COOKIE || '').trim(),
    String(config.QZONE_UIN || '').trim()
  );
  return {
    source: 'manual_cookie',
    ...bundle
  };
}

async function resolveQzoneSession(options = {}) {
  try {
    const napcatBundle = await resolveQzoneCredentials(options);
    if (!napcatBundle.gtk) {
      return {
        ok: false,
        source: napcatBundle.source,
        reason: 'NapCat credentials missing skey'
      };
    }
    if (!napcatBundle.uin) {
      return {
        ok: false,
        source: napcatBundle.source,
        reason: 'NapCat login info missing UIN'
      };
    }
    return {
      ok: true,
      ...napcatBundle
    };
  } catch (error) {
    const manualBundle = resolveManualCookieBundle();
    if (!manualBundle.cookie) {
      return {
        ok: false,
        source: 'napcat_and_manual',
        reason: 'NapCat credentials failed and manual QZone cookie is missing',
        error
      };
    }
    if (!manualBundle.gtk) {
      return {
        ok: false,
        source: 'manual_cookie',
        reason: 'Manual QZone cookie missing skey',
        error
      };
    }
    if (!manualBundle.uin) {
      return {
        ok: false,
        source: 'manual_cookie',
        reason: 'Manual QZone UIN missing',
        error
      };
    }
    return {
      ok: true,
      ...manualBundle,
      fallbackError: error
    };
  }
}

function buildQzonePublishPayload(content, session = {}, extraFields = {}) {
  return new URLSearchParams({
    syn_tweet_verson: '1',
    paramstr: '1',
    pic_template: '',
    richtype: '',
    richval: '',
    special_url: '',
    subrichtype: '',
    pic_bo: '',
    con: String(content || '').trim(),
    feedversion: '1',
    ver: '1',
    ugc_right: '1',
    to_tweet: '0',
    to_sign: '0',
    hostuin: session.uin,
    code_version: '1',
    format: 'fs',
    qzreferrer: `https://user.qzone.qq.com/${session.uin}/infocenter`,
    ...extraFields
  }).toString();
}

function isTimeoutLikeError(error) {
  const code = String(error?.code || '').trim().toUpperCase();
  const message = String(error?.message || '').toLowerCase();
  return code === 'ECONNABORTED'
    || code === 'ETIMEDOUT'
    || message.includes('timeout')
    || message.includes('socket hang up');
}

async function submitQzonePublish(payload, session = {}, options = {}) {
  const httpClient = createHttpClient(options);
  const timeoutMs = clampTimeoutMs(
    options.publishTimeoutMs || config.QZONE_PUBLISH_TIMEOUT_MS,
    30000
  );
  const url = `https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_publish_v6?g_tk=${session.gtk}`;

  try {
    const response = await httpClient.post(url, payload, {
      timeout: timeoutMs,
      proxy: false,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: session.cookie,
        Origin: 'https://user.qzone.qq.com',
        Referer: `https://user.qzone.qq.com/${session.uin}/infocenter`,
        'User-Agent': String(config.HTTP_USER_AGENT || config.CODEX_USER_AGENT || '').trim() || config.CODEX_USER_AGENT
      }
    });

    const responseText = String(response?.data || '').trim();
    if (isSuccessfulQzoneResponse(responseText)) {
      return {
        success: true,
        source: session.source,
        reason: 'publish success',
        stage: 'publish'
      };
    }

    return {
      success: false,
      source: session.source,
      reason: 'QZone publish rejected',
      details: responseText.slice(0, 300),
      stage: 'publish',
      uncertain: false
    };
  } catch (error) {
    return {
      success: false,
      source: session.source,
      reason: 'QZone publish request failed',
      details: String(error?.message || error || '').slice(0, 300),
      stage: 'publish',
      uncertain: isTimeoutLikeError(error)
    };
  }
}

function parseUploadResponseText(text = '') {
  const output = {};
  const source = String(text || '');
  const regex = /<([^/!][^>]*)>([\s\S]*?)<\/\1>/g;
  let match = regex.exec(source);
  while (match) {
    const key = String(match[1] || '').trim();
    const value = String(match[2] || '').trim();
    if (key && !Object.prototype.hasOwnProperty.call(output, key)) {
      output[key] = value;
    }
    match = regex.exec(source);
  }
  return output;
}

function extractBoValue(url = '') {
  const text = String(url || '').trim();
  if (!text) return '';
  const match = text.match(/(?:^|[?&])bo=([^&#]+)/i);
  if (!match) return '';
  try {
    return decodeURIComponent(match[1]);
  } catch (_) {
    return match[1];
  }
}

function buildQzoneImagePublishFields(uploadData = {}) {
  const albumId = String(uploadData.albumid || '').trim();
  const lloc = String(uploadData.lloc || '').trim();
  const sloc = String(uploadData.sloc || '').trim();
  const type = String(uploadData.type || '').trim();
  const height = String(uploadData.height || '').trim();
  const width = String(uploadData.width || '').trim();
  const preBo = extractBoValue(uploadData.pre || '');
  const urlBo = extractBoValue(uploadData.url || '');

  if (!albumId || !lloc || !sloc || !type || !height || !width || !preBo || !urlBo) {
    return null;
  }

  return {
    richtype: '1',
    subrichtype: '1',
    richval: `,${albumId},${lloc},${sloc},${type},${height},${width},,${height},${width}`,
    pic_bo: `${preBo}    ${urlBo}`
  };
}

async function uploadQzoneImage(imagePath, options = {}) {
  const localPath = path.resolve(String(imagePath || '').trim());
  if (!localPath || !fs.existsSync(localPath)) {
    return {
      success: false,
      source: 'input',
      reason: 'image file missing',
      stage: 'upload',
      uncertain: false
    };
  }

  const session = options.session || await resolveQzoneSession(options);
  if (!session.ok) {
    return {
      success: false,
      source: session.source || 'session',
      reason: session.reason || 'QZone session unavailable',
      stage: 'session',
      uncertain: false
    };
  }

  const httpClient = createHttpClient(options);
  const timeoutMs = clampTimeoutMs(
    options.uploadTimeoutMs || config.QZONE_PUBLISH_TIMEOUT_MS,
    30000
  );
  const fileBuffer = fs.readFileSync(localPath);
  const filename = path.basename(localPath);
  const form = new FormData();
  form.set('uin', session.uin);
  form.set('output_charset', 'utf-8');
  form.set('albumtype', '7');
  form.set('exif_info', '');
  form.set('skey', session.skey);
  form.set('zzpaneluin', session.uin);
  form.set('refer', 'shuoshuo');
  form.set('uploadtype', '1');
  form.set('photoData', 'filename');
  form.set('Filename', filename);
  form.set('filename', new Blob([fileBuffer]), filename);
  form.set('Upload', 'Submit Query');

  try {
    const response = await httpClient.post(
      options.uploadUrl || 'https://shup.photo.qq.com/cgi-bin/upload/cgi_upload_image',
      form,
      {
        timeout: timeoutMs,
        proxy: false,
        headers: {
          Cookie: session.cookie,
          Origin: 'https://ctc.qzs.qq.com',
          Referer: 'https://ctc.qzs.qq.com/qzone/client/photo/swf/SimpleLocalFileUploader/Main.swf?refer=shuoshuo',
          'User-Agent': String(config.HTTP_USER_AGENT || config.CODEX_USER_AGENT || '').trim() || config.CODEX_USER_AGENT
        }
      }
    );
    const responseText = String(response?.data || '');
    const uploadData = parseUploadResponseText(responseText);
    const publishFields = buildQzoneImagePublishFields(uploadData);
    if (!publishFields) {
      return {
        success: false,
        source: session.source,
        reason: 'image upload response missing publish fields',
        details: responseText.slice(0, 300),
        stage: 'upload',
        uncertain: false
      };
    }
    return {
      success: true,
      source: session.source,
      reason: 'image upload success',
      stage: 'upload',
      uploadData,
      publishFields,
      session
    };
  } catch (error) {
    return {
      success: false,
      source: session.source,
      reason: 'image upload failed',
      details: String(error?.message || error || '').slice(0, 300),
      stage: 'upload',
      uncertain: isTimeoutLikeError(error)
    };
  }
}

async function publishQzonePost(content, options = {}) {
  const text = String(content || '').trim();
  if (!text) {
    return {
      success: false,
      source: 'input',
      reason: 'content is required'
    };
  }

  const session = await resolveQzoneSession(options);
  if (!session.ok) {
    return {
      success: false,
      source: session.source || 'session',
      reason: session.reason || 'QZone session unavailable'
    };
  }

  return submitQzonePublish(buildQzonePublishPayload(text, session), session, options);
}

async function publishQzonePostWithImages(input = {}, options = {}) {
  const text = String(input?.content || '').trim();
  const imagePaths = Array.isArray(input?.imagePaths)
    ? input.imagePaths.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  if (!text) {
    return {
      success: false,
      source: 'input',
      reason: 'content is required',
      stage: 'input',
      imageCount: 0,
      uncertain: false
    };
  }
  if (!imagePaths.length) {
    return {
      success: false,
      source: 'input',
      reason: 'image path is required',
      stage: 'input',
      imageCount: 0,
      uncertain: false
    };
  }

  const session = await resolveQzoneSession(options);
  if (!session.ok) {
    return {
      success: false,
      source: session.source || 'session',
      reason: session.reason || 'QZone session unavailable',
      stage: 'session',
      imageCount: 0,
      uncertain: false
    };
  }

  const uploadResult = await uploadQzoneImage(imagePaths[0], {
    ...options,
    session
  });
  if (!uploadResult.success) {
    return {
      success: false,
      source: uploadResult.source,
      reason: uploadResult.reason,
      details: uploadResult.details || '',
      stage: uploadResult.stage || 'upload',
      imageCount: 0,
      uploadedCount: 0,
      uncertain: Boolean(uploadResult.uncertain)
    };
  }

  const publishResult = await submitQzonePublish(
    buildQzonePublishPayload(text, session, uploadResult.publishFields),
    session,
    options
  );
  return {
    ...publishResult,
    imageCount: 1,
    uploadedCount: 1
  };
}

module.exports = {
  buildQzoneImagePublishFields,
  calcGtk,
  getLoginInfo,
  parseCookieString,
  parseUploadResponseText,
  publishQzonePost,
  publishQzonePostWithImages,
  resolveManualCookieBundle,
  resolveQzoneCredentials,
  resolveQzoneSession,
  uploadQzoneImage
};
