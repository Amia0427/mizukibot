const axios = require('axios');
const config = require('../../config');
const { buildForwardPrompt } = require('./commandBackend');
const { parseGatewayJsonResponse, parseGatewaySSEStream } = require('./gatewayResponseParser');
const { detectSensitiveOutput } = require('../../utils/promptSecurity');

function ensureResponsesUrl(url = '') {
  const normalized = String(url || '').replace(/\/+$/, '');
  if (/\/v1\/responses$/i.test(normalized)) return normalized;
  return `${normalized}/v1/responses`;
}

function resolveGatewayConfig() {
  return {
    baseUrl: String(config.SUBAGENT_GATEWAY_URL || '').trim(),
    authToken: String(config.SUBAGENT_GATEWAY_AUTH_TOKEN || '').trim(),
    agentId: String(config.SUBAGENT_GATEWAY_AGENT_ID || 'main').trim() || 'main',
    timeoutMs: Math.max(10000, Number(config.SUBAGENT_GATEWAY_TIMEOUT_MS) || 180000),
    stream: config.SUBAGENT_GATEWAY_STREAM !== false,
    useResponsesApi: config.SUBAGENT_GATEWAY_USE_RESPONSES_API !== false
  };
}

function buildGatewayHeaders(sessionId = '', gatewayConfig = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'x-openclaw-agent-id': String(gatewayConfig.agentId || 'main').trim() || 'main',
    'x-openclaw-session-key': String(sessionId || '').trim()
  };
  const authToken = String(gatewayConfig.authToken || '').trim();
  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }
  return headers;
}

function buildGatewayBody({ question, customPrompt = null, imageUrl = null, options = {}, sessionId = '', gatewayConfig = {} } = {}) {
  const routePrompt = String(options?.subagentRoutePrompt || options?.routePrompt || '').trim() || null;
  const forwarded = buildForwardPrompt(question, customPrompt, imageUrl, routePrompt);
  const agentId = String(gatewayConfig.agentId || 'main').trim() || 'main';
  return {
    model: `openclaw:${agentId}`,
    input: forwarded,
    user: String(sessionId || '').trim(),
    stream: gatewayConfig.stream !== false
  };
}

async function postGatewayJson(url, body, headers, timeoutMs) {
  return axios.post(url, body, {
    headers,
    timeout: timeoutMs,
    responseType: 'json',
    proxy: false
  });
}

function normalizeGatewayError(error) {
  const status = Number(error?.response?.status);
  if (status === 401) return new Error('gateway unauthorized (401)');
  if (status === 404) return new Error('gateway endpoint or agent not found (404)');
  if (status >= 500) return new Error(`gateway server error (${status})`);
  if (error?.code === 'ERR_CANCELED') {
    const err = new Error('gateway cancelled');
    err.code = 'SUBAGENT_CANCELLED';
    return err;
  }
  return error instanceof Error ? error : new Error(String(error || 'gateway request failed'));
}

function createGatewayBridgeCall({ question, sessionId, customPrompt = null, imageUrl = null, options = {} } = {}) {
  const gatewayConfig = resolveGatewayConfig();
  if (!gatewayConfig.useResponsesApi) {
    throw new Error('SUBAGENT_GATEWAY_USE_RESPONSES_API must be true');
  }
  if (!gatewayConfig.baseUrl) {
    throw new Error('SUBAGENT_GATEWAY_URL is empty');
  }
  if (!sessionId) {
    throw new Error('gateway sessionId is empty');
  }

  const url = ensureResponsesUrl(gatewayConfig.baseUrl);
  const headers = buildGatewayHeaders(sessionId, gatewayConfig);
  const body = buildGatewayBody({
    question,
    customPrompt,
    imageUrl,
    options,
    sessionId,
    gatewayConfig
  });

  let cancelled = false;
  let abortController = null;

  const promise = (async () => {
    if (gatewayConfig.stream) {
      const axios = require('axios');
      abortController = new AbortController();
      const resp = await axios.post(
        url,
        body,
        {
          headers,
          timeout: gatewayConfig.timeoutMs,
          proxy: false,
          responseType: 'stream',
          signal: abortController.signal
        }
      );

      const stream = resp?.data;
      if (!stream || typeof stream.on !== 'function') {
        throw new Error('gateway streaming response is not readable');
      }

      const raw = await new Promise((resolve, reject) => {
        let settled = false;
        let buffer = '';
        const done = (err = null) => {
          if (settled) return;
          settled = true;
          if (err) return reject(err);
          resolve(buffer);
        };

        stream.on('data', (chunk) => {
          buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
        });
        stream.once('end', () => done());
        stream.once('close', () => done());
        stream.once('error', (error) => done(error));
      });

      if (cancelled) {
        const err = new Error('gateway cancelled');
        err.code = 'SUBAGENT_CANCELLED';
        throw err;
      }

      const reply = parseGatewaySSEStream(raw);
      if (!reply) throw new Error('gateway returned empty reply');
      if (detectSensitiveOutput(reply).blocked) throw new Error('gateway returned sensitive output');
      return reply;
    }

      const response = await postGatewayJson(url, body, headers, gatewayConfig.timeoutMs);
      if (cancelled) {
        const err = new Error('gateway cancelled');
        err.code = 'SUBAGENT_CANCELLED';
        throw err;
      }
      const reply = parseGatewayJsonResponse(response?.data || {});
      if (!reply) throw new Error('gateway returned empty reply');
      if (detectSensitiveOutput(reply).blocked) throw new Error('gateway returned sensitive output');
      return reply;
    })().catch((error) => {
      throw normalizeGatewayError(error);
    });

  return {
    promise,
    cancel(reason = 'cancelled') {
      cancelled = true;
      if (abortController) {
        try { abortController.abort(); } catch (_) {}
      }
      return reason;
    }
  };
}

module.exports = {
  buildGatewayBody,
  buildGatewayHeaders,
  createGatewayBridgeCall,
  ensureResponsesUrl,
  normalizeGatewayError,
  parseGatewayJsonResponse,
  parseGatewaySSEStream,
  resolveGatewayConfig
};
