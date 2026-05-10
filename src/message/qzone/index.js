function shouldAutoDraftQzonePostRequest(route = {}, cleanText = '', detectQzonePostDraftMode = null) {
  if (typeof detectQzonePostDraftMode !== 'function') return true;
  return detectQzonePostDraftMode(route, cleanText) !== 'manual';
}

function buildQzoneAutodraftPrompt(requestText = '') {
  return [
    '你现在只负责代写一条可以直接发布到 QQ 空间的中文正文。',
    '必须使用第一人称，语气自然，像今天写的日记或状态。',
    '优先根据用户原话推断主题、心情、长度和风格。',
    '默认写成 80 到 180 字。',
    '不要解释，不要提问，不要使用标题、项目符号、引号、标签或前缀。',
    '不要提到自己是 AI。',
    '只输出最终可发布正文。',
    `用户请求: ${String(requestText || '').trim()}`
  ].join('\n');
}

module.exports = {
  buildQzoneAutodraftPrompt,
  shouldAutoDraftQzonePostRequest
};
