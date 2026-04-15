const {
  addMemoryItem,
  retrieveRelevantMemories,
  retrieveRelevantMemoriesAsync
} = require('./vectorMemory');

function sanitizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function addGroupMemory(groupId, text, type = 'fact', meta = {}, weight = 1.0) {
  const gid = sanitizeText(groupId);
  const content = sanitizeText(text);
  if (!gid || !content) return null;

  return addMemoryItem(
    `group:${gid}`,
    content,
    type,
    {
      ...meta,
      scopeType: 'group',
      groupId: gid,
      source: meta?.source || 'group_extractor'
    },
    weight
  );
}

function retrieveRelevantGroupMemoriesSync(groupId, query, topK = 4, options = {}) {
  const gid = sanitizeText(groupId);
  if (!gid) return [];

  return retrieveRelevantMemories(`group:${gid}`, query, topK, {
    ...options,
    scopeType: 'group',
    groupId: gid
  });
}

async function retrieveRelevantGroupMemories(groupId, query, topK = 4, options = {}) {
  const gid = sanitizeText(groupId);
  if (!gid) return [];

  return retrieveRelevantMemoriesAsync(`group:${gid}`, query, topK, {
    ...options,
    scopeType: 'group',
    groupId: gid
  });
}

function formatGroupMemories(hits = [], options = {}) {
  const list = Array.isArray(hits) ? hits : [];
  if (list.length === 0) return String(options.emptyText || '暂无相关群共享记忆');

  return list
    .map((item, index) => `${index + 1}. [group|${item.type}] ${item.text}`)
    .join('\n');
}

function formatGroupMemoriesCompat(hits = [], options = {}) {
  const list = Array.isArray(hits) ? hits : [];
  if (list.length === 0 && Object.prototype.hasOwnProperty.call(options, 'emptyText')) {
    return String(options.emptyText || '');
  }
  return formatGroupMemories(hits, options);
}

module.exports = {
  addGroupMemory,
  retrieveRelevantGroupMemoriesSync,
  retrieveRelevantGroupMemories,
  formatGroupMemories: formatGroupMemoriesCompat
};
