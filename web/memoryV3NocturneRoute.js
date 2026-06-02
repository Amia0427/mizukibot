const {
  addMemoryAlias,
  listMemoryAliases,
  removeMemoryAlias
} = require('../utils/memory-v3/aliasIndex');
const {
  buildBootMemory
} = require('../utils/memory-v3/bootMemory');
const {
  acceptChangeset,
  listPendingChangesets,
  rejectChangeset
} = require('../utils/memory-v3/changesetReview');
const {
  addMemoryTriggers,
  listMemoryTriggers,
  removeMemoryTriggers
} = require('../utils/memory-v3/triggerGlossary');
const {
  buildMemoryUriTree,
  readMemoryUri,
  searchMemoryUris
} = require('../utils/memory-v3/uriResolver');
const {
  cleanJournalEntries,
  cleanProfileFacts,
  getDiagnostics: getProfileJournalDbDiagnostics
} = require('../utils/profileJournalDb');

function text(value = '') {
  return String(value || '').trim();
}

function contextFromReq(req) {
  return {
    userId: text(req.query.user_id || req.query.userId || req.body?.user_id || req.body?.userId),
    groupId: text(req.query.group_id || req.query.groupId || req.body?.group_id || req.body?.groupId),
    sessionKey: text(req.query.session_key || req.query.sessionKey || req.body?.session_key || req.body?.sessionKey),
    namespace: text(req.query.namespace || req.body?.namespace || '')
  };
}

function registerMemoryV3NocturneRoutes(app) {
  app.get('/api/memory-v3/uri-tree', (req, res) => {
    try {
      return res.json(buildMemoryUriTree(contextFromReq(req), {
        limit: Number(req.query.limit || 200),
        namespace: text(req.query.namespace)
      }));
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message || 'Failed to build memory tree' });
    }
  });

  app.get('/api/memory-v3/read', (req, res) => {
    try {
      const uri = text(req.query.uri);
      if (!uri) return res.status(400).json({ ok: false, error: 'uri is required' });
      if (uri.toLowerCase() === 'system://boot') {
        const ctx = contextFromReq(req);
        if (!ctx.userId) return res.status(400).json({ ok: false, error: 'user_id is required for system://boot' });
        return buildBootMemory(ctx).then((boot) => res.json({
          ok: boot.ok,
          uri: 'system://boot',
          source: 'system',
          id: 'boot',
          text: boot.text || '',
          data: boot,
          reason: boot.reason || ''
        })).catch((e) => res.status(500).json({ ok: false, error: e.message || 'Failed to build boot memory' }));
      }
      return res.json(readMemoryUri(uri, contextFromReq(req), {
        namespace: text(req.query.namespace)
      }));
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message || 'Failed to read memory uri' });
    }
  });

  app.get('/api/memory-v3/search-uris', (req, res) => {
    try {
      return res.json(searchMemoryUris(text(req.query.query), contextFromReq(req), {
        namespace: text(req.query.namespace),
        limit: Number(req.query.limit || 20)
      }));
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message || 'Failed to search memory uris' });
    }
  });

  app.get('/api/memory-v3/boot', async (req, res) => {
    try {
      const ctx = contextFromReq(req);
      if (!ctx.userId) return res.status(400).json({ ok: false, error: 'user_id is required' });
      return res.json(await buildBootMemory({
        ...ctx,
        query: text(req.query.query)
      }));
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message || 'Failed to build boot memory' });
    }
  });

  app.get('/api/memory-v3/aliases', (req, res) => {
    try {
      return res.json({ ok: true, aliases: listMemoryAliases({ namespace: text(req.query.namespace) }) });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message || 'Failed to list aliases' });
    }
  });

  app.post('/api/memory-v3/aliases', (req, res) => {
    try {
      return res.json(addMemoryAlias({
        namespace: text(req.body?.namespace),
        aliasUri: text(req.body?.alias_uri || req.body?.aliasUri || req.body?.uri),
        targetUri: text(req.body?.target_uri || req.body?.targetUri || req.body?.target),
        priority: Number(req.body?.priority || 0),
        disclosure: text(req.body?.disclosure)
      }));
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message || 'Failed to save alias' });
    }
  });

  app.post('/api/memory-v3/aliases/remove', (req, res) => {
    try {
      return res.json(removeMemoryAlias({
        namespace: text(req.body?.namespace),
        aliasUri: text(req.body?.alias_uri || req.body?.aliasUri || req.body?.uri)
      }));
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message || 'Failed to remove alias' });
    }
  });

  app.get('/api/memory-v3/triggers', (req, res) => {
    try {
      return res.json({ ok: true, triggers: listMemoryTriggers({ namespace: text(req.query.namespace), uri: text(req.query.uri) }) });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message || 'Failed to list triggers' });
    }
  });

  app.post('/api/memory-v3/triggers', (req, res) => {
    try {
      return res.json(addMemoryTriggers({
        namespace: text(req.body?.namespace),
        uri: text(req.body?.uri),
        keywords: Array.isArray(req.body?.keywords) ? req.body.keywords : [req.body?.keyword].filter(Boolean),
        priority: Number(req.body?.priority || 0),
        disclosure: text(req.body?.disclosure)
      }));
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message || 'Failed to save trigger' });
    }
  });

  app.post('/api/memory-v3/triggers/remove', (req, res) => {
    try {
      return res.json(removeMemoryTriggers({
        namespace: text(req.body?.namespace),
        uri: text(req.body?.uri),
        keywords: Array.isArray(req.body?.keywords) ? req.body.keywords : [req.body?.keyword].filter(Boolean)
      }));
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message || 'Failed to remove trigger' });
    }
  });

  app.get('/api/memory-v3/review', (req, res) => {
    try {
      return res.json(listPendingChangesets({
        userId: text(req.query.user_id || req.query.userId),
        status: text(req.query.status || 'candidate'),
        limit: Number(req.query.limit || 50)
      }));
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message || 'Failed to list changesets' });
    }
  });

  app.post('/api/memory-v3/review/accept', async (req, res) => {
    try {
      return res.json(await acceptChangeset(text(req.body?.id)));
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message || 'Failed to accept changeset' });
    }
  });

  app.post('/api/memory-v3/review/reject', async (req, res) => {
    try {
      return res.json(await rejectChangeset(text(req.body?.id), { reason: text(req.body?.reason) }));
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message || 'Failed to reject changeset' });
    }
  });

  app.get('/api/profile-journal-db/diagnostics', (req, res) => {
    try {
      return res.json(getProfileJournalDbDiagnostics({
        limit: Number(req.query.limit || 10),
        autoClean: req.query.auto_clean !== 'false'
      }));
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message || 'Failed to diagnose profile journal db' });
    }
  });

  app.post('/api/profile-journal-db/clean', (req, res) => {
    try {
      const profile = cleanProfileFacts({ userId: text(req.body?.user_id || req.body?.userId) });
      const journal = cleanJournalEntries({ userId: text(req.body?.user_id || req.body?.userId) });
      return res.json({
        ok: profile.ok !== false && journal.ok !== false,
        profile,
        journal,
        diagnostics: getProfileJournalDbDiagnostics({ limit: 10 })
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message || 'Failed to clean profile journal db' });
    }
  });
}

module.exports = {
  registerMemoryV3NocturneRoutes
};
