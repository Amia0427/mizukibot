const { createMaimaiPlayerService } = require('./player-service');

function parseMaimaiCommand(rawText = '') {
  const text = String(rawText || '').trim();
  const match = text.match(/^\/mai(?:\s+|$)(.*)$/i);
  if (!match) return null;
  const tokens = match[1].trim().split(/\s+/).filter(Boolean);
  return { command: String(tokens.shift() || 'status').toLowerCase(), args: tokens };
}

function createMaimaiCommandHandler(options = {}) {
  const getRuntime = options.getRuntime;
  const sendReply = options.sendReply;
  const isAdmin = options.isAdmin || (() => false);
  const playerService = options.playerService || createMaimaiPlayerService();

  function shouldHandle(rawText) {
    return Boolean(parseMaimaiCommand(rawText));
  }

  async function reply(msg, text) {
    if (typeof sendReply === 'function') await sendReply(msg, String(text || ''));
  }

  async function handle(msg = {}) {
    const parsed = parseMaimaiCommand(msg.raw_message);
    if (!parsed) return false;
    const userId = String(msg.user_id || '').trim();
    const chatType = String(msg.message_type || '').trim().toLowerCase();
    const privateChat = chatType === 'private';
    const runtime = getRuntime?.();
    if (!runtime) {
      await reply(msg, '舞萌功能当前未启用。');
      return true;
    }
    if (parsed.command === 'bind') {
      if (!privateChat) { await reply(msg, '为了保护 Import-Token，/mai bind 只能私聊使用。'); return true; }
      const token = String(parsed.args[0] || '').trim();
      if (!token) { await reply(msg, '用法：/mai bind <Import-Token>'); return true; }
      try {
        const result = await playerService.bind(userId, token, { playerStore: runtime.playerStore, catalog: runtime.catalog });
        await reply(msg, `舞萌账号已绑定，已验证并保存 ${result.recordCount} 条成绩。`);
      } catch (_) {
        await reply(msg, '绑定验证失败，Import-Token 未保存，请确认令牌有效后重试。');
      }
      return true;
    }
    if (parsed.command === 'unbind') {
      runtime.playerStore.unbind(userId);
      await reply(msg, '已解绑并清理本地舞萌凭据、成绩快照和弱项推断。');
      return true;
    }
    if (parsed.command === 'status') {
      const active = runtime.catalog.getActiveGeneration();
      await reply(msg, runtime.playerStore.isBound(userId)
        ? `已绑定；谱面数据版本 ${active?.sourceRevision || '暂无'}，同步时间 ${active?.finishedAt || '暂无'}。`
        : `未绑定；谱面数据版本 ${active?.sourceRevision || '暂无'}。`);
      return true;
    }
    if (parsed.command === 'refresh') {
      try {
        const result = await playerService.refresh(userId, { playerStore: runtime.playerStore, catalog: runtime.catalog });
        await reply(msg, `成绩已刷新，共 ${result.recordCount} 条，抓取时间 ${result.fetchedAt}。`);
      } catch (_) {
        const fallback = runtime.playerStore.getLatestSnapshot(userId);
        await reply(msg, fallback.status === 'missing' ? '刷新失败且没有可用快照，请重新绑定。' : `刷新失败，继续使用 ${fallback.fetchedAt} 的上一份成绩快照。`);
      }
      return true;
    }
    if (parsed.command === 'sync') {
      if (!isAdmin(userId)) { await reply(msg, '只有管理员可以触发舞萌谱面同步。'); return true; }
      if (parsed.args[0] === 'status') {
        const lastRun = runtime.catalog.getLastSyncRun?.();
        const schedulerState = runtime.syncScheduler?.getState?.();
        await reply(msg, `同步状态：${lastRun?.status || '暂无'}；最近运行 ${lastRun?.finished_at || lastRun?.started_at || '暂无'}${schedulerState?.active ? '；当前正在同步' : ''}。`);
        return true;
      }
      const trigger = runtime.syncScheduler?.trigger?.('admin_command') || {
        status: 'started',
        promise: runtime.syncWorker.runOnce()
      };
      if (trigger.status === 'already_running') {
        await reply(msg, '舞萌谱面同步已在运行中，请稍后查看状态。');
        return true;
      }
      void Promise.resolve(trigger.promise).catch(() => {});
      await reply(msg, '舞萌谱面同步已在后台启动。');
      return true;
    }
    await reply(msg, '用法：/mai bind <Import-Token>、/mai unbind、/mai status、/mai refresh；管理员可用 /mai sync。');
    return true;
  }

  return { handle, shouldHandle };
}

module.exports = { createMaimaiCommandHandler, parseMaimaiCommand };
