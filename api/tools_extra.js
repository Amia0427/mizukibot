/**
 * api/tools_extra.js
 * Extra utility tools for the agent.
 * - Keep return type as string/JSON string for compatibility with existing tool flow.
 */

const axios = require('axios');
const crypto = require('crypto');
const config = require('../config');
const { isUnsafeHttpUrl } = require('../utils/networkSafety');

function createHttpClient() {
  return axios.create({
    timeout: config.TOOL_TIMEOUT_MS || 10000,
    proxy: false,
    headers: { 'User-Agent': 'Mozilla/5.0 MizukiBot/ToolsExtra' }
  });
}
const http = createHttpClient();

function stripCodeFence(text) {
  return String(text || '')
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();
}

function parseSimplePath(pathExpr) {
  // Support: a.b.c, a[0].b, [0].x
  const normalized = String(pathExpr || '')
    .replace(/\[(\d+)\]/g, '.$1')
    .replace(/^\./, '');
  if (!normalized) return [];
  return normalized.split('.').filter(Boolean);
}

function getByPath(obj, pathExpr) {
  const segments = parseSimplePath(pathExpr);
  let cur = obj;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[seg];
  }
  return cur;
}

function toBool(v, fallback = true) {
  if (typeof v === 'boolean') return v;
  const s = String(v || '').trim().toLowerCase();
  if (!s) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

/**
 * Get current time in a timezone.
 */
async function get_current_time(timezone = 'Asia/Shanghai') {
  try {
    const now = new Date();
    const text = now.toLocaleString('zh-CN', {
      timeZone: timezone,
      hour12: false
    });
    const week = now.toLocaleDateString('zh-CN', {
      timeZone: timezone,
      weekday: 'long'
    });

    return `当前时间（${timezone}）：${text}（${week}）`;
  } catch (_) {
    return `时区无效或解析失败：${timezone}`;
  }
}

/**
 * Translate text via LibreTranslate.
 */
async function translate_text(text, to, from = 'auto') {
  const q = String(text || '').trim();
  const target = String(to || '').trim();
  const source = String(from || 'auto').trim();

  if (!q || !target) {
    return '参数不完整：需要 text 和 to。';
  }

  try {
    const resp = await http.post('https://libretranslate.de/translate', {
      q,
      source,
      target,
      format: 'text'
    });

    const translated = resp.data?.translatedText;
    if (!translated) return '翻译服务返回为空。';

    return `原文：${q}\n译文：${translated}\n语言：${source} -> ${target}`;
  } catch (e) {
    return `翻译失败：${e.message}`;
  }
}

/**
 * Read RSS/Atom feed items.
 */
async function read_rss_feed(url, limit = 5) {
  const u = String(url || '').trim();
  const n = Math.max(1, Math.min(10, Number(limit) || 5));
  if (!/^https?:\/\//i.test(u)) {
    return 'RSS 地址格式不正确（需 http/https）。';
  }
  // Reject localhost/private network targets to avoid SSRF style abuse.
  if (isUnsafeHttpUrl(u)) {
    return '出于安全策略，禁止访问本地或内网 RSS 地址。';
  }

  try {
    const resp = await http.get(u);
    const xml = String(resp.data || '');

    const titleMatches = [...xml.matchAll(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title[^>]*>(.*?)<\/title>/gis)];
    const linkMatches = [...xml.matchAll(/<link>(.*?)<\/link>|<link[^>]*href="(.*?)"[^>]*\/?>/gis)];

    const titles = titleMatches.map((m) => (m[1] || m[2] || '').trim()).filter(Boolean);
    const links = linkMatches.map((m) => (m[1] || m[2] || '').trim()).filter(Boolean);

    if (!titles.length) return '未解析到 RSS 条目。';

    const start = titles.length > 1 ? 1 : 0;
    const rows = [];
    for (let i = start; i < Math.min(start + n, titles.length); i++) {
      const link = links[i] || links[i - 1] || '无链接';
      rows.push(`${i - start + 1}. ${titles[i]}\n   ${link}`);
    }

    return `RSS 最新 ${rows.length} 条：\n${rows.join('\n')}`;
  } catch (e) {
    return `读取 RSS 失败：${e.message}`;
  }
}

/**
 * Generate a UUID v4.
 */
async function generate_uuid(version = 'v4') {
  const v = String(version || 'v4').toLowerCase();
  if (v !== 'v4') return '当前仅支持 v4。';

  // crypto.randomUUID is available in modern Node.js.
  const id = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c) =>
        (c ^ (crypto.randomBytes(1)[0] & (15 >> (c / 4)))).toString(16)
      );

  return JSON.stringify({ ok: true, version: 'v4', uuid: id });
}

/**
 * Hash text with selectable algorithm and output encoding.
 */
