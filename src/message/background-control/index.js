function normalizeControlText(text = '') {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripLeadingSlashCommandPrefix(text = '') {
  return String(text || '').replace(/^\/+/, '').trim();
}

function buildBackgroundAckText() {
  return '这类任务我先在后台跑。你可以随时发“任务状态”“取消任务”“结束任务”，或用“任务补充 ...”追加要求。';
}

function buildNoTaskControlText() {
  return '当前没有可控制的后台任务。';
}

function buildSessionStatusReply(session = {}, activeTask = null) {
  if (activeTask) {
    const summary = String(activeTask.latest_summary || '').trim();
    const summaryLine = summary ? `最近摘要：${summary}` : '最近摘要：还在处理中。';
    return [
      `当前任务状态：${activeTask.status || 'running'} / ${activeTask.stage || 'running'}`,
      `最近更新时间：${String(activeTask.updated_at || '').trim() || 'unknown'}`,
      summaryLine
    ].join('\n');
  }

  if (session && String(session.status || '').trim() === 'retained') {
    const summary = String(session.latest_summary || session.latest_result_excerpt || '').trim();
    return summary
      ? `当前没有运行中的后台任务。\n最近一次结果：${summary}\n如果要继续，可以发“任务补充 ...”。`
      : '当前没有运行中的后台任务。如果要继续，可以发“任务补充 ...”。';
  }

  return buildNoTaskControlText();
}

function parseBackgroundControlCommand(text = '') {
  const normalized = normalizeControlText(text);
  if (!normalized) return null;
  const plain = stripLeadingSlashCommandPrefix(normalized);
  if (!plain) return null;
  if (plain === '任务状态') return { type: 'status', payload: '' };
  if (plain === '取消任务') return { type: 'cancel', payload: '' };
  if (plain === '结束任务') return { type: 'close', payload: '' };
  if (/^任务(?:补充|继续)\s+/i.test(plain)) {
    return {
      type: 'supplement',
      payload: plain.replace(/^任务(?:补充|继续)\s+/i, '').trim()
    };
  }
  if (plain === '任务补充' || plain === '任务继续') {
    return { type: 'supplement', payload: '' };
  }
  return null;
}

function buildSupplementedTaskText(session = {}, supplement = '') {
  const parts = [];
  const originalText = String(session?.original_text || '').trim();
  const latestSummary = String(session?.latest_summary || session?.latest_result_excerpt || '').trim();
  const cleanSupplement = String(supplement || '').trim();

  if (originalText) parts.push(`原始请求：${originalText}`);
  if (latestSummary) parts.push(`最近结果摘要：${latestSummary}`);
  if (cleanSupplement) parts.push(`补充要求：${cleanSupplement}`);

  return parts.join('\n');
}

module.exports = {
  buildBackgroundAckText,
  buildNoTaskControlText,
  buildSessionStatusReply,
  buildSupplementedTaskText,
  normalizeControlText,
  parseBackgroundControlCommand,
  stripLeadingSlashCommandPrefix
};
