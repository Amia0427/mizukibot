const { URLSearchParams } = require('url');
const {
  normalizeArray,
  normalizeObject,
  normalizeText
} = require('./text');

function safeJsonParse(text = '') {
  try {
    return JSON.parse(String(text || ''));
  } catch (_) {
    return null;
  }
}

class OpenVikingClient {
  constructor(options = {}) {
    this.baseUrl = normalizeText(options.baseUrl || 'http://localhost:1933').replace(/\/+$/u, '');
    this.apiKey = normalizeText(options.apiKey);
    this.accountId = normalizeText(options.accountId);
    this.agentId = normalizeText(options.agentId);
    this.timeoutMs = Math.max(100, Number(options.timeoutMs || 15000) || 15000);
    this.fetchImpl = typeof options.fetchImpl === 'function'
      ? options.fetchImpl
      : globalThis.fetch;
  }

  headers(options = {}) {
    const key = normalizeText(options.apiKey || this.apiKey);
    const userId = normalizeText(options.userId);
    const headers = {
      'Content-Type': 'application/json'
    };
    if (key) headers.Authorization = `Bearer ${key}`;
    if (this.accountId) headers['X-OpenViking-Account'] = this.accountId;
    if (userId) headers['X-OpenViking-User'] = userId;
    if (this.agentId) headers['X-OpenViking-Agent'] = this.agentId;
    return headers;
  }

  async request(pathname = '', options = {}) {
    if (typeof this.fetchImpl !== 'function') {
      throw Object.assign(new Error('fetch_unavailable'), { code: 'fetch_unavailable' });
    }
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeout = controller
      ? setTimeout(() => controller.abort(), Math.max(100, Number(options.timeoutMs || this.timeoutMs) || this.timeoutMs))
      : null;
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
        method: options.method || 'GET',
        headers: {
          ...this.headers(options),
          ...(options.headers || {})
        },
        body: options.body === undefined
          ? undefined
          : (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)),
        signal: controller?.signal
      });
      const text = await response.text();
      const json = safeJsonParse(text);
      if (!response.ok) {
        const error = new Error(`OpenViking HTTP ${response.status}`);
        error.code = 'openviking_http_error';
        error.status = response.status;
        error.body = text.slice(0, 500);
        throw error;
      }
      return json === null ? text : json;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async health(options = {}) {
    try {
      await this.request('/health', options);
      return true;
    } catch (_) {
      return false;
    }
  }

  async createUser(userId = '', adminApiKey = '') {
    const accountId = normalizeText(this.accountId);
    const uid = normalizeText(userId);
    if (!accountId || !uid || !normalizeText(adminApiKey)) return { ok: false, error: 'missing_admin_identity' };
    try {
      const body = await this.request(`/api/v1/admin/accounts/${encodeURIComponent(accountId)}/users`, {
        method: 'POST',
        apiKey: adminApiKey,
        body: { user_id: uid, role: 'user' }
      });
      return { ok: true, result: body?.result || body };
    } catch (error) {
      return { ok: false, error: error?.message || String(error || '') };
    }
  }

  async addMessage(sessionId = '', payload = {}, options = {}) {
    const id = normalizeText(sessionId);
    if (!id) return false;
    await this.request(`/api/v1/sessions/${encodeURIComponent(id)}/messages`, {
      method: 'POST',
      ...options,
      body: normalizeObject(payload)
    });
    return true;
  }

  async commitSession(sessionId = '', options = {}) {
    const id = normalizeText(sessionId);
    if (!id) return null;
    const body = await this.request(`/api/v1/sessions/${encodeURIComponent(id)}/commit`, {
      method: 'POST',
      ...options,
      body: {}
    });
    return body?.result || body || null;
  }

  async resolveUserSpace(options = {}) {
    try {
      const body = await this.request('/api/v1/system/status', options);
      return normalizeText(body?.result?.user, 'default');
    } catch (_) {
      return 'default';
    }
  }

  async find(input = {}, options = {}) {
    const query = normalizeText(input.query);
    if (!query) return [];
    const body = {
      query,
      limit: Math.max(1, Math.min(50, Number(input.limit || 8) || 8)),
      score_threshold: Number.isFinite(Number(input.scoreThreshold)) ? Number(input.scoreThreshold) : 0
    };
    if (input.targetUri) body.target_uri = input.targetUri;
    if (input.sessionId) body.session_id = input.sessionId;
    const result = await this.request('/api/v1/search/find', {
      method: 'POST',
      ...options,
      body
    });
    const payload = result?.result !== undefined ? result.result : result;
    if (Array.isArray(payload)) return payload;
    return normalizeArray(payload?.memories).concat(normalizeArray(payload?.skills));
  }

  async readContent(uri = '', options = {}) {
    const target = normalizeText(uri);
    if (!target) return '';
    const params = new URLSearchParams({ uri: target });
    const result = await this.request(`/api/v1/content/read?${params.toString()}`, options);
    return normalizeText(result?.result || result);
  }
}

function createOpenVikingClient(config = {}, options = {}) {
  return new OpenVikingClient({
    baseUrl: options.baseUrl || config.OPENVIKING_BASE_URL,
    apiKey: options.apiKey || config.OPENVIKING_API_KEY || config.OPENVIKING_ADMIN_API_KEY,
    accountId: options.accountId || config.OPENVIKING_ACCOUNT_ID,
    agentId: options.agentId || config.OPENVIKING_AGENT_ID,
    timeoutMs: options.timeoutMs || config.OPENVIKING_RECALL_TIMEOUT_MS,
    fetchImpl: options.fetchImpl
  });
}

module.exports = {
  OpenVikingClient,
  createOpenVikingClient,
  safeJsonParse
};
