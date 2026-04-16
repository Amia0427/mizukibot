const axios = require('axios');
const config = require('../config');

function normalizeText(value = '') {
  return String(value || '').trim();
}

function getBridgeBaseUrl() {
  return normalizeText(config.LOCAL_COMMAND_BRIDGE_URL).replace(/\/+$/, '');
}

function buildHeaders() {
  const token = normalizeText(config.LOCAL_COMMAND_BRIDGE_TOKEN);
  const headers = {
    'Content-Type': 'application/json'
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function isLocalCommandBridgeEnabled() {
  return Boolean(config.LOCAL_COMMAND_BRIDGE_ENABLED) && Boolean(getBridgeBaseUrl());
}

async function runLocalCommandViaBridge(payload = {}, timeoutMs = 30000) {
  if (!isLocalCommandBridgeEnabled()) {
    throw new Error('local command bridge disabled');
  }
  const baseUrl = getBridgeBaseUrl();
  const response = await axios.post(
    `${baseUrl}/run`,
    payload,
    {
      timeout: Math.max(1000, Number(timeoutMs) || 30000),
      headers: buildHeaders(),
      proxy: false
    }
  );
  return response?.data || {};
}

async function discoverMcpViaBridge(payload = {}, timeoutMs = 60000) {
  if (!isLocalCommandBridgeEnabled()) {
    throw new Error('local command bridge disabled');
  }
  const baseUrl = getBridgeBaseUrl();
  const response = await axios.post(
    `${baseUrl}/mcp/discover`,
    payload,
    {
      timeout: Math.max(2000, Number(timeoutMs) || 60000),
      headers: buildHeaders(),
      proxy: false
    }
  );
  return response?.data || {};
}

async function callMcpViaBridge(payload = {}, timeoutMs = 120000) {
  if (!isLocalCommandBridgeEnabled()) {
    throw new Error('local command bridge disabled');
  }
  const baseUrl = getBridgeBaseUrl();
  const response = await axios.post(
    `${baseUrl}/mcp/call`,
    payload,
    {
      timeout: Math.max(2000, Number(timeoutMs) || 120000),
      headers: buildHeaders(),
      proxy: false
    }
  );
  return response?.data || {};
}

module.exports = {
  callMcpViaBridge,
  discoverMcpViaBridge,
  getBridgeBaseUrl,
  isLocalCommandBridgeEnabled,
  runLocalCommandViaBridge
};
