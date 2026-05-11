function sanitizeQzoneMemoryEvidenceItem(item = {}) {
  const source = String(item?.source || '').trim().toLowerCase();
  if (!source || source === 'group') return null;

  const summaryBase = source === 'recent'
    ? [item?.title, item?.preview, item?.shortTermSummary]
    : source === 'jargon'
      ? [item?.title, item?.type]
      : [item?.title, item?.preview, item?.text];

  const summary = maskSensitiveText(summaryBase.filter(Boolean).join(' | '), source === 'jargon' ? 90 : 180);
  if (!summary) return null;

  return {
    source,
    summary
  };
}

function sanitizeQzoneOpenedMemory(openPayload = {}, fallbackSource = '') {
  if (!openPayload || openPayload.ok !== true || openPayload.command !== 'open') return null;
  const source = String(openPayload.source || fallbackSource || '').trim().toLowerCase();
  if (!source || source === 'group') return null;
  const data = openPayload.data && typeof openPayload.data === 'object' ? openPayload.data : {};

  let summary = '';
  if (source === 'recent') {
    summary = maskSensitiveText([
      data.shortTermSummary,
      data.summary,
      data.title
    ].filter(Boolean).join(' | '), 180);
  } else if (source === 'jargon') {
    summary = maskSensitiveText([
      data.memoryKind,
      data.type,
      data.title
    ].filter(Boolean).join(' | '), 90);
  } else if (source === 'profile') {
    const profile = data.profile && typeof data.profile === 'object' ? data.profile : {};
    summary = maskSensitiveText([
      ...(Array.isArray(profile.likes) ? profile.likes.slice(0, 2) : []),
      ...(Array.isArray(profile.recent_topics) ? profile.recent_topics.slice(0, 2) : []),
      ...(Array.isArray(profile.personality_traits) ? profile.personality_traits.slice(0, 2) : []),
      data.summary,
      data.impression
    ].filter(Boolean).join(' | '), 180);
  } else {
    summary = maskSensitiveText([
      data.summary,
      data.impression,
      data.title,
      data.text
    ].filter(Boolean).join(' | '), 180);
  }

  if (!summary) return null;
  return { source, summary };
}

function sanitizeQzoneMemoryEvidence({
  searchPayload,
  openedMemory
} = {}) {
  const searchItems = (Array.isArray(searchPayload?.results) ? searchPayload.results : [])
    .map((item) => sanitizeQzoneMemoryEvidenceItem(item))
    .filter(Boolean);

  const digestItems = (Array.isArray(searchPayload?.digest) ? searchPayload.digest : [])
    .map((item) => maskSensitiveText(item, 140))
    .filter(Boolean)
    .slice(0, 4)
    .map((summary) => ({ source: 'digest', summary }));

  const evidenceItems = [];
  const seen = new Set();

  const pushItem = (item) => {
    if (!item?.summary) return;
    const key = `${item.source}:${item.summary}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    evidenceItems.push(item);
  };

  if (openedMemory) pushItem(openedMemory);
  searchItems.slice(0, 4).forEach(pushItem);
  digestItems.slice(0, 2).forEach(pushItem);

  return {
    items: evidenceItems.slice(0, 5),
    sources: Array.from(new Set(evidenceItems.map((item) => item.source).filter(Boolean)))
  };
}

function buildQzoneMemoryPromptBlock(memoryEvidence = {}) {
  const items = Array.isArray(memoryEvidence?.items) ? memoryEvidence.items : [];
  if (!items.length) return '';
  const lines = [
    '【可用记忆弱证据】',
    '这些内容只能作为背景倾向，不能复述原文，不能暴露来源，不能写成群聊细节。'
  ];
  items.forEach((item) => {
    lines.push(`- ${item.source}: ${item.summary}`);
  });
  return lines.join('\n');
}

