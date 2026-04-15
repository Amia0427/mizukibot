
const express = require('express');

const config = require('../config');
const { favorites, memories } = require('../utils/memory');
const { getLatestReasoning } = require('../api/ai');
const { listTasks, loadTask } = require('../utils/agentRuntime');
const { listRecentModelCalls } = require('../utils/modelCallTracker');
const { setEnvPairs, maskSecret } = require('../utils/envFile');
const {
  listMemoryItems,
  getGovernanceStats,
  previewGovernance,
  applyGovernance,
  listConflictGroups,
  resolveConflictGroup,
  rebuildMemoryArtifacts,
  runMemoryMigration,
  listSnapshots,
  rollbackSnapshot,
  updateMemoryItem
} = require('../utils/memoryGovernance');

const MODEL_PRESETS = Array.isArray(config.MODEL_OPTIONS) && config.MODEL_OPTIONS.length
  ? config.MODEL_OPTIONS
  : ['gpt-5.4', 'gpt-5.1-codex-mini', 'gpt-4.1', 'gpt-4o-mini'];

const IMAGE_MODEL_PRESETS = Array.isArray(config.IMAGE_MODEL_OPTIONS) && config.IMAGE_MODEL_OPTIONS.length
  ? config.IMAGE_MODEL_OPTIONS
  : ['[official]gemini-3.1-flash-image-preview', 'gpt-image-1'];

function getClientIp(req) {
  const socketIp = String(req.socket?.remoteAddress || '').trim().replace(/^::ffff:/, '');
  if (socketIp) return socketIp;
  const raw = String(req.headers['x-forwarded-for'] || '');
  return raw.split(',')[0].trim().replace(/^::ffff:/, '');
}

function isLocalIp(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost' || ip === '';
}

function isTrustedLocalOrigin(req, host, port) {
  const refs = [req.headers.origin, req.headers.referer].filter(Boolean);
  for (const raw of refs) {
    try {
      const u = new URL(String(raw));
      const h = String(u.hostname || '').trim();
      const p = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
      if (isLocalIp(h) && p === Number(port)) return true;
      if (isLocalIp(h) && (host === '127.0.0.1' || host === 'localhost' || host === '::1')) return true;
    } catch (_) {}
  }
  return false;
}

