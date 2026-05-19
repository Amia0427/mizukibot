const ADMIN_PREFIX = '/';

function parsePayloadCommand(t = '', pattern, cmd, splitArgs = false) {
  const payload = String(t || '').replace(pattern, '').trim();
  return {
    cmd,
    args: payload ? (splitArgs ? payload.split(/\s+/).filter(Boolean) : [payload]) : [],
    raw: t,
    payload
  };
}

function parseToggleCommand(t = '', pattern, cmd) {
  const payload = String(t || '').replace(pattern, '').trim();
  const args = payload ? payload.split(/\s+/).filter(Boolean) : [];
  return {
    cmd,
    args,
    raw: t,
    payload: args.join(' ').trim()
  };
}

function parseAdminCommand(cleanText = '') {
  const t = String(cleanText || '').trim();
  if (!t.startsWith(ADMIN_PREFIX)) return null;

  if (/^\/full(?:\s|$)/i.test(t)) return parsePayloadCommand(t, /^\/full/i, 'full');
  if (/^\/claude(?:\s|$)/i.test(t)) return parsePayloadCommand(t, /^\/claude/i, 'claude');
  if (/^\/claude-open(?:\s|$)/i.test(t)) return parsePayloadCommand(t, /^\/claude-open/i, 'claude-open');
  if (/^\/claude-send(?:\s|$)/i.test(t)) return parsePayloadCommand(t, /^\/claude-send/i, 'claude-send');
  if (/^\/claude-tail(?:\s|$)/i.test(t)) return parsePayloadCommand(t, /^\/claude-tail/i, 'claude-tail');
  if (/^\/claude-stop(?:\s|$)/i.test(t)) return parsePayloadCommand(t, /^\/claude-stop/i, 'claude-stop');
  if (/^\/create(?:\s|$)/i.test(t)) return parsePayloadCommand(t, /^\/create/i, 'create');

  if (/^\/meme(?:\s|$)/i.test(t)) {
    return { cmd: 'meme', args: t.split(/\s+/).slice(1), raw: t };
  }

  if (/^\/qzone_post(?:\s|$)/i.test(t)) return parsePayloadCommand(t, /^\/qzone_post/i, 'qzone_post');
  if (/^\/schedule_create(?:\s|$)/i.test(t)) return parsePayloadCommand(t, /^\/schedule_create/i, 'schedule_create');
  if (/^\/schedule_list(?:\s|$)/i.test(t)) return parsePayloadCommand(t, /^\/schedule_list/i, 'schedule_list');
  if (/^\/schedule_cancel(?:\s|$)/i.test(t)) return parsePayloadCommand(t, /^\/schedule_cancel/i, 'schedule_cancel');
  if (/^\/schedule_delete(?:\s|$)/i.test(t)) return parsePayloadCommand(t, /^\/schedule_delete/i, 'schedule_delete');
  if (/^\/hapi(?:\s|$)/i.test(t)) return parsePayloadCommand(t, /^\/hapi/i, 'hapi', true);
  if (/^\/memoryops(?:\s|$)/i.test(t)) return parsePayloadCommand(t, /^\/memoryops/i, 'memoryops', true);
  if (/^\/check(?:\s|$)/i.test(t)) return parsePayloadCommand(t, /^\/check/i, 'check', true);

  if (/^\/learn(?:\s|$)/i.test(t)) {
    const payload = t.replace(/^\/learn/i, '').trim();
    const parts = payload.split(/\s+/).filter(Boolean);
    const subcmd = String(parts[0] || '').trim().toLowerCase();
    if (!subcmd) {
      return {
        cmd: 'learn',
        args: [],
        raw: t,
        payload: ''
      };
    }
    if (subcmd === 'recent' || subcmd === 'patterns' || subcmd === 'rules' || subcmd === 'style' || subcmd === 'social' || subcmd === 'graph') {
      return {
        cmd: `learn_${subcmd}`,
        args: parts.slice(1),
        raw: t,
        payload: parts.slice(1).join(' ').trim()
      };
    }
    if (subcmd === 'search') {
      return {
        cmd: 'learn_search',
        args: parts.slice(1),
        raw: t,
        payload: payload.replace(/^search\s+/i, '').trim()
      };
    }
    if (subcmd === 'guide') {
      return {
        cmd: 'learn_guide',
        args: parts.slice(1),
        raw: t,
        payload: payload.replace(/^guide\s+/i, '').trim()
      };
    }
    return {
      cmd: 'learn_unknown',
      args: parts.slice(1),
      raw: t,
      payload
    };
  }

  if (/^\/group_public(?:\s|$)/i.test(t)) return parseToggleCommand(t, /^\/group_public/i, 'group_public');
  if (/^\/main_stream(?:\s|$)/i.test(t)) return parseToggleCommand(t, /^\/main_stream/i, 'main_stream');

  const parts = t.slice(ADMIN_PREFIX.length).trim().split(/\s+/);
  const cmd = (parts[0] || '').toLowerCase();
  const args = parts.slice(1);
  const supported = new Set(['debug', 'status', 'reload', 'help', 'hapi', 'memoryops', 'check']);

  if (!supported.has(cmd)) return { cmd: 'unknown', args, raw: t };
  return { cmd, args, raw: t };
}

module.exports = {
  ADMIN_PREFIX,
  parseAdminCommand
};
