const QQ_ONLY_TOOLS = new Set([
  'publish_qzone',
  'qzone_draft',
  'create_qzone_auto_task'
]);

function isQqPlatform(value) {
  return String(value || 'qq').trim().toLowerCase() === 'qq';
}

function filterToolsForPlatform(toolNames = [], platform = 'qq') {
  const tools = Array.isArray(toolNames) ? toolNames : [];
  return isQqPlatform(platform)
    ? tools
    : tools.filter((toolName) => !QQ_ONLY_TOOLS.has(String(toolName || '').trim()));
}

function isQqOnlyCommand(text = '') {
  return /^\/(?:qzone_post)(?:\s|$)/i.test(String(text || '').trim());
}

function shouldRunPassiveAwareness(message = {}) {
  return isQqPlatform(message.platform) || message.allowPassiveContext === true;
}

module.exports = {
  filterToolsForPlatform,
  isQqOnlyCommand,
  isQqPlatform,
  shouldRunPassiveAwareness,
  QQ_ONLY_TOOLS
};