function checkWebAuth(req, options = {}) {
  const token = String(config.WEB_TOKEN || '').trim();
  if (!token) {
    if (!isLocalIp(getClientIp(req))) return false;
    const method = String(req.method || 'GET').toUpperCase();
    // Require same-origin browser context for local unsafe actions.
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
    return isTrustedLocalOrigin(req, options.host || '127.0.0.1', options.port || 3005);
  }

  const xWebToken = String(req.headers['x-web-token'] || '').trim();
  if (xWebToken && xWebToken === token) return true;

  const authHeader = String(req.headers.authorization || '').trim();
  if (/^Bearer\s+/i.test(authHeader)) {
    const bearerToken = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (bearerToken === token) return true;
  }

  return false;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function resolveSecretInput(submitted, current) {
  const next = String(submitted || '').trim();
  return next || String(current || '').trim();
}

function persistSettings(next) {
  setEnvPairs({
    API_KEY: next.api_key,
    API_BASE_URL: next.api_base_url,
    AI_MODEL: next.ai_model,
    AI_FALLBACK_ENABLED: String(next.ai_fallback_enabled),
    AI_FALLBACK_MODEL: next.ai_fallback_model,
    AI_FALLBACK_API_BASE_URL: next.ai_fallback_api_base_url,
    AI_FALLBACK_API_KEY: next.ai_fallback_api_key,
    AI_FALLBACK_FAILURE_THRESHOLD: String(next.ai_fallback_failure_threshold),
    AI_FALLBACK_COOLDOWN_MS: String(next.ai_fallback_cooldown_ms),
    AI_ROUTER_BASE_URL: next.ai_router_base_url,
    AI_ROUTER_API_KEY: next.ai_router_api_key,
    AI_ROUTER_MODEL: next.ai_router_model,
    MEMORY_MODEL: next.memory_model,
    MEMORY_API_BASE_URL: next.memory_api_base_url,
    MEMORY_API_KEY: next.memory_api_key,
    IMAGE_MODEL: next.image_model,
    IMAGE_API_BASE_URL: next.image_api_base_url,
    IMAGE_API_KEY: next.image_api_key,
    AI_TEMPERATURE: String(next.ai_temperature),
    AI_TOP_P: String(next.ai_top_p),
    AI_MAX_TOKENS: String(next.ai_max_tokens),
    AI_RETRIES: String(next.ai_retries),
    AI_STREAM_ENABLED: String(next.ai_stream_enabled),
    AI_STREAM_CHUNK_MS: String(next.ai_stream_chunk_ms),
    LLM_HUMANIZER_ENABLED: String(next.llm_humanizer_enabled)
  });

  process.env.API_KEY = next.api_key;
  process.env.API_BASE_URL = next.api_base_url;
  process.env.AI_MODEL = next.ai_model;
  process.env.AI_FALLBACK_ENABLED = String(next.ai_fallback_enabled);
  process.env.AI_FALLBACK_MODEL = next.ai_fallback_model;
  process.env.AI_FALLBACK_API_BASE_URL = next.ai_fallback_api_base_url;
  process.env.AI_FALLBACK_API_KEY = next.ai_fallback_api_key;
  process.env.AI_FALLBACK_FAILURE_THRESHOLD = String(next.ai_fallback_failure_threshold);
  process.env.AI_FALLBACK_COOLDOWN_MS = String(next.ai_fallback_cooldown_ms);
  process.env.AI_ROUTER_BASE_URL = next.ai_router_base_url;
  process.env.AI_ROUTER_API_KEY = next.ai_router_api_key;
  process.env.AI_ROUTER_MODEL = next.ai_router_model;
  process.env.MEMORY_MODEL = next.memory_model;
  process.env.MEMORY_API_BASE_URL = next.memory_api_base_url;
  process.env.MEMORY_API_KEY = next.memory_api_key;
  process.env.IMAGE_MODEL = next.image_model;
  process.env.IMAGE_API_BASE_URL = next.image_api_base_url;
  process.env.IMAGE_API_KEY = next.image_api_key;
  process.env.AI_TEMPERATURE = String(next.ai_temperature);
  process.env.AI_TOP_P = String(next.ai_top_p);
  process.env.AI_MAX_TOKENS = String(next.ai_max_tokens);
  process.env.AI_RETRIES = String(next.ai_retries);
  process.env.AI_STREAM_ENABLED = String(next.ai_stream_enabled);
  process.env.AI_STREAM_CHUNK_MS = String(next.ai_stream_chunk_ms);
  process.env.LLM_HUMANIZER_ENABLED = String(next.llm_humanizer_enabled);

  config.API_KEY = next.api_key;
  config.UNIFIED_API_KEY = next.api_key;
  config.API_BASE_URL = next.api_base_url;
  config.AI_MODEL = next.ai_model;
  config.AI_FALLBACK_ENABLED = next.ai_fallback_enabled;
  config.AI_FALLBACK_MODEL = next.ai_fallback_model;
  config.AI_FALLBACK_API_BASE_URL = next.ai_fallback_api_base_url;
  config.AI_FALLBACK_API_KEY = next.ai_fallback_api_key;
  config.AI_FALLBACK_FAILURE_THRESHOLD = next.ai_fallback_failure_threshold;
  config.AI_FALLBACK_COOLDOWN_MS = next.ai_fallback_cooldown_ms;
  config.AI_ROUTER_BASE_URL = next.ai_router_base_url;
  config.AI_ROUTER_API_KEY = next.ai_router_api_key;
  config.AI_ROUTER_MODEL = next.ai_router_model;
  config.MEMORY_MODEL = next.memory_model;
  config.MEMORY_API_BASE_URL = next.memory_api_base_url;
  config.MEMORY_API_KEY = next.memory_api_key;
  config.IMAGE_MODEL = next.image_model;
  config.IMAGE_API_BASE_URL = next.image_api_base_url;
  config.IMAGE_API_KEY = next.image_api_key;
  config.AI_TEMPERATURE = next.ai_temperature;
  config.AI_TOP_P = next.ai_top_p;
  config.AI_MAX_TOKENS = next.ai_max_tokens;
  config.AI_RETRIES = next.ai_retries;
  config.AI_STREAM_ENABLED = next.ai_stream_enabled;
  config.AI_STREAM_CHUNK_MS = next.ai_stream_chunk_ms;
  config.LLM_HUMANIZER_ENABLED = next.llm_humanizer_enabled;
}

function getCurrentSettings() {
  return {
    has_api_key: Boolean(String(config.API_KEY || '').trim()),
    api_key_masked: maskSecret(config.API_KEY || ''),
    has_ai_fallback_api_key: Boolean(String(config.AI_FALLBACK_API_KEY || '').trim()),
    ai_fallback_api_key_masked: maskSecret(config.AI_FALLBACK_API_KEY || ''),
    has_ai_router_api_key: Boolean(String(config.AI_ROUTER_API_KEY || '').trim()),
    ai_router_api_key_masked: maskSecret(config.AI_ROUTER_API_KEY || ''),
    has_memory_api_key: Boolean(String(config.MEMORY_API_KEY || '').trim()),
    memory_api_key_masked: maskSecret(config.MEMORY_API_KEY || ''),
    has_image_api_key: Boolean(String(config.IMAGE_API_KEY || '').trim()),
    image_api_key_masked: maskSecret(config.IMAGE_API_KEY || ''),
    api_base_url: String(config.API_BASE_URL || ''),
    ai_model: String(config.AI_MODEL || ''),
    ai_fallback_enabled: Boolean(config.AI_FALLBACK_ENABLED),
    ai_fallback_model: String(config.AI_FALLBACK_MODEL || ''),
    ai_fallback_api_base_url: String(config.AI_FALLBACK_API_BASE_URL || ''),
    ai_fallback_failure_threshold: Number(config.AI_FALLBACK_FAILURE_THRESHOLD ?? 3),
    ai_fallback_cooldown_ms: Number(config.AI_FALLBACK_COOLDOWN_MS ?? 600000),
    ai_router_base_url: String(config.AI_ROUTER_BASE_URL || ''),
    ai_router_model: String(config.AI_ROUTER_MODEL || ''),
    memory_model: String(config.MEMORY_MODEL || ''),
    memory_api_base_url: String(config.MEMORY_API_BASE_URL || ''),
    image_model: String(config.IMAGE_MODEL || ''),
    image_api_base_url: String(config.IMAGE_API_BASE_URL || ''),
    ai_temperature: Number(config.AI_TEMPERATURE ?? 0.6),
    ai_top_p: Number(config.AI_TOP_P ?? 0.92),
    ai_max_tokens: Number(config.AI_MAX_TOKENS ?? 3500),
    ai_retries: Number(config.AI_RETRIES ?? 1),
    ai_stream_enabled: Boolean(config.AI_STREAM_ENABLED),
    ai_stream_chunk_ms: Number(config.AI_STREAM_CHUNK_MS ?? 900),
    llm_humanizer_enabled: Boolean(config.LLM_HUMANIZER_ENABLED),
    presets: { text_models: MODEL_PRESETS, image_models: IMAGE_MODEL_PRESETS }
  };
}

function parseGovernanceOptions(raw = {}) {
  const modeRaw = String(raw.mode || 'balanced').trim().toLowerCase();
  const actionRaw = String(raw.action || 'archive').trim().toLowerCase();
  return {
    userId: String(raw.user_id || raw.userId || '').trim(),
    mode: modeRaw === 'strict' ? 'strict' : 'balanced',
    action: actionRaw === 'delete' ? 'delete' : 'archive',
    minConfidence: Number(raw.min_confidence ?? raw.minConfidence ?? 0.72),
    topicTtlDays: Number(raw.topic_ttl_days ?? raw.topicTtlDays ?? 21),
    dedupeThreshold: Number(raw.dedupe_threshold ?? raw.dedupeThreshold ?? 0.9)
  };
}

function startServer() {
  const app = express();
  const port = config.WEB_PORT || 3005;
  const host = config.WEB_BIND_HOST || '127.0.0.1';

  app.disable('x-powered-by');
  app.use(express.json({ limit: '300kb' }));

  app.use((req, res, next) => {
    if (checkWebAuth(req, { host, port })) return next();
    return res.status(401).json({ error: 'Unauthorized' });
  });

  app.get('/api/bot-thinking', (req, res) => {
    res.json({ reasoning: getLatestReasoning() || 'Agent is thinking...' });
  });

  app.get('/api/tasks', (req, res) => {
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
    const tasks = listTasks(limit).map((task) => ({
      id: task.id,
      kind: task.kind,
      status: task.status,
      stage: task.stage,
      user_id: task.user_id,
      goal: task.goal,
      success_criteria: task.success_criteria,
      checkpoint: task.checkpoint,
      updated_at: task.updated_at,
      completed_at: task.completed_at,
      failed_at: task.failed_at
    }));
    return res.json({ ok: true, tasks });
  });

  app.get('/api/tasks/:id', (req, res) => {
    const task = loadTask(req.params.id);
    if (!task) return res.status(404).json({ ok: false, error: 'Task not found' });
    return res.json({ ok: true, task });
  });

  app.get('/api/model-calls', (req, res) => {
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 30));
    return res.json({ ok: true, calls: listRecentModelCalls(limit) });
  });

  app.get('/api/settings', (req, res) => {
    return res.json({ ok: true, settings: getCurrentSettings() });
  });

  app.post('/api/settings', (req, res) => {
    try {
      const body = req.body || {};

      const next = {
        api_key: resolveSecretInput(body.api_key, config.API_KEY),
        api_base_url: String(body.api_base_url || '').trim(),
        ai_model: String(body.ai_model || '').trim(),
        ai_fallback_enabled: Boolean(body.ai_fallback_enabled),
        ai_fallback_model: String(body.ai_fallback_model || '').trim(),
        ai_fallback_api_base_url: String(body.ai_fallback_api_base_url || '').trim(),
        ai_fallback_api_key: resolveSecretInput(body.ai_fallback_api_key, config.AI_FALLBACK_API_KEY),
        ai_fallback_failure_threshold: Number(body.ai_fallback_failure_threshold),
        ai_fallback_cooldown_ms: Number(body.ai_fallback_cooldown_ms),
        ai_router_base_url: String(body.ai_router_base_url || '').trim(),
        ai_router_api_key: resolveSecretInput(body.ai_router_api_key, config.AI_ROUTER_API_KEY),
        ai_router_model: String(body.ai_router_model || '').trim(),
        memory_model: String(body.memory_model || '').trim(),
        memory_api_base_url: String(body.memory_api_base_url || '').trim(),
        memory_api_key: resolveSecretInput(body.memory_api_key, config.MEMORY_API_KEY),
        image_model: String(body.image_model || '').trim(),
        image_api_base_url: String(body.image_api_base_url || '').trim(),
        image_api_key: resolveSecretInput(body.image_api_key, config.IMAGE_API_KEY),
        ai_temperature: Number(body.ai_temperature),
        ai_top_p: Number(body.ai_top_p),
        ai_max_tokens: Number(body.ai_max_tokens),
        ai_retries: Number(body.ai_retries),
        ai_stream_enabled: Boolean(body.ai_stream_enabled),
        ai_stream_chunk_ms: Number(body.ai_stream_chunk_ms),
        llm_humanizer_enabled: Boolean(body.llm_humanizer_enabled)
      };

      if (!next.api_key) return res.status(400).json({ ok: false, error: 'API_KEY cannot be empty' });
      if (!/^https?:\/\//i.test(next.api_base_url)) return res.status(400).json({ ok: false, error: 'API_BASE_URL must start with http/https' });
      if (!next.ai_model) return res.status(400).json({ ok: false, error: 'AI_MODEL cannot be empty' });
      if (next.ai_fallback_api_base_url && !/^https?:\/\//i.test(next.ai_fallback_api_base_url)) return res.status(400).json({ ok: false, error: 'AI_FALLBACK_API_BASE_URL must start with http/https' });
      if (next.ai_fallback_enabled && !next.ai_fallback_model) return res.status(400).json({ ok: false, error: 'AI_FALLBACK_MODEL cannot be empty when fallback is enabled' });
      if (!Number.isFinite(next.ai_fallback_failure_threshold) || next.ai_fallback_failure_threshold < 1 || next.ai_fallback_failure_threshold > 100) return res.status(400).json({ ok: false, error: 'AI_FALLBACK_FAILURE_THRESHOLD must be in 1~100' });
      if (!Number.isFinite(next.ai_fallback_cooldown_ms) || next.ai_fallback_cooldown_ms < 0 || next.ai_fallback_cooldown_ms > 31536000000) return res.status(400).json({ ok: false, error: 'AI_FALLBACK_COOLDOWN_MS must be in 0~31536000000' });
      if (next.ai_router_base_url && !/^https?:\/\//i.test(next.ai_router_base_url)) return res.status(400).json({ ok: false, error: 'AI_ROUTER_BASE_URL must start with http/https' });
      if (!next.memory_model) return res.status(400).json({ ok: false, error: 'MEMORY_MODEL cannot be empty' });
      if (!next.image_model) return res.status(400).json({ ok: false, error: 'IMAGE_MODEL cannot be empty' });
      if (next.memory_api_base_url && !/^https?:\/\//i.test(next.memory_api_base_url)) return res.status(400).json({ ok: false, error: 'MEMORY_API_BASE_URL must start with http/https' });
      if (next.image_api_base_url && !/^https?:\/\//i.test(next.image_api_base_url)) return res.status(400).json({ ok: false, error: 'IMAGE_API_BASE_URL must start with http/https' });
      if (!Number.isFinite(next.ai_temperature) || next.ai_temperature < 0 || next.ai_temperature > 2) return res.status(400).json({ ok: false, error: 'AI_TEMPERATURE must be in 0~2' });
      if (!Number.isFinite(next.ai_top_p) || next.ai_top_p < 0 || next.ai_top_p > 1) return res.status(400).json({ ok: false, error: 'AI_TOP_P must be in 0~1' });
      if (!Number.isFinite(next.ai_max_tokens) || next.ai_max_tokens < 64) return res.status(400).json({ ok: false, error: 'AI_MAX_TOKENS must be >= 64' });
      if (!Number.isFinite(next.ai_retries) || next.ai_retries < 0 || next.ai_retries > 10) return res.status(400).json({ ok: false, error: 'AI_RETRIES must be in 0~10' });
      if (!Number.isFinite(next.ai_stream_chunk_ms) || next.ai_stream_chunk_ms < 200 || next.ai_stream_chunk_ms > 5000) return res.status(400).json({ ok: false, error: 'AI_STREAM_CHUNK_MS must be in 200~5000 ms' });

      next.ai_max_tokens = Math.floor(next.ai_max_tokens);
      next.ai_retries = Math.floor(next.ai_retries);
      next.ai_stream_chunk_ms = Math.floor(next.ai_stream_chunk_ms);
      next.ai_fallback_failure_threshold = Math.floor(next.ai_fallback_failure_threshold);
      next.ai_fallback_cooldown_ms = Math.floor(next.ai_fallback_cooldown_ms);
      persistSettings(next);

      return res.json({ ok: true, message: 'Settings saved and applied', settings: getCurrentSettings() });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message || 'Save failed' });
    }
  });

  app.get('/api/memory-governance/stats', (req, res) => {
    try {
      const userId = String(req.query.user_id || '').trim();
      const stats = getGovernanceStats(userId);
      return res.json({ ok: true, stats });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message || 'Failed to load memory stats' });
    }
  });

  app.get('/api/memory-governance/items', (req, res) => {
    try {
      const items = listMemoryItems({
        userId: String(req.query.user_id || '').trim(),
        type: String(req.query.type || '').trim(),
        status: String(req.query.status || '').trim(),
        limit: Number(req.query.limit || 200)
      });
      return res.json({ ok: true, items });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message || 'Failed to load memory items' });
    }
  });

  app.get('/api/memory-governance/conflicts', (req, res) => {
    try {
      const groups = listConflictGroups({
        userId: String(req.query.user_id || '').trim()
      });
      return res.json({ ok: true, groups });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message || 'Failed to load conflict groups' });
    }
  });

  app.post('/api/memory-governance/preview', (req, res) => {
    try {
      const options = parseGovernanceOptions(req.body || {});
      const result = previewGovernance(options);
      return res.json({ ok: true, ...result });
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message || 'Preview failed' });
    }
  });

  app.post('/api/memory-governance/apply', (req, res) => {
    try {
      const options = parseGovernanceOptions(req.body || {});
      const result = applyGovernance(options);
      return res.json({ ok: true, ...result });
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message || 'Apply failed' });
    }
  });

  app.post('/api/memory-governance/conflicts/resolve', (req, res) => {
    try {
      const conflictKey = String(req.body?.conflict_key || req.body?.conflictKey || '').trim();
      const winnerId = String(req.body?.winner_id || req.body?.winnerId || '').trim();
      const result = resolveConflictGroup(conflictKey, winnerId);
      return res.json({ ok: true, ...result });
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message || 'Resolve conflict failed' });
    }
  });

  app.post('/api/memory-governance/rebuild', (req, res) => {
    try {
      const result = rebuildMemoryArtifacts();
      return res.json({ ok: true, ...result });
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message || 'Rebuild failed' });
    }
  });

  app.post('/api/memory-governance/migrate', (req, res) => {
    try {
      const result = runMemoryMigration();
      return res.json({ ok: true, ...result });
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message || 'Migration failed' });
    }
  });

  app.get('/api/memory-governance/snapshots', (req, res) => {
    try {
      const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 30));
      const snapshots = listSnapshots(limit);
      return res.json({ ok: true, snapshots });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message || 'Failed to load snapshots' });
    }
  });

  app.post('/api/memory-governance/rollback', (req, res) => {
    try {
      const snapshot = String(req.body?.snapshot || '').trim();
      if (!snapshot) return res.status(400).json({ ok: false, error: 'snapshot is required' });
      const result = rollbackSnapshot(snapshot);
      return res.json({ ok: true, ...result });
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message || 'Rollback failed' });
    }
  });

  app.post('/api/memory-governance/item/update', (req, res) => {
    try {
      const id = String(req.body?.id || '').trim();
      if (!id) return res.status(400).json({ ok: false, error: 'id is required' });

      const patch = {};
      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'text')) patch.text = req.body.text;
      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'type')) patch.type = req.body.type;
      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'confidence')) patch.confidence = req.body.confidence;
      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'importance')) patch.importance = req.body.importance;
      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'status')) patch.status = req.body.status;

      const result = updateMemoryItem(id, patch);
      return res.json({ ok: true, ...result });
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message || 'Update failed' });
    }
  });

  app.get('/', (req, res) => {
    const favorHtml = Object.entries(favorites)
      .map(([id, d]) => {
        const safePoints = Number.isFinite(Number(d?.points)) ? Number(d.points) : 0;
        const relationship = String(d?.relationship || d?.level || '陌生人').trim() || '陌生人';
        const attitude = String(d?.attitude || '').trim() || '-';
        const lastReason = String(d?.last_affinity_reason || '').trim() || '-';
        const lastUpdated = Number(d?.last_affinity_update_at || 0) > 0
          ? new Date(Number(d.last_affinity_update_at)).toLocaleString()
          : '-';
        return `<tr><td>${escapeHtml(id)}</td><td>${escapeHtml(d?.level || '')}</td><td>${safePoints}</td><td>${escapeHtml(relationship)}</td><td>${escapeHtml(attitude)}</td><td>${escapeHtml(lastReason)}</td><td>${escapeHtml(lastUpdated)}</td></tr>`;
      })
      .join('');

    const memoryHtml = Object.entries(memories)
      .map(([id, d]) => {
        const factHtml = (d.facts || []).map((f) => `<li>${escapeHtml(f)}</li>`).join('');
        return `<div><strong>${escapeHtml(id)}:</strong><ul>${factHtml}</ul></div>`;
      })
      .join('');

    const modelOptions = MODEL_PRESETS.map((m) => `<option value="${escapeHtml(m)}"></option>`).join('');
    const imageModelOptions = IMAGE_MODEL_PRESETS.map((m) => `<option value="${escapeHtml(m)}"></option>`).join('');

    res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>MizukiBot Console</title>
  <style>
    :root{--bg:#fff6f9;--card:#fff;--ink:#3f2a35;--accent:#ff5c93;--line:#ffd0e0}
    body{background:linear-gradient(140deg,#fff6f9,#fffdf7);font-family:"Microsoft YaHei",sans-serif;color:var(--ink);padding:20px;max-width:1200px;margin:0 auto}
    .card{background:var(--card);border-radius:16px;padding:18px 20px;box-shadow:0 10px 30px rgba(255,92,147,.12);margin-bottom:16px;border:1px solid var(--line)}
    h1{margin:0 0 14px;color:#ca2f6a}
    h3{margin:0 0 10px;color:#c13a6e}
    .hint{font-size:12px;color:#9b6a7f}
    .muted{font-size:12px;color:#8d6878}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
    .field{display:flex;flex-direction:column;gap:6px}
    .inline-field{display:flex;align-items:center;gap:10px;padding:12px;border:1px solid #f2b8cc;border-radius:12px;background:#fff9fb}
    label{font-size:13px;color:#7e4d61}
    input,textarea{padding:10px 12px;border:1px solid #f2b8cc;border-radius:10px;outline:none}
    input[type="checkbox"]{width:18px;height:18px;padding:0}
    input:focus,textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(255,92,147,.15)}
    .actions{display:flex;align-items:center;gap:10px;margin-top:12px;flex-wrap:wrap}
    button{background:var(--accent);color:#fff;border:none;border-radius:10px;padding:10px 14px;cursor:pointer}
    button:hover{filter:brightness(.95)}
    table{width:100%;border-collapse:collapse}
    th,td{padding:10px;text-align:left;border-bottom:1px dashed var(--line);vertical-align:top}
    .table-wrap{max-height:340px;overflow:auto;border:1px dashed var(--line);border-radius:10px}
    .pill{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:2px 8px;font-size:12px;background:#fff9fb}
    .mono{font-family:Consolas,Monaco,monospace}
    #thinking-content{white-space:pre-wrap;background:#fff9fb;padding:10px;border-radius:10px;border-left:3px solid var(--accent)}
    #save-status,#mg-status,#mg-rollback-status{font-size:13px}
    @media (max-width: 820px){.grid{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <h1>MizukiBot 控制台</h1>

  <div class="card">
    <h3>模型与运行设置</h3>
    <div class="hint">保存后立即生效，并写入 .env。</div>
    <form id="settings-form">
      <div class="grid">
        <div class="field" style="grid-column:1 / -1">
          <label>API Key</label>
          <input id="api_key" type="password" autocomplete="off" placeholder="留空则保持当前 API_KEY" />
          <div class="hint" id="api_key_hint">当前未设置</div>
        </div>
        <div class="field" style="grid-column:1 / -1">
          <label>API Base URL</label>
          <input id="api_base_url" placeholder="https://example.com/v1/chat/completions" />
        </div>
        <div class="field"><label>AI_MODEL</label><input id="ai_model" list="text-model-list" placeholder="gpt-5.4" /></div>
        <div class="field"><label>AI_FALLBACK_MODEL</label><input id="ai_fallback_model" list="text-model-list" placeholder="留空则不启用备用模型" /></div>
        <div class="field" style="grid-column:1 / -1"><label>AI_FALLBACK_API_BASE_URL</label><input id="ai_fallback_api_base_url" placeholder="留空则跟随 API_BASE_URL" /></div>
        <div class="field" style="grid-column:1 / -1"><label>AI_FALLBACK_API_KEY</label><input id="ai_fallback_api_key" type="password" autocomplete="off" placeholder="留空则保持当前值；空值时运行时回退到 API_KEY" /><div class="hint" id="ai_fallback_api_key_hint">当前未设置（将回退到 API_KEY）</div></div>
        <div class="field"><label>AI_FALLBACK_FAILURE_THRESHOLD</label><input id="ai_fallback_failure_threshold" type="number" min="1" max="100" step="1" /></div>
        <div class="field"><label>AI_FALLBACK_COOLDOWN_MS</label><input id="ai_fallback_cooldown_ms" type="number" min="0" max="31536000000" step="1000" /></div>
        <div class="field" style="grid-column:1 / -1"><label>主模型降级开关</label><div class="inline-field"><input id="ai_fallback_enabled" type="checkbox" /><span>主模型失败后自动切换到备用模型</span></div></div>
        <div class="field"><label>AI_ROUTER_MODEL</label><input id="ai_router_model" list="text-model-list" placeholder="留空则跟随 PLAN_MODEL / AI_MODEL" /></div>
        <div class="field" style="grid-column:1 / -1"><label>AI_ROUTER_BASE_URL</label><input id="ai_router_base_url" placeholder="留空则跟随 API_BASE_URL" /></div>
        <div class="field" style="grid-column:1 / -1"><label>AI_ROUTER_API_KEY</label><input id="ai_router_api_key" type="password" autocomplete="off" placeholder="留空则保持当前值；空值时运行时回退到 API_KEY" /><div class="hint" id="ai_router_api_key_hint">当前未设置（将回退到 API_KEY）</div></div>
        <div class="field"><label>MEMORY_MODEL</label><input id="memory_model" list="text-model-list" placeholder="gpt-5.1-codex-mini" /></div>
        <div class="field"><label>MEMORY_API_BASE_URL</label><input id="memory_api_base_url" placeholder="留空则跟随 API_BASE_URL" /></div>
        <div class="field" style="grid-column:1 / -1"><label>MEMORY_API_KEY</label><input id="memory_api_key" type="password" autocomplete="off" placeholder="留空则保持当前值；仅在独立 MEMORY_API_BASE_URL 生效时优先使用" /><div class="hint" id="memory_api_key_hint">当前未设置；若 MEMORY_API_BASE_URL 为空，将使用 API_KEY</div></div>
        <div class="field"><label>IMAGE_MODEL</label><input id="image_model" list="image-model-list" placeholder="gpt-image-1" /></div>
        <div class="field" style="grid-column:1 / -1"><label>IMAGE_API_BASE_URL</label><input id="image_api_base_url" placeholder="留空则跟随 API_BASE_URL" /></div>
        <div class="field" style="grid-column:1 / -1"><label>IMAGE_API_KEY</label><input id="image_api_key" type="password" autocomplete="off" placeholder="留空则保持当前值；仅在独立 IMAGE_API_BASE_URL 生效时优先使用" /><div class="hint" id="image_api_key_hint">当前未设置；若 IMAGE_API_BASE_URL 为空，将使用 API_KEY</div></div>
        <div class="field"><label>AI_TEMPERATURE (0~2)</label><input id="ai_temperature" type="number" min="0" max="2" step="0.1" /></div>
        <div class="field"><label>AI_TOP_P (0~1)</label><input id="ai_top_p" type="number" min="0" max="1" step="0.01" /></div>
        <div class="field"><label>AI_MAX_TOKENS</label><input id="ai_max_tokens" type="number" min="64" step="1" /></div>
        <div class="field"><label>AI_RETRIES</label><input id="ai_retries" type="number" min="0" max="10" step="1" /></div>
        <div class="field"><label>AI_STREAM_CHUNK_MS</label><input id="ai_stream_chunk_ms" type="number" min="200" max="5000" step="100" /></div>
        <div class="field" style="grid-column:1 / -1"><label>流式输出</label><div class="inline-field"><input id="ai_stream_enabled" type="checkbox" /><span>开启后普通聊天采用分段发送</span></div></div>
        <div class="field" style="grid-column:1 / -1"><label>LLM 去 AI 痕迹</label><div class="inline-field"><input id="llm_humanizer_enabled" type="checkbox" /><span>开启后回复会先改写，再发送；并自动关闭流式输出</span></div></div>
      </div>
      <datalist id="text-model-list">${modelOptions}</datalist>
      <datalist id="image-model-list">${imageModelOptions}</datalist>
      <div class="actions"><button type="submit">保存设置</button><span id="save-status"></span></div>
    </form>
  </div>

  <div class="card"><h3>Agent 当前思考</h3><div id="thinking-content">等待中...</div></div>

  <div class="card">
    <h3>最近模型调用</h3>
    <div class="hint">可直接看到主对话调用、是否注入长期记忆，以及异步长期记忆提取调用。</div>
    <div class="actions"><button type="button" id="btn-model-calls-load">刷新模型调用</button></div>
    <div class="table-wrap" style="margin-top:10px"><table><thead><tr><th>时间</th><th>来源</th><th>阶段/目的</th><th>模型</th><th>状态</th><th>记忆注入</th><th>详情</th></tr></thead><tbody id="model-calls-body"></tbody></table></div>
  </div>

  <div class="card">
    <h3>长期记忆治理（压缩 + 纯洁）</h3>
    <div class="hint">默认推荐：平衡模式 + 归档。先预览，再应用。</div>
    <form id="memory-governance-form">
      <div class="grid">
        <div class="field"><label>用户ID（留空=全量）</label><input id="mg_user_id" placeholder="例如 992507212" /></div>
        <div class="field"><label>模式</label><input id="mg_mode" value="balanced" /><div class="muted">balanced / strict</div></div>
        <div class="field"><label>动作</label><input id="mg_action" value="archive" /><div class="muted">archive / delete</div></div>
        <div class="field"><label>最小置信度</label><input id="mg_min_confidence" type="number" min="0.01" max="1" step="0.01" value="0.72" /></div>
        <div class="field"><label>Topic 保留天数</label><input id="mg_topic_ttl_days" type="number" min="3" max="3650" step="1" value="21" /></div>
        <div class="field"><label>去重阈值</label><input id="mg_dedupe_threshold" type="number" min="0.75" max="0.99" step="0.01" value="0.9" /></div>
      </div>
      <div class="actions"><button type="button" id="btn-mg-preview">预览变更</button><button type="button" id="btn-mg-apply">应用治理</button><span id="mg-status"></span></div>
    </form>
    <div class="actions"><span class="pill" id="mg-pill-total">total: -</span><span class="pill" id="mg-pill-active">active: -</span><span class="pill" id="mg-pill-planned">planned: -</span><span class="pill" id="mg-pill-dup">duplicate: -</span><span class="pill" id="mg-pill-lowc">low_conf: -</span><span class="pill" id="mg-pill-topic">stale_topic: -</span></div>
    <div class="table-wrap" style="margin-top:10px"><table><thead><tr><th>ID</th><th>User</th><th>Type</th><th>Reason</th><th>Op</th><th>Text</th></tr></thead><tbody id="mg-preview-body"></tbody></table></div>
  </div>

  <div class="card">
    <h3>长期记忆明细（可修改）</h3>
    <div class="actions"><input id="ml_user_id" placeholder="按用户ID过滤（留空全量）" /><button type="button" id="btn-ml-load">刷新明细</button></div>
    <div class="table-wrap" style="margin-top:10px"><table><thead><tr><th>ID</th><th>User</th><th>Type</th><th>Status</th><th>Conf</th><th>Text（可编辑）</th></tr></thead><tbody id="ml-body"></tbody></table></div>
    <div style="margin-top:12px"><label>快照回滚</label><div class="actions"><input id="mg_snapshot_file" placeholder="例如 memory_items_20260316xxxxxx_governance.json" /><button type="button" id="btn-mg-snapshots">加载快照</button><button type="button" id="btn-mg-rollback">执行回滚</button><span id="mg-rollback-status"></span></div><div class="table-wrap" style="margin-top:10px"><table><thead><tr><th>Snapshot</th><th>Size</th><th>Updated</th></tr></thead><tbody id="mg-snapshots-body"></tbody></table></div></div>
  </div>

  <div class="card"><h3>好感度排行</h3><div class="table-wrap"><table><tr><th>QQ</th><th>等级</th><th>亲密度</th><th>关系</th><th>态度</th><th>最近变更原因</th><th>最近更新时间</th></tr>${favorHtml}</table></div></div>
  <div class="card"><h3>旧版记忆碎片（memories.json）</h3>${memoryHtml}</div>

  <script>
    const savedApiKeys = {
      main: false,
      fallback: false,
      router: false,
      memory: false,
      image: false
    };

    function getToken() {
      return localStorage.getItem('WEB_TOKEN') || '';
    }

    async function authedFetch(url, options) {
      const opts = options || {};
      const headers = Object.assign({}, opts.headers || {});
      const token = getToken();
      if (token) headers['x-web-token'] = token;
      return fetch(url, Object.assign({}, opts, { headers }));
    }

    function escapeCell(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function formatTs(ts) {
      const n = Number(ts || 0);
      if (!Number.isFinite(n) || n <= 0) return '-';
      return new Date(n).toLocaleString();
    }

    async function loadSettings() {
      try {
        const res = await authedFetch('/api/settings');
        const data = await res.json();
        if (!data.ok) return;
        const s = data.settings || {};
        savedApiKeys.main = Boolean(s.has_api_key);
        savedApiKeys.fallback = Boolean(s.has_ai_fallback_api_key);
        savedApiKeys.router = Boolean(s.has_ai_router_api_key);
        savedApiKeys.memory = Boolean(s.has_memory_api_key);
        savedApiKeys.image = Boolean(s.has_image_api_key);
        document.getElementById('api_key').value = '';
        document.getElementById('api_key_hint').textContent = s.api_key_masked
          ? ('当前已保存：' + s.api_key_masked)
          : '当前未设置';
        document.getElementById('ai_fallback_api_key').value = '';
        document.getElementById('ai_fallback_api_key_hint').textContent = s.ai_fallback_api_key_masked
          ? ('当前已保存：' + s.ai_fallback_api_key_masked)
          : '当前未设置（将回退到 API_KEY）';
        document.getElementById('ai_router_api_key').value = '';
        document.getElementById('ai_router_api_key_hint').textContent = s.ai_router_api_key_masked
          ? ('当前已保存：' + s.ai_router_api_key_masked)
          : '当前未设置（将回退到 API_KEY）';
        document.getElementById('memory_api_key').value = '';
        document.getElementById('memory_api_key_hint').textContent = s.memory_api_key_masked
          ? ('当前已保存：' + s.memory_api_key_masked)
          : '当前未设置；若 MEMORY_API_BASE_URL 为空，将使用 API_KEY';
        document.getElementById('image_api_key').value = '';
        document.getElementById('image_api_key_hint').textContent = s.image_api_key_masked
          ? ('当前已保存：' + s.image_api_key_masked)
          : '当前未设置；若 IMAGE_API_BASE_URL 为空，将使用 API_KEY';
        document.getElementById('api_base_url').value = s.api_base_url || '';
        document.getElementById('ai_model').value = s.ai_model || '';
        document.getElementById('ai_fallback_model').value = s.ai_fallback_model || '';
        document.getElementById('ai_fallback_api_base_url').value = s.ai_fallback_api_base_url || '';
        document.getElementById('ai_fallback_failure_threshold').value = String(s.ai_fallback_failure_threshold ?? 3);
        document.getElementById('ai_fallback_cooldown_ms').value = String(s.ai_fallback_cooldown_ms ?? 600000);
        document.getElementById('ai_fallback_enabled').checked = Boolean(s.ai_fallback_enabled);
        document.getElementById('ai_router_model').value = s.ai_router_model || '';
        document.getElementById('ai_router_base_url').value = s.ai_router_base_url || '';
        document.getElementById('memory_model').value = s.memory_model || '';
        document.getElementById('memory_api_base_url').value = s.memory_api_base_url || '';
        document.getElementById('image_model').value = s.image_model || '';
        document.getElementById('image_api_base_url').value = s.image_api_base_url || '';
        document.getElementById('ai_temperature').value = String(s.ai_temperature ?? 0.6);
        document.getElementById('ai_top_p').value = String(s.ai_top_p ?? 0.92);
        document.getElementById('ai_max_tokens').value = String(s.ai_max_tokens ?? 3500);
        document.getElementById('ai_retries').value = String(s.ai_retries ?? 1);
        document.getElementById('ai_stream_enabled').checked = Boolean(s.ai_stream_enabled);
        document.getElementById('ai_stream_chunk_ms').value = String(s.ai_stream_chunk_ms ?? 900);
        document.getElementById('llm_humanizer_enabled').checked = Boolean(s.llm_humanizer_enabled);
      } catch (_) {}
    }

    async function saveSettings(ev) {
      ev.preventDefault();
      const status = document.getElementById('save-status');
      status.textContent = '保存中...';
      status.style.color = '#2f9d62';

      const keyInput = document.getElementById('api_key').value.trim();
      if (!keyInput && !savedApiKeys.main) {
        status.textContent = '保存失败：请先填写 API_KEY';
        status.style.color = '#d12b5b';
        return;
      }

      const llmHumanizerEnabled = document.getElementById('llm_humanizer_enabled').checked;
      const streamEnabled = llmHumanizerEnabled ? false : document.getElementById('ai_stream_enabled').checked;

      const payload = {
        api_key: keyInput,
        api_base_url: document.getElementById('api_base_url').value.trim(),
        ai_model: document.getElementById('ai_model').value.trim(),
        ai_fallback_enabled: document.getElementById('ai_fallback_enabled').checked,
        ai_fallback_model: document.getElementById('ai_fallback_model').value.trim(),
        ai_fallback_api_base_url: document.getElementById('ai_fallback_api_base_url').value.trim(),
        ai_fallback_api_key: document.getElementById('ai_fallback_api_key').value.trim(),
        ai_fallback_failure_threshold: Number(document.getElementById('ai_fallback_failure_threshold').value),
        ai_fallback_cooldown_ms: Number(document.getElementById('ai_fallback_cooldown_ms').value),
        ai_router_model: document.getElementById('ai_router_model').value.trim(),
        ai_router_base_url: document.getElementById('ai_router_base_url').value.trim(),
        ai_router_api_key: document.getElementById('ai_router_api_key').value.trim(),
        memory_model: document.getElementById('memory_model').value.trim(),
        memory_api_base_url: document.getElementById('memory_api_base_url').value.trim(),
        memory_api_key: document.getElementById('memory_api_key').value.trim(),
        image_model: document.getElementById('image_model').value.trim(),
        image_api_base_url: document.getElementById('image_api_base_url').value.trim(),
        image_api_key: document.getElementById('image_api_key').value.trim(),
        ai_temperature: Number(document.getElementById('ai_temperature').value),
        ai_top_p: Number(document.getElementById('ai_top_p').value),
        ai_max_tokens: Number(document.getElementById('ai_max_tokens').value),
        ai_retries: Number(document.getElementById('ai_retries').value),
        ai_stream_enabled: streamEnabled,
        ai_stream_chunk_ms: Number(document.getElementById('ai_stream_chunk_ms').value),
        llm_humanizer_enabled: llmHumanizerEnabled
      };

      try {
        const res = await authedFetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          status.textContent = '保存失败：' + (data.error || '未知错误');
          status.style.color = '#d12b5b';
          return;
        }
        status.textContent = llmHumanizerEnabled
          ? '保存成功：已启用去 AI 痕迹并自动关闭流式输出'
          : '保存成功：已立即生效';
        status.style.color = '#2f9d62';
        await loadSettings();
      } catch (e) {
        status.textContent = '保存失败：' + e.message;
        status.style.color = '#d12b5b';
      }
    }

    function setGovernanceStatus(text, ok) {
      const el = document.getElementById('mg-status');
      el.textContent = text;
      el.style.color = ok === false ? '#d12b5b' : '#2f9d62';
    }

    function setRollbackStatus(text, ok) {
      const el = document.getElementById('mg-rollback-status');
      el.textContent = text;
      el.style.color = ok === false ? '#d12b5b' : '#2f9d62';
    }

    function readGovernancePayload() {
      return {
        user_id: document.getElementById('mg_user_id').value.trim(),
        mode: document.getElementById('mg_mode').value.trim() || 'balanced',
        action: document.getElementById('mg_action').value.trim() || 'archive',
        min_confidence: Number(document.getElementById('mg_min_confidence').value),
        topic_ttl_days: Number(document.getElementById('mg_topic_ttl_days').value),
        dedupe_threshold: Number(document.getElementById('mg_dedupe_threshold').value)
      };
    }

    function renderGovernancePills(stats, activeTotal) {
      const s = stats || {};
      document.getElementById('mg-pill-total').textContent = 'total: ' + (s.scanned ?? s.total ?? '-');
      document.getElementById('mg-pill-active').textContent = 'active: ' + (s.active_scanned ?? activeTotal ?? '-');
      document.getElementById('mg-pill-planned').textContent = 'planned: ' + (s.planned ?? '-');
      document.getElementById('mg-pill-dup').textContent = 'duplicate: ' + (s.duplicate ?? '-');
      document.getElementById('mg-pill-lowc').textContent = 'low_conf: ' + (s.low_confidence ?? '-');
      document.getElementById('mg-pill-topic').textContent = 'stale_topic: ' + (s.stale_topic ?? '-');
    }

    function renderPreviewRows(rows) {
      const list = Array.isArray(rows) ? rows : [];
      const body = document.getElementById('mg-preview-body');
      if (list.length === 0) {
        body.innerHTML = '<tr><td colspan="6" class="muted">暂无预览结果</td></tr>';
        return;
      }
      body.innerHTML = list.map(function (row) {
        return '<tr>'
          + '<td class="mono">' + escapeCell(String(row.id || '').slice(0, 18)) + '</td>'
          + '<td>' + escapeCell(row.userId || '') + '</td>'
          + '<td>' + escapeCell(row.type || '') + '</td>'
          + '<td>' + escapeCell(row.reason || '') + '</td>'
          + '<td>' + escapeCell(row.op || '') + '</td>'
          + '<td title="' + escapeCell(row.text || '') + '">' + escapeCell(String(row.text || '').slice(0, 88)) + '</td>'
          + '</tr>';
      }).join('');
    }

    async function loadGovernanceStats() {
      try {
        const userId = document.getElementById('mg_user_id').value.trim();
        const q = userId ? ('?user_id=' + encodeURIComponent(userId)) : '';
        const res = await authedFetch('/api/memory-governance/stats' + q);
        const data = await res.json();
        if (!res.ok || !data.ok) return;
        const active = Number((data.stats && data.stats.byStatus && data.stats.byStatus.active) || 0);
        renderGovernancePills(data.stats || {}, active);
      } catch (_) {}
    }

    async function previewGovernanceAction() {
      setGovernanceStatus('Previewing...', true);
      try {
        const res = await authedFetch('/api/memory-governance/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(readGovernancePayload())
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          setGovernanceStatus('Preview failed: ' + (data.error || 'unknown error'), false);
          return;
        }
        renderGovernancePills(data.stats || {});
        renderPreviewRows(data.preview || []);
        setGovernanceStatus('Preview done: planned ' + Number(data.stats?.planned || 0) + ' items', true);
      } catch (e) {
        setGovernanceStatus('Preview failed: ' + e.message, false);
      }
    }

    async function applyGovernanceAction() {
      const confirmed = confirm('Apply governance with current parameters and create a snapshot?');
      if (!confirmed) return;

      setGovernanceStatus('Applying...', true);
      try {
        const res = await authedFetch('/api/memory-governance/apply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(readGovernancePayload())
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          setGovernanceStatus('Apply failed: ' + (data.error || 'unknown error'), false);
          return;
        }

        const snapshotText = data.snapshot ? (', snapshot: ' + data.snapshot) : '';
        setGovernanceStatus('Apply done: planned ' + Number(data.stats?.planned || 0) + ' items' + snapshotText, true);
        await loadGovernanceStats();
        await previewGovernanceAction();
        await loadMemoryItems();
        await loadSnapshots();
      } catch (e) {
        setGovernanceStatus('Apply failed: ' + e.message, false);
      }
    }

    function renderMemoryItems(items) {
      const list = Array.isArray(items) ? items : [];
      const body = document.getElementById('ml-body');
      if (list.length === 0) {
        body.innerHTML = '<tr><td colspan="6" class="muted">暂无数据</td></tr>';
        return;
      }

      body.innerHTML = list.map(function (item) {
        const status = String(item.status || 'active');
        const nextStatus = status === 'active' ? 'archived' : 'active';
        const nextLabel = status === 'active' ? '归档' : '恢复';

        return '<tr>'
          + '<td class="mono">' + escapeCell(String(item.id || '').slice(0, 18)) + '</td>'
          + '<td>' + escapeCell(item.userId || '') + '</td>'
          + '<td>' + escapeCell(item.type || '') + '</td>'
          + '<td>' + escapeCell(status) + '</td>'
          + '<td>' + Number(item.confidence || 0).toFixed(2) + '</td>'
          + '<td title="' + escapeCell(item.text || '') + '">'
          + '<div>' + escapeCell(String(item.text || '').slice(0, 120)) + '</div>'
          + '<div class="muted">' + formatTs(item.updatedAt || item.createdAt) + '</div>'
          + '<div class="actions" style="margin-top:6px">'
          + '<button type="button" class="btn-item-edit" data-id="' + escapeCell(item.id) + '">编辑</button>'
          + '<button type="button" class="btn-item-status" data-id="' + escapeCell(item.id) + '" data-status="' + nextStatus + '">' + nextLabel + '</button>'
          + '</div>'
          + '</td>'
          + '</tr>';
      }).join('');
    }

    async function loadMemoryItems() {
      try {
        const userId = document.getElementById('ml_user_id').value.trim() || document.getElementById('mg_user_id').value.trim();
        const params = new URLSearchParams();
        params.set('limit', '200');
        if (userId) params.set('user_id', userId);

        const res = await authedFetch('/api/memory-governance/items?' + params.toString());
        const data = await res.json();
        if (!res.ok || !data.ok) return;
        renderMemoryItems(data.items || []);
      } catch (_) {}
    }

    async function updateMemoryItemAction(id, patch) {
      const res = await authedFetch('/api/memory-governance/item/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ id: id }, patch))
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'update failed');
      return data;
    }

    async function loadSnapshots() {
      try {
        const res = await authedFetch('/api/memory-governance/snapshots?limit=30');
        const data = await res.json();
        if (!res.ok || !data.ok) return;

        const body = document.getElementById('mg-snapshots-body');
        const rows = Array.isArray(data.snapshots) ? data.snapshots : [];
        if (rows.length === 0) {
          body.innerHTML = '<tr><td colspan="3" class="muted">暂无快照</td></tr>';
          return;
        }

        body.innerHTML = rows.map(function (row) {
          return '<tr>'
            + '<td><a href="#" class="pick-snapshot" data-file="' + escapeCell(row.file) + '">' + escapeCell(row.file) + '</a></td>'
            + '<td>' + Number(row.size || 0) + '</td>'
            + '<td>' + formatTs(row.createdAt) + '</td>'
            + '</tr>';
        }).join('');
      } catch (_) {}
    }

    async function rollbackBySnapshot() {
      const file = document.getElementById('mg_snapshot_file').value.trim();
      if (!file) {
        setRollbackStatus('请先输入或选择快照文件名', false);
        return;
      }
      const confirmed = confirm('将回滚到快照 ' + file + '，是否继续？');
      if (!confirmed) return;

      setRollbackStatus('回滚中...', true);
      try {
        const res = await authedFetch('/api/memory-governance/rollback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ snapshot: file })
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          setRollbackStatus('回滚失败：' + (data.error || 'unknown error'), false);
          return;
        }

        setRollbackStatus('回滚成功：' + file, true);
        await loadGovernanceStats();
        await loadMemoryItems();
        await previewGovernanceAction();
        await loadSnapshots();
      } catch (e) {
        setRollbackStatus('回滚失败：' + e.message, false);
      }
    }

    async function refreshThinking() {
      try {
        const res = await authedFetch('/api/bot-thinking');
        const data = await res.json();
        document.getElementById('thinking-content').innerText = data.reasoning || '';
      } catch (_) {}
    }

    function renderModelCalls(calls) {
      const list = Array.isArray(calls) ? calls : [];
      const body = document.getElementById('model-calls-body');
      if (list.length === 0) {
        body.innerHTML = '<tr><td colspan="7" class="muted">暂无模型调用记录</td></tr>';
        return;
      }

      body.innerHTML = list.map(function (item) {
        const phasePurpose = [item.phase, item.purpose].filter(Boolean).join(' / ') || '-';
        const usage = item.usage && item.usage.total_tokens != null
          ? ('tokens=' + Number(item.usage.total_tokens))
          : '-';
        const duration = item.duration_ms != null ? (String(item.duration_ms) + 'ms') : '-';
        const detail = [usage, duration, item.error || ''].filter(Boolean).join(' | ');
        return '<tr>'
          + '<td>' + escapeCell(item.started_at || '') + '</td>'
          + '<td>' + escapeCell(item.source || '-') + '</td>'
          + '<td>' + escapeCell(phasePurpose) + '</td>'
          + '<td class="mono">' + escapeCell(item.model || '-') + '</td>'
          + '<td>' + escapeCell(item.status || '-') + '</td>'
          + '<td>' + (item.memory_injected ? 'yes' : 'no') + '</td>'
          + '<td title="' + escapeCell(detail) + '">' + escapeCell(detail || '-') + '</td>'
          + '</tr>';
      }).join('');
    }

    async function loadModelCalls() {
      try {
        const res = await authedFetch('/api/model-calls?limit=30');
        const data = await res.json();
        if (!res.ok || !data.ok) return;
        renderModelCalls(data.calls || []);
      } catch (_) {}
    }

    document.getElementById('settings-form').addEventListener('submit', saveSettings);
    document.getElementById('btn-model-calls-load').addEventListener('click', loadModelCalls);
    document.getElementById('btn-mg-preview').addEventListener('click', previewGovernanceAction);
    document.getElementById('btn-mg-apply').addEventListener('click', applyGovernanceAction);
    document.getElementById('btn-ml-load').addEventListener('click', loadMemoryItems);
    document.getElementById('btn-mg-snapshots').addEventListener('click', loadSnapshots);
    document.getElementById('btn-mg-rollback').addEventListener('click', rollbackBySnapshot);

    document.getElementById('ml-body').addEventListener('click', async function (ev) {
      const target = ev.target;
      if (!target) return;

      if (target.classList.contains('btn-item-edit')) {
        const id = target.getAttribute('data-id');
        const nextText = prompt('请输入新的记忆文本：');
        if (nextText === null) return;

        try {
          await updateMemoryItemAction(id, { text: nextText });
          await loadMemoryItems();
          await loadGovernanceStats();
          setGovernanceStatus('记忆已更新', true);
        } catch (e) {
          setGovernanceStatus(e.message, false);
        }
        return;
      }

      if (target.classList.contains('btn-item-status')) {
        const id = target.getAttribute('data-id');
        const status = target.getAttribute('data-status');
        try {
          await updateMemoryItemAction(id, { status: status });
          await loadMemoryItems();
          await loadGovernanceStats();
          setGovernanceStatus('状态已更新为 ' + status, true);
        } catch (e) {
          setGovernanceStatus(e.message, false);
        }
      }
    });

    document.getElementById('mg-snapshots-body').addEventListener('click', function (ev) {
      const target = ev.target;
      if (!target || !target.classList.contains('pick-snapshot')) return;
      ev.preventDefault();
      document.getElementById('mg_snapshot_file').value = target.getAttribute('data-file') || '';
    });

    loadSettings();
    loadGovernanceStats();
    loadMemoryItems();
    loadSnapshots();
    previewGovernanceAction();
    refreshThinking();
    loadModelCalls();
    setInterval(refreshThinking, 1500);
    setInterval(loadModelCalls, 2500);
  </script>
</body>
</html>
    `);
  });

  app.listen(port, host, () => {
    console.log(`Console started: http://${host}:${port}`);
  });
}

module.exports = { startServer };
