const {
  clampText,
  normalizeText
} = require('./helpers');
const { buildSnapshot } = require('./cliSearchSnapshot');
const {
  docMatchesOpenScope
} = require('./cliSearchScope');
const {
  normalizeNamespace,
  normalizeUri,
  resolveMemoryAlias
} = require('./aliasIndex');
const {
  formatTriggerGlossary,
  matchMemoryTriggers
} = require('./triggerGlossary');

function encodePathPart(value = '') {
  return encodeURIComponent(normalizeText(value)).replace(/%2F/gi, '_');
}

function decodePathPart(value = '') {
  try {
    return decodeURIComponent(String(value || ''));
  } catch (_) {
    return String(value || '');
  }
}

function parseMemoryUri(uri = '') {
  const raw = normalizeUri(uri);
  const match = raw.match(/^([a-z][a-z0-9_-]*):\/\/(.*)$/i);
  if (!match) return { ok: false, uri: raw, scheme: '', path: '', parts: [], reason: 'invalid_uri' };
  const scheme = normalizeText(match[1]).toLowerCase();
  const rest = String(match[2] || '').replace(/^\/+/, '');
  const parts = rest.split('/').map(decodePathPart).filter((item) => item !== '');
  return { ok: true, uri: raw, scheme, path: rest, parts };
}

function uriForDoc(doc = {}) {
  const source = normalizeText(doc.source).toLowerCase();
  const userId = encodePathPart(doc.ownerUserId || doc.userId || 'unknown');
  const groupId = encodePathPart(doc.groupId || doc.ownerUserId || doc.userId || 'unknown');
  const id = encodePathPart(doc.id || doc.refId || '');
  if (!id) return '';
  if (source === 'group' || source === 'jargon') return `group://${groupId}/memory/${id}`;
  if (source === 'journal') return `journal://user/${userId}/${id.replace(/^episode%3A/i, '')}`;
  if (source === 'image') return `image://user/${userId}/${id}`;
  if (source === 'profile') return `core://user/${userId}/profile/${encodePathPart(doc.fieldKey || doc.type || 'profile')}/${id}`;
  if (source === 'recent') return `core://user/${userId}/recent/${id}`;
  if (source === 'task') return `core://user/${userId}/task/${id}`;
  if (source === 'notebook') return `core://user/${userId}/notebook/${id}`;
  return `core://user/${userId}/memory/${id}`;
}

function docRefForUriParts(parsed = {}) {
  const parts = parsed.parts || [];
  if (parsed.scheme === 'core') {
    const userId = normalizeText(parts[1]);
    const kind = normalizeText(parts[2]).toLowerCase();
    const rest = parts.slice(3).join('/');
    if (parts[0] !== 'user' || !userId || !kind) return null;
    if (kind === 'profile') {
      const [fieldKey, ...idParts] = parts.slice(3);
      return { source: 'profile', userId, fieldKey, id: idParts.join('/') };
    }
    if (kind === 'recent') return { source: 'recent', id: rest };
    if (kind === 'task') return { source: 'task', id: rest };
    if (kind === 'notebook') return { source: 'notebook', id: rest };
    if (kind === 'memory') return { source: 'personal', id: rest };
  }
  if (parsed.scheme === 'group') {
    const groupId = normalizeText(parts[0]);
    const id = parts.slice(2).join('/');
    if (!groupId || parts[1] !== 'memory' || !id) return null;
    return { source: 'group', groupId, id };
  }
  if (parsed.scheme === 'journal') {
    const userId = normalizeText(parts[1]);
    const id = parts.slice(2).join('/');
    if (parts[0] !== 'user' || !userId || !id) return null;
    return { source: 'journal', userId, id };
  }
  if (parsed.scheme === 'image') {
    const userId = normalizeText(parts[1]);
    const id = parts.slice(2).join('/');
    if (parts[0] !== 'user' || !userId || !id) return null;
    return { source: 'image', userId, id };
  }
  return null;
}

