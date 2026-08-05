function normalizeText(value) {
  return String(value || '').trim();
}

function parseIdentityCommand(text = '') {
  const input = normalizeText(text);
  if (/^\/bindings(?:\s|$)/i.test(input)) return { action: 'list' };
  if (/^\/unbind\s+confirm\s*$/i.test(input)) return { action: 'unlink' };
  const bind = input.match(/^\/bind(?:\s+(.+))?$/i);
  if (!bind) return null;
  const value = normalizeText(bind[1]);
  if (!value || /^begin$/i.test(value)) return { action: 'begin' };
  return { action: 'consume', code: value.toUpperCase() };
}

function formatBindings(bindings = []) {
  if (!bindings.length) return '当前没有已绑定的平台账号。';
  return ['已绑定账号：', ...bindings.map((item) => `- ${item.platform}: ${item.externalUserId}`)].join('\n');
}

function createIdentityCommandHandler(options = {}) {
  const store = options.store;
  if (!store) throw new Error('identity store is required');

  function handle(input = {}) {
    const command = parseIdentityCommand(input.text);
    if (!command) return { handled: false };
    if (String(input.chatType || '').toLowerCase() !== 'private') {
      return { handled: true, replyText: '账号绑定只能在私聊中操作。' };
    }

    const identity = store.resolveIdentity(input.platform, input.externalUserId);
    if (command.action === 'begin') {
      const result = store.beginLink(input);
      return {
        handled: true,
        replyText: `绑定码：${result.code}\n10 分钟内在另一个平台私聊发送 /bind ${result.code}。绑定码只能使用一次。`
      };
    }
    if (command.action === 'consume') {
      const result = store.consumeLink({ ...input, code: command.code });
      const reasons = {
        invalid_code: '绑定码无效。',
        code_used: '绑定码已经使用过。',
        code_expired: '绑定码已过期，请重新生成。'
      };
      return {
        handled: true,
        replyText: result.ok ? `绑定完成。\n${formatBindings(result.bindings)}` : (reasons[result.reason] || '绑定失败。')
      };
    }
    if (command.action === 'list') {
      return { handled: true, replyText: formatBindings(store.listBindings(identity.principalId)) };
    }

    const result = store.unlink({ ...input, confirm: true });
    const reasons = {
      last_identity: '当前只有一个平台身份，无需解绑。',
      primary_identity_requires_admin: '当前身份是主身份，不能自助解绑。请先在其他平台重新绑定并联系管理员迁移主身份。'
    };
    return {
      handled: true,
      replyText: result.ok
        ? '当前平台账号已解绑。此前共享的历史不会复制到新身份。'
        : (reasons[result.reason] || '解绑失败。')
    };
  }

  return { handle };
}

module.exports = {
  createIdentityCommandHandler,
  formatBindings,
  parseIdentityCommand
};
