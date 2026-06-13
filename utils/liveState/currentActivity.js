const { getDatePartsInTz, getTimezone } = require('../time');

function getCurrentActivity(options = {}) {
  const date = options.now instanceof Date ? options.now : new Date();
  const timezone = options.timezone || getTimezone();
  const parts = getDatePartsInTz(date, timezone);
  const hour = Number(parts.hour);
  const dayOfWeek = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short'
  }).format(date) === 'Sun'
    ? 0
    : new Date(new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(date) + 'T00:00:00').getDay());

  if (hour >= 23 || hour < 6) {
    return {
      activity: '可能在睡觉或准备睡觉',
      mood: '困倦',
      constraints: '回复可能很简短或慢'
    };
  }

  if (hour >= 6 && hour < 8) {
    return {
      activity: '可能刚起床',
      mood: '还没完全清醒',
      constraints: '可能需要点时间进入状态'
    };
  }

  if (hour >= 8 && hour < 12) {
    return {
      activity: '可能在学校或外出',
      mood: '日常状态',
      constraints: null
    };
  }

  if (hour >= 14 && hour < 18 && dayOfWeek >= 1 && dayOfWeek <= 5) {
    return {
      activity: '可能在学校或排练',
      mood: '专注',
      constraints: '可能不方便长时间聊天'
    };
  }

  if (hour >= 14 && hour < 18) {
    return {
      activity: '可能在排练或外出',
      mood: '放松',
      constraints: null
    };
  }

  return {
    activity: '可能在家或外出',
    mood: '放松',
    constraints: null
  };
}

module.exports = {
  getCurrentActivity
};