function findDocByUri(snapshot, uri = '', context = {}, options = {}) {
  const namespace = normalizeNamespace(options.namespace || context.namespace);
  const alias = resolveMemoryAlias(uri, { namespace });
  const targetUri = alias ? alias.targetUri : uri;
  const parsed = parseMemoryUri(targetUri);
  if (!parsed.ok) return { ok: false, reason: parsed.reason, alias, targetUri };
  if (parsed.scheme === 'system' && parsed.parts[0] === 'glossary') {
    return {
      ok: true,
      alias,
      targetUri,
      system: {
        uri: targetUri,
        type: 'glossary',
        text: formatTriggerGlossary({ namespace })
      }
    };
  }
  const ref = docRefForUriParts(parsed);
  if (!ref) return { ok: false, reason: 'unsupported_uri', alias, targetUri };

  const docs = Array.from(snapshot.docsById.values());
  const lowerId = normalizeText(ref.id).toLowerCase();
  let candidates = docs;
  if (ref.userId) candidates = candidates.filter((doc) => normalizeText(doc.userId) === ref.userId || normalizeText(doc.ownerUserId) === ref.userId);
  if (ref.groupId) candidates = candidates.filter((doc) => normalizeText(doc.groupId) === ref.groupId || normalizeText(doc.ownerUserId) === ref.groupId);
  if (ref.source) {
    if (ref.source === 'personal') {
      candidates = candidates.filter((doc) => doc.source === 'personal' || doc.source === 'profile');
    } else {
      candidates = candidates.filter((doc) => doc.source === ref.source);
    }
  }
  let doc = null;
  if (ref.fieldKey) {
    const key = normalizeText(ref.fieldKey).toLowerCase();
    const wantedId = normalizeText(ref.id).toLowerCase();
    doc = wantedId
      ? candidates.find((item) => normalizeText(item.id).toLowerCase() === wantedId && normalizeText(item.fieldKey || item.type).toLowerCase() === key)
      : null;
    doc = doc
      || candidates.find((item) => normalizeText(item.fieldKey || item.type).toLowerCase() === key)
      || candidates.find((item) => normalizeText(item.id).toLowerCase().includes(key));
  } else if (lowerId) {
    doc = candidates.find((item) => normalizeText(item.id).toLowerCase() === lowerId)
      || candidates.find((item) => normalizeText(item.id).toLowerCase() === lowerId.replace(/^episode:/, ''))
      || candidates.find((item) => normalizeText(item.id).toLowerCase() === `episode:${lowerId}`)
      || candidates.find((item) => normalizeText(uriForDoc(item)).toLowerCase() === normalizeUri(targetUri).toLowerCase());
  }
  if (!doc) return { ok: false, reason: 'not_found', alias, targetUri };
  if (!docMatchesOpenScope(doc, context)) return { ok: false, reason: 'scope_denied', alias, targetUri };
  return { ok: true, doc, alias, targetUri };
}

function formatDocRead(doc = {}, meta = {}) {
  const uri = meta.uri || uriForDoc(doc);
  const title = normalizeText(doc.title || doc.type || doc.source || 'memory');
  const lines = [
    `URI: ${uri}`,
    `Source: ${doc.source || '-'} | Type: ${doc.type || '-'} | Status: ${doc.status || 'active'}`,
    doc.category ? `Category: ${doc.category}${Array.isArray(doc.tags) && doc.tags.length ? ` | Tags: ${doc.tags.join(',')}` : ''}` : '',
    doc.updatedAt ? `Updated: ${new Date(Number(doc.updatedAt)).toISOString()}` : '',
    meta.alias ? `Alias: ${meta.alias.aliasUri} -> ${meta.alias.targetUri}` : '',
    '',
    `# ${title}`,
    clampText(doc.openPayload?.text || doc.text || doc.preview || '', meta.maxChars || 4000)
  ].filter((line) => line !== '');
  return lines.join('\n');
}

