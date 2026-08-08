'use strict';

const { normalizeText } = require('./definitions');
const { formatCharacterState, formatPublicRelationship } = require('./format');

function classifyVariableQuery(text = '') {
  const value = normalizeText(text, 240);
  if (/^\/关系(?:\s|$)/i.test(value)) return 'relationship';
  if (/(?:我们|咱们|我和你|我对你).{0,8}(?:什么关系|算什么|怎么看我|熟不熟)|(?:你觉得|你怎么看)我(?:们)?(?:之间)?/i.test(value)) return 'relationship';
  if (/(?:你现在|你目前|瑞希现在).{0,8}(?:心情|状态|累不累|压力|精力)|(?:心情|状态|精力|压力).{0,5}(?:怎么样|如何|还好吗)/i.test(value)) return 'character';
  return '';
}

function resolveVariableQueryReply({ text = '', privateChat = false, snapshot = {} } = {}) {
  const kind = classifyVariableQuery(text);
  if (!kind) return { handled: false, kind: '', replyText: '' };
  if (kind === 'relationship' && !privateChat) {
    return { handled: true, kind, replyText: '这种关系话题我只在私聊里说。' };
  }
  return {
    handled: true,
    kind,
    replyText: kind === 'relationship' ? formatPublicRelationship(snapshot) : formatCharacterState(snapshot)
  };
}

module.exports = {
  classifyVariableQuery,
  resolveVariableQueryReply
};