async function hash_text(text, algorithm = 'sha256', encoding = 'hex') {
  const input = String(text || '');
  if (!input) return '请提供 text。';

  const algo = String(algorithm || 'sha256').toLowerCase();
  const enc = String(encoding || 'hex').toLowerCase();

  const allowAlgo = new Set(['md5', 'sha1', 'sha256', 'sha512']);
  const allowEnc = new Set(['hex', 'base64']);

  if (!allowAlgo.has(algo)) return `不支持算法：${algo}`;
  if (!allowEnc.has(enc)) return `不支持编码：${enc}`;

  const digest = crypto.createHash(algo).update(input, 'utf8').digest(enc);
  return JSON.stringify({ ok: true, algorithm: algo, encoding: enc, digest });
}

/**
 * Extract URLs from text.
 */
async function extract_urls(text, unique = true) {
  const input = String(text || '');
  if (!input.trim()) return '请提供 text。';

  const dedupe = toBool(unique, true);
  const matches = input.match(/https?:\/\/[^\s<>"]+/gi) || [];
  const urls = dedupe ? Array.from(new Set(matches)) : matches;

  return JSON.stringify({
    ok: true,
    total: urls.length,
    urls
  });
}

/**
 * Query a JSON value by simple path.
 */
async function json_query(json_text, path = '') {
  const raw = stripCodeFence(json_text);
  if (!raw) return '请提供 json_text。';

  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return JSON.stringify({ ok: false, error: `JSON 解析失败: ${e.message}` });
  }

  const p = String(path || '').trim();
  if (!p) {
    const summary = {
      type: Array.isArray(obj) ? 'array' : typeof obj,
      keys: obj && typeof obj === 'object' && !Array.isArray(obj) ? Object.keys(obj) : [],
      length: Array.isArray(obj) ? obj.length : undefined
    };
    return JSON.stringify({ ok: true, path: '', value: obj, summary });
  }

  const value = getByPath(obj, p);
  return JSON.stringify({
    ok: value !== undefined,
    path: p,
    value,
    value_type: Array.isArray(value) ? 'array' : typeof value
  });
}

/**
 * Render a template string with variables.
 * Placeholder format: {{name}} or {{user.name}}
 */
async function render_template(template, variables = {}) {
  const tpl = String(template || '');
  if (!tpl) return '请提供 template。';

  let vars = variables;
  if (typeof vars === 'string') {
    const cleaned = stripCodeFence(vars);
    try {
      vars = cleaned ? JSON.parse(cleaned) : {};
    } catch (e) {
      return `variables 不是合法 JSON: ${e.message}`;
    }
  }

  if (!vars || typeof vars !== 'object') {
    return 'variables 必须是对象或 JSON 字符串。';
  }

  const out = tpl.replace(/\{\{\s*([a-zA-Z0-9_.$\[\]]+)\s*\}\}/g, (_, keyPath) => {
    const v = getByPath(vars, keyPath);
    return v === undefined || v === null ? '' : String(v);
  });

  return JSON.stringify({ ok: true, rendered: out });
}

/**
 * Decode JWT without signature verification.
 */
async function jwt_decode(token) {
  const t = String(token || '').trim();
  if (!t) return '请提供 token。';

  const parts = t.split('.');
  if (parts.length < 2) return 'JWT 格式不正确（至少应有 header.payload）。';

  function b64urlDecode(s) {
    const norm = s.replace(/-/g, '+').replace(/_/g, '/');
    const pad = norm.length % 4 === 0 ? '' : '='.repeat(4 - (norm.length % 4));
    return Buffer.from(norm + pad, 'base64').toString('utf8');
  }

  try {
    const headerRaw = b64urlDecode(parts[0]);
    const payloadRaw = b64urlDecode(parts[1]);

    let header = headerRaw;
    let payload = payloadRaw;

    try { header = JSON.parse(headerRaw); } catch (_) {}
    try { payload = JSON.parse(payloadRaw); } catch (_) {}

    const exp = payload && typeof payload === 'object' ? payload.exp : undefined;
    const iat = payload && typeof payload === 'object' ? payload.iat : undefined;

    const expIso = Number.isFinite(exp) ? new Date(exp * 1000).toISOString() : null;
    const iatIso = Number.isFinite(iat) ? new Date(iat * 1000).toISOString() : null;

    return JSON.stringify({
      ok: true,
      header,
      payload,
      signature_present: parts.length >= 3,
      exp_iso: expIso,
      iat_iso: iatIso
    });
  } catch (e) {
    return `JWT 解码失败: ${e.message}`;
  }
}

module.exports = {
  get_current_time,
  translate_text,
  read_rss_feed,
  generate_uuid,
  hash_text,
  extract_urls,
  json_query,
  render_template,
  jwt_decode
};
