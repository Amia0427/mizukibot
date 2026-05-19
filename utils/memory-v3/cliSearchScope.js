const { getAccessibleGroupIdsForUser } = require('../memoryScopeIndex');
const { normalizeText } = require('./helpers');

function toSafeNumber(value, fallback = 0) {
  const num = Number(value || 0);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeArray(values) {
  return Array.isArray(values) ? values : [];
}

function resolveSourceCandidates(snapshot, source = 'all', context = {}) {
  const userId = normalizeText(context.userId);
  const groupId = normalizeText(context.groupId);
  const sessionKey = normalizeText(context.sessionKey || context.sessionId);
  const accessibleGroups = Array.from(new Set([
    ...normalizeArray(context.groupIds),
    ...getAccessibleGroupIdsForUser(userId),
    groupId
  ].map((item) => normalizeText(item)).filter(Boolean)));
  const allowedGroupOwners = new Set(accessibleGroups.map((item) => `group:${item}`));
  const sourceIds = normalizeArray(snapshot.docIdsBySource.get(source));
  const ownerIds = new Set([
    ...normalizeArray(snapshot.docIdsByUser.get(userId)),
    ...normalizeArray(snapshot.docIdsByOwner.get(userId))
  ]);

  if (source === 'group' || source === 'jargon') {
    return sourceIds.filter((id) => {
      const doc = snapshot.docsById.get(id);
      if (!doc) return false;
      return allowedGroupOwners.has(normalizeText(doc.userId)) || accessibleGroups.includes(normalizeText(doc.groupId));
    });
  }

  if (source === 'notebook') {
    return sourceIds.filter((id) => {
      const doc = snapshot.docsById.get(id);
      if (!doc) return false;
      if (normalizeText(doc.scopeType) === 'group') {
        return accessibleGroups.includes(normalizeText(doc.groupId));
      }
      return normalizeText(doc.userId) === userId || normalizeText(doc.ownerUserId) === userId;
    });
  }

  if (source === 'recent') {
    const sessionIds = sessionKey ? normalizeArray(snapshot.docIdsBySession.get(sessionKey)) : [];
    const merged = sourceIds.concat(sessionIds);
    return Array.from(new Set(merged.filter((id) => {
      const doc = snapshot.docsById.get(id);
      return doc && normalizeText(doc.userId) === userId;
    })));
  }

  return sourceIds.filter((id) => ownerIds.has(id) || (() => {
    const doc = snapshot.docsById.get(id);
    return doc && normalizeText(doc.userId) === userId;
  })());
}

function docMatchesOpenScope(doc = {}, context = {}) {
  const userId = normalizeText(context.userId);
  if (!userId) return false;
  if (doc.source === 'group' || doc.source === 'jargon') {
    const accessible = new Set(getAccessibleGroupIdsForUser(userId).map((item) => normalizeText(item)).filter(Boolean));
    if (normalizeText(context.groupId)) accessible.add(normalizeText(context.groupId));
    return accessible.has(normalizeText(doc.groupId));
  }
  if (doc.source === 'notebook' && normalizeText(doc.scopeType) === 'group') {
    const accessible = new Set(getAccessibleGroupIdsForUser(userId).map((item) => normalizeText(item)).filter(Boolean));
    if (normalizeText(context.groupId)) accessible.add(normalizeText(context.groupId));
    return accessible.has(normalizeText(doc.groupId));
  }
  return normalizeText(doc.userId) === userId || normalizeText(doc.ownerUserId) === userId;
}

function resolveDocByOpenTarget(snapshot, target = {}, context = {}) {
  const ref = normalizeText(target.ref);
  const source = normalizeText(target.source).toLowerCase();
  const id = normalizeText(target.id);

  let doc = null;
  if (ref) {
    if (ref.startsWith('mc_ref:notebook:')) {
      const suffix = ref.replace(/^mc_ref:notebook:/, '');
      const [docId, chunkIndexRaw] = suffix.split(':');
      doc = snapshot.docsById.get(`notebook:${docId}:${toSafeNumber(chunkIndexRaw, 0)}`);
    } else {
      const match = ref.match(/^mc_ref:([a-z_]+):(.+)$/i);
      if (match) {
        const refSource = normalizeText(match[1]).toLowerCase();
        const refId = String(match[2] || '').trim();
        if (refSource === 'notebook') {
          const [docId, chunkIndexRaw] = refId.split(':');
          doc = snapshot.docsById.get(`notebook:${docId}:${toSafeNumber(chunkIndexRaw, 0)}`);
        } else if (snapshot.docsById.has(refId)) {
          doc = snapshot.docsById.get(refId);
        } else if (refSource === 'recent') {
          doc = snapshot.docsById.get(`session:${refId}`);
        } else if (refSource === 'journal' && snapshot.docsById.has(`episode:${refId}`)) {
          doc = snapshot.docsById.get(`episode:${refId}`);
        }
      }
    }
  }

  if (!doc && source && id) {
    if (source === 'notebook') {
      doc = snapshot.docsById.get(`notebook:${id}:0`) || null;
    } else if (snapshot.docsById.has(id)) {
      doc = snapshot.docsById.get(id);
    } else if (source === 'recent') {
      doc = snapshot.docsById.get(`session:${id}`) || null;
    } else if (source === 'journal') {
      doc = snapshot.docsById.get(`episode:${id}`) || null;
    }
  }

  if (!doc) return null;
  if (!docMatchesOpenScope(doc, context)) return null;
  return doc;
}

module.exports = {
  docMatchesOpenScope,
  resolveDocByOpenTarget,
  resolveSourceCandidates
};
