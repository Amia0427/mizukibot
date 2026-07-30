const GROUP_MEMORY_SOURCES = new Set(['group', 'jargon']);
const PRIVATE_MEMORY_SOURCES = new Set(['profile', 'personal', 'task', 'style', 'journal']);

function clipText(value = '', maxChars = 240) {
  return Array.from(String(value || '').trim()).slice(0, maxChars).join('');
}

function readMemoryText(item = {}) {
  return clipText(item.text || item.content || item.summary || '');
}

function selectMemoryTexts(results = [], options = {}) {
  const chatType = String(options.chatType || '').trim().toLowerCase();
  const limit = Math.max(1, Number(options.limit) || 8);
  const seen = new Set();
  const selected = [];
  for (const item of Array.isArray(results) ? results : []) {
    const source = String(item?.source || '').trim().toLowerCase();
    const allowed = chatType === 'group'
      ? GROUP_MEMORY_SOURCES.has(source)
      : PRIVATE_MEMORY_SOURCES.has(source);
    if (!allowed) continue;
    const text = readMemoryText(item);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    selected.push(text);
    if (selected.length >= limit) break;
  }
  return selected;
}

async function recallSmallTheaterMemories(input = {}, deps = {}) {
  const queryMemory = deps.queryMemory;
  const chatType = String(input.chatType || '').trim().toLowerCase();
  const userId = String(input.userId || '').trim();
  const groupId = String(input.groupId || '').trim();
  const topK = Math.max(1, Math.min(20, Number(input.topK) || 8));
  const query = String(input.query || '').trim();
  const request = chatType === 'group'
    ? {
        userId: `group:${groupId}`,
        groupId,
        groupIds: [groupId],
        scope: { groupId },
        facet: 'group',
        query,
        topK
      }
    : {
        userId,
        groupIds: [],
        query,
        topK
      };
  const result = await queryMemory(request);
  return selectMemoryTexts(result?.results, { chatType, limit: topK });
}

module.exports = {
  recallSmallTheaterMemories,
  selectMemoryTexts
};
