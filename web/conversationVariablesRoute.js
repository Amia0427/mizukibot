'use strict';

const conversationVariables = require('../utils/conversationVariables');

function normalizeText(value, maxLength = 240) {
  const text = String(value || '').trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function registerConversationVariablesRoutes(app) {
  app.get('/api/conversation-variables/state', (req, res) => {
    try {
      const userId = normalizeText(req.query.user_id || req.query.userId, 80);
      if (!userId) return res.status(400).json({ ok: false, error: 'user_id is required' });
      return res.json({ ok: true, snapshot: conversationVariables.getSnapshot({ userId }) });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message || 'Failed to load variable state' });
    }
  });

  app.get('/api/conversation-variables/events', (req, res) => {
    try {
      const scopeType = normalizeText(req.query.scope_type || req.query.scopeType, 16);
      const scopeId = normalizeText(req.query.scope_id || req.query.scopeId, 80);
      if (!scopeType || !scopeId) return res.status(400).json({ ok: false, error: 'scope_type and scope_id are required' });
      return res.json({
        ok: true,
        events: conversationVariables.getEvents({
          scopeType,
          scopeId,
          limit: Number(req.query.limit || 50)
        })
      });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message || 'Failed to load variable events' });
    }
  });

  app.post('/api/conversation-variables/override', (req, res) => {
    try {
      const body = req.body || {};
      const scopeType = normalizeText(body.scope_type || body.scopeType, 16);
      const scopeId = normalizeText(body.scope_id || body.scopeId, 80);
      const key = normalizeText(body.key || body.variable_key || body.variableKey, 40);
      const reason = normalizeText(body.reason, 240);
      const actorId = normalizeText(body.actor_id || body.actorId || 'web-admin', 80);
      if (!scopeType || !scopeId || !key || !reason) {
        return res.status(400).json({ ok: false, error: 'scope_type, scope_id, key and reason are required' });
      }
      const result = conversationVariables.setOverride({
        scopeType,
        scopeId,
        key,
        value: body.value,
        locked: body.locked !== false,
        reason,
        actorId,
        eventKey: normalizeText(body.event_key || body.eventKey, 240)
      });
      return res.json({ ok: true, ...result });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error.message || 'Failed to set variable override' });
    }
  });

  app.post('/api/conversation-variables/override/remove', (req, res) => {
    try {
      const body = req.body || {};
      const scopeType = normalizeText(body.scope_type || body.scopeType, 16);
      const scopeId = normalizeText(body.scope_id || body.scopeId, 80);
      const key = normalizeText(body.key || body.variable_key || body.variableKey, 40);
      const reason = normalizeText(body.reason, 240);
      const actorId = normalizeText(body.actor_id || body.actorId || 'web-admin', 80);
      if (!scopeType || !scopeId || !key || !reason) {
        return res.status(400).json({ ok: false, error: 'scope_type, scope_id, key and reason are required' });
      }
      const result = conversationVariables.clearOverride({
        scopeType,
        scopeId,
        key,
        reason,
        actorId,
        eventKey: normalizeText(body.event_key || body.eventKey, 240)
      });
      return res.json({ ok: true, ...result });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error.message || 'Failed to remove variable override' });
    }
  });
}

module.exports = {
  registerConversationVariablesRoutes
};
