const {
  formatGroupMainModelStreamStatus,
  setGroupMainModelStreamEnabled,
  setGroupPublic
} = require('../../utils/groupMainModelStreamPolicy');
const { parseToggleSubcommand } = require('./helpers');

function handleGroupPublicAdminCommand(command = {}, groupId = '', senderId = '') {
  if (!String(groupId || '').trim()) return '仅群聊可用。';
  const subcommand = parseToggleSubcommand(command);
  if (subcommand === 'status') return formatGroupMainModelStreamStatus(groupId);
  if (subcommand === 'on') {
    setGroupPublic(groupId, true, senderId, Date.now());
    return '已开启当前群公开群标记。\n主模型流式默认已开启。\n如需关闭，请发送 /main_stream off';
  }
  if (subcommand === 'off') {
    setGroupPublic(groupId, false, senderId, Date.now());
    return '已关闭当前群公开群标记，并移除主模型流式配置。';
  }
  return '用法: /group_public on|off|status';
}

function handleMainStreamAdminCommand(command = {}, groupId = '', senderId = '') {
  if (!String(groupId || '').trim()) return '仅群聊可用。';
  const subcommand = parseToggleSubcommand(command);
  if (subcommand === 'status') return formatGroupMainModelStreamStatus(groupId);
  if (subcommand === 'on') {
    const result = setGroupMainModelStreamEnabled(groupId, true, senderId, Date.now());
    return result.ok ? '已开启当前群主模型流式。' : '请先 /group_public on';
  }
  if (subcommand === 'off') {
    const result = setGroupMainModelStreamEnabled(groupId, false, senderId, Date.now());
    return result.ok ? '已关闭当前群主模型流式。' : '请先 /group_public on';
  }
  return '用法: /main_stream on|off|status';
}

module.exports = {
  handleGroupPublicAdminCommand,
  handleMainStreamAdminCommand
};
