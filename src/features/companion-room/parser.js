const ALLOWED_DURATIONS = Object.freeze([15, 30, 45, 60, 120]);

function normalizeDuration(raw = '') {
  const text = String(raw || '').trim();
  if (!text) return null;
  if (/半(?:个)?小时/.test(text)) return 30;
  if (/^\d+$/.test(text)) {
    const minutes = Number(text);
    return ALLOWED_DURATIONS.includes(minutes) ? minutes : null;
  }
  const hours = text.match(/(\d+(?:\.\d+)?)\s*(?:个)?小时/);
  if (hours) {
    const minutes = Math.round(Number(hours[1]) * 60);
    return ALLOWED_DURATIONS.includes(minutes) ? minutes : null;
  }
  const minutes = text.match(/(\d+)\s*分钟/);
  if (minutes) {
    const value = Number(minutes[1]);
    return ALLOWED_DURATIONS.includes(value) ? value : null;
  }
  return null;
}

function parseCommand(text) {
  const command = text.match(/^\/陪伴(?:\s+(.*))?$/u);
  if (!command) return null;
  const args = String(command[1] || '').trim();
  if (!args || args === '状态') return { matched: true, action: 'status' };
  if (args === '暂停') return { matched: true, action: 'pause' };
  if (args === '继续') return { matched: true, action: 'resume' };
  if (args === '结束') return { matched: true, action: 'end' };
  if (args === '回忆') return { matched: true, action: 'memory_list' };
  const switchMatch = args.match(/^切换\s+(专注|放松)$/u);
  if (switchMatch) {
    return {
      matched: true,
      action: 'switch',
      activityType: switchMatch[1] === '专注' ? 'focus' : 'relax'
    };
  }
  const deleteMatch = args.match(/^回忆\s+删除\s+(\S+)$/u);
  if (deleteMatch) return { matched: true, action: 'memory_delete', memoryId: deleteMatch[1] };
  const updateMatch = args.match(/^回忆\s+修改\s+(\S+)\s+(.+)$/u);
  if (updateMatch) {
    return {
      matched: true,
      action: 'memory_update',
      memoryId: updateMatch[1],
      userNote: updateMatch[2].trim()
    };
  }
  const startMatch = args.match(/^开始\s+(专注|放松)(?:\s+(.+))?$/u);
  if (!startMatch) return { matched: true, action: 'usage' };
  const durationMinutes = normalizeDuration(startMatch[2]);
  if (startMatch[2] && !durationMinutes) return { matched: true, action: 'usage' };
  return {
    matched: true,
    action: 'start',
    activityType: startMatch[1] === '专注' ? 'focus' : 'relax',
    ...(durationMinutes ? { durationMinutes } : {})
  };
}

function parseCompanionRoomMessage(rawText = '', options = {}) {
  if (String(options.chatType || '').trim().toLowerCase() !== 'private') return { matched: false };
  const text = String(rawText || '').replace(/\s+/g, ' ').trim();
  if (!text) return { matched: false };
  const command = parseCommand(text);
  if (command) return command;
  if (/^(?:暂停陪伴|陪伴暂停)$/u.test(text)) return { matched: true, action: 'pause' };
  if (/^(?:继续陪伴|陪伴继续)$/u.test(text)) return { matched: true, action: 'resume' };
  if (/^(?:结束陪伴|陪伴结束|不陪了)$/u.test(text)) return { matched: true, action: 'end' };
  if (/^(?:安静一点|少说一点|先别说话)$/u.test(text)) {
    return { matched: true, action: 'density', density: 'quiet' };
  }
  if (/^(?:多陪我聊聊|多说一点|陪我说说话)$/u.test(text)) {
    return { matched: true, action: 'density', density: 'chatty' };
  }
  const switchMatch = text.match(/^切换到?(专注|放松)(?:陪伴)?$/u);
  if (switchMatch) {
    return {
      matched: true,
      action: 'switch',
      activityType: switchMatch[1] === '专注' ? 'focus' : 'relax'
    };
  }
  const start = text.match(/^陪我(?:一起)?(学习|工作|画画|写作|专注|放松|休息|发呆|睡觉|睡前)(.*)$/u);
  if (!start) return { matched: false };
  const suffix = start[2].trim();
  if (suffix && !/^(?:一下|一会儿?|会儿|半(?:个)?小时|\d+(?:\.\d+)?\s*(?:个)?小时|\d+\s*分钟)$/u.test(suffix)) {
    return { matched: false };
  }
  const activityType = /放松|休息|发呆|睡觉|睡前/u.test(start[1]) ? 'relax' : 'focus';
  const durationMinutes = normalizeDuration(suffix);
  if (/\d|半(?:个)?小时/u.test(suffix) && !durationMinutes) return { matched: true, action: 'usage' };
  return {
    matched: true,
    action: 'start',
    activityType,
    ...(durationMinutes ? { durationMinutes } : {})
  };
}

module.exports = {
  ALLOWED_DURATIONS,
  normalizeDuration,
  parseCompanionRoomMessage
};