function readMemoryUri(uri = '', context = {}, options = {}) {
  const snapshot = options.snapshot || buildSnapshot();
  const found = findDocByUri(snapshot, uri, context, options);
  if (!found.ok) return { ok: false, uri: normalizeUri(uri), reason: found.reason, targetUri: found.targetUri || '' };
  if (found.system) {
    return {
      ok: true,
      uri: found.system.uri,
      source: 'system',
      type: found.system.type,
      text: found.system.text,
      data: found.system
    };
  }
  const docUri = uriForDoc(found.doc);
  return {
    ok: true,
    uri: docUri,
    requestedUri: normalizeUri(uri),
    targetUri: found.targetUri,
    alias: found.alias,
    source: found.doc.source,
    id: found.doc.id,
    text: formatDocRead(found.doc, { uri: docUri, alias: found.alias, maxChars: options.maxChars }),
    data: found.doc.openPayload || found.doc
  };
}

function buildMemoryUriTree(context = {}, options = {}) {
  const snapshot = options.snapshot || buildSnapshot();
  const docs = Array.from(snapshot.docsById.values())
    .filter((doc) => docMatchesOpenScope(doc, context))
    .map((doc) => ({
      uri: uriForDoc(doc),
      source: doc.source,
      type: doc.type,
      title: doc.title || doc.type || doc.source,
      preview: doc.preview || '',
      updatedAt: doc.updatedAt || 0,
      category: doc.category || '',
      tags: Array.isArray(doc.tags) ? doc.tags : []
    }))
    .filter((item) => item.uri)
    .sort((a, b) => String(a.uri).localeCompare(String(b.uri)));
  return {
    ok: true,
    namespace: normalizeNamespace(options.namespace || context.namespace),
    count: docs.length,
    items: docs.slice(0, Math.max(1, Number(options.limit || 200) || 200))
  };
}

function searchMemoryUris(query = '', context = {}, options = {}) {
  const snapshot = options.snapshot || buildSnapshot();
  const q = normalizeText(query).toLowerCase();
  const triggerMatches = matchMemoryTriggers(query, {
    namespace: options.namespace || context.namespace,
    limit: options.triggerLimit || 8
  });
  const docs = Array.from(snapshot.docsById.values())
    .filter((doc) => docMatchesOpenScope(doc, context))
    .filter((doc) => {
      if (!q) return true;
      return normalizeText(`${doc.title} ${doc.text} ${doc.preview} ${doc.category} ${Array.isArray(doc.tags) ? doc.tags.join(' ') : ''}`).toLowerCase().includes(q);
    })
    .map((doc) => ({
      uri: uriForDoc(doc),
      source: doc.source,
      type: doc.type,
      title: doc.title || doc.type || doc.source,
      preview: doc.preview || clampText(doc.text, 160),
      updatedAt: doc.updatedAt || 0,
      category: doc.category || '',
      matchMode: q ? 'uri_text' : 'browse'
    }))
    .filter((item) => item.uri);
  const byUri = new Map();
  for (const trigger of triggerMatches) {
    byUri.set(trigger.uri, {
      uri: trigger.uri,
      source: 'trigger',
      type: 'trigger',
      title: trigger.keyword,
      preview: trigger.disclosure || '',
      updatedAt: trigger.updatedAt || 0,
      category: 'trigger',
      matchMode: 'trigger'
    });
  }
  for (const doc of docs) if (!byUri.has(doc.uri)) byUri.set(doc.uri, doc);
  const items = Array.from(byUri.values()).sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  return { ok: true, query: normalizeText(query), count: items.length, triggerMatches, items: items.slice(0, Math.max(1, Number(options.limit || 20) || 20)) };
}

module.exports = {
  buildMemoryUriTree,
  findDocByUri,
  parseMemoryUri,
  readMemoryUri,
  searchMemoryUris,
  uriForDoc
};
