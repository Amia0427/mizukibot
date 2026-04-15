const Holidays = require('date-holidays');
const { Solar } = require('lunar-javascript');
const config = require('../config');
const { getDatePartsInTz, formatWeekdayInTz } = require('../utils/time');
const { buildRuntimePrompt } = require('../utils/runtimePrompts');

const WEEKEND_DAYS = new Set(['星期六', '星期日', 'Sunday', 'Saturday']);
const HOLIDAYS_CN = new Holidays('CN');

function safeTrim(value = '') {
  return String(value || '').trim();
}

function normalizeBoolean(value) {
  return Boolean(value);
}

function getPerceptionTimezone() {
  return safeTrim(config.LLM_PERCEPTION_TIMEZONE || config.TIMEZONE || 'Asia/Shanghai');
}

function isPerceptionEnabled() {
  return normalizeBoolean(config.LLM_PERCEPTION_ENABLED);
}

function getEffectiveOptions(options = {}) {
  const source = options && typeof options === 'object' ? options : {};
  const passive = normalizeBoolean(source.passive);
  return {
    enabled: source.enabled !== undefined ? normalizeBoolean(source.enabled) : isPerceptionEnabled(),
    timezone: safeTrim(source.timezone || getPerceptionTimezone()),
    enableHoliday: source.enableHoliday !== undefined ? normalizeBoolean(source.enableHoliday) : normalizeBoolean(config.LLM_PERCEPTION_ENABLE_HOLIDAY),
    enablePlatform: source.enablePlatform !== undefined ? normalizeBoolean(source.enablePlatform) : normalizeBoolean(config.LLM_PERCEPTION_ENABLE_PLATFORM),
    enableSessionTiming: source.enableSessionTiming !== undefined ? normalizeBoolean(source.enableSessionTiming) : normalizeBoolean(config.LLM_PERCEPTION_ENABLE_SESSION_TIMING),
    enableConversationAtmosphere: source.enableConversationAtmosphere !== undefined ? normalizeBoolean(source.enableConversationAtmosphere) : normalizeBoolean(config.LLM_PERCEPTION_ENABLE_CONVERSATION_ATMOSPHERE),
    enableLunar: source.enableLunar !== undefined ? normalizeBoolean(source.enableLunar) : normalizeBoolean(config.LLM_PERCEPTION_ENABLE_LUNAR),
    enableSolarTerm: source.enableSolarTerm !== undefined ? normalizeBoolean(source.enableSolarTerm) : normalizeBoolean(config.LLM_PERCEPTION_ENABLE_SOLAR_TERM),
    enableAlmanac: source.enableAlmanac !== undefined ? normalizeBoolean(source.enableAlmanac) : normalizeBoolean(config.LLM_PERCEPTION_ENABLE_ALMANAC),
    includeGroupName: source.includeGroupName !== undefined ? normalizeBoolean(source.includeGroupName) : normalizeBoolean(config.LLM_PERCEPTION_INCLUDE_GROUP_NAME),
    passive
  };
}

function resolveNow(options = {}) {
  const input = options && typeof options === 'object' ? options : {};
  const date = input.now instanceof Date
    ? input.now
    : (input.now ? new Date(input.now) : new Date());
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function inferChatType(inboundContext = {}) {
  const explicit = safeTrim(inboundContext.chatType);
  if (explicit === 'group' || explicit === 'private') return explicit;
  if (safeTrim(inboundContext.groupId)) return 'group';
  return 'private';
}

function inferPlatform(inboundContext = {}) {
  const explicit = safeTrim(inboundContext.platform);
  if (explicit) return explicit;
  const msg = inboundContext.msg || {};
  if (msg.platform) return safeTrim(msg.platform);
  if (msg.message_type === 'group' || msg.message_type === 'private') return 'qq';
  return '';
}

function inferGroupName(inboundContext = {}) {
  const explicit = safeTrim(inboundContext.groupName);
  if (explicit) return explicit;
  const messageMeta = inboundContext.messageMeta && typeof inboundContext.messageMeta === 'object'
    ? inboundContext.messageMeta
    : {};
  return safeTrim(
    messageMeta.groupName
    || inboundContext.effectiveMsg?.group_name
    || inboundContext.msg?.group_name
    || ''
  );
}

function inferMediaFlags(inboundContext = {}) {
  const raw = String(
    inboundContext.rawText
    || inboundContext.effectiveMsg?.raw_message
    || inboundContext.msg?.raw_message
    || ''
  );
  const hasImage = Boolean(inboundContext.imageUrl) || /\[CQ:image,[^\]]*\]/i.test(raw);
  const hasVoice = /\[CQ:(record|voice),[^\]]*\]/i.test(raw);
  const hasVideo = /\[CQ:video,[^\]]*\]/i.test(raw);
  return {
    hasImage,
    hasVoice,
    hasVideo
  };
}

function inferTimePeriod(hour = 0) {
  if (hour < 5) return '凌晨';
  if (hour < 12) return '上午';
  if (hour < 14) return '中午';
  if (hour < 18) return '下午';
  if (hour < 22) return '晚上';
  return '深夜';
}

function formatClock(parts = {}) {
  const hour = String(Number(parts.hour || 0)).padStart(2, '0');
  const minute = String(Number(parts.minute || 0)).padStart(2, '0');
  const second = String(Number(parts.second || 0)).padStart(2, '0');
  return `${hour}:${minute}:${second}`;
}

function buildTimeSection(date, timezone) {
  const parts = getDatePartsInTz(date, timezone);
  const weekday = formatWeekdayInTz('zh-CN', date, timezone);
  const workdayKind = WEEKEND_DAYS.has(weekday) ? '周末' : '工作日';
  const period = inferTimePeriod(parts.hour);
  const lines = [
    `当前本地时间：${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')} ${formatClock(parts)} ${weekday}`,
    `时间属性：${workdayKind}，${period}`
  ];
  return {
    lines,
    meta: {
      date: `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`,
      time: formatClock(parts),
      weekday,
      workdayKind,
      period,
      hour: Number(parts.hour || 0)
    }
  };
}

function normalizeHolidayName(name = '') {
  return safeTrim(String(name || '').replace(/\s+/g, ' '));
}

function buildHolidaySection(date, timezone) {
  const parts = getDatePartsInTz(date, timezone);
  const isoDate = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
  const holidayList = HOLIDAYS_CN.isHoliday(new Date(`${isoDate}T12:00:00+08:00`));
  const items = Array.isArray(holidayList) ? holidayList : (holidayList ? [holidayList] : []);
  const publicHoliday = items.find((item) => item && item.type === 'public');
  const substitute = items.find((item) => item && String(item.type || '').includes('substitute'));
  const lines = [];
  const meta = {
    date: isoDate,
    isHoliday: false,
    isWorkdayOverride: false,
    holidayNames: []
  };

  if (publicHoliday) {
    const name = normalizeHolidayName(publicHoliday.name);
    meta.isHoliday = true;
    meta.holidayNames.push(name);
    lines.push(`节假日信息：今天是${name}`);
  }

  if (substitute) {
    const name = normalizeHolidayName(substitute.name || '调休');
    meta.isWorkdayOverride = true;
    meta.holidayNames.push(name);
    lines.push(`调休信息：今天是补班/调休日（${name}）`);
  }

  return { lines, meta };
}

function buildPlatformSection(inboundContext, options = {}) {
  const platform = inferPlatform(inboundContext);
  const chatType = inferChatType(inboundContext);
  const groupName = options.includeGroupName ? inferGroupName(inboundContext) : '';
  const media = inferMediaFlags(inboundContext);
  const lines = [];

  if (platform || chatType || groupName) {
    const fields = [];
    if (platform) fields.push(`平台=${platform}`);
    if (chatType) fields.push(`聊天类型=${chatType}`);
    if (groupName) fields.push(`群名=${groupName}`);
    lines.push(`会话环境：${fields.join('，')}`);
  }

  const mediaTypes = [];
  if (media.hasImage) mediaTypes.push('图片');
  if (media.hasVoice) mediaTypes.push('语音');
  if (media.hasVideo) mediaTypes.push('视频');
  if (!mediaTypes.length) mediaTypes.push('纯文本');
  lines.push(`媒体类型：${mediaTypes.join('、')}`);

  return {
    lines,
    meta: {
      platform,
      chatType,
      groupName: groupName || null,
      ...media
    }
  };
}

function formatRelativeDuration(ms = 0) {
  const value = Math.max(0, Number(ms || 0) || 0);
  if (!value) return '';
  const seconds = Math.floor(value / 1000);
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时`;
  const days = Math.floor(hours / 24);
  return `${days}天`;
}

function classifyConversationFreshness(diffMs = 0) {
  const value = Math.max(0, Number(diffMs || 0) || 0);
  if (!value || value < 90 * 1000) return 'continuous';
  if (value < 15 * 60 * 1000) return 'short_pause';
  if (value < 6 * 60 * 60 * 1000) return 'resume_later';
  return 'new_round';
}

function buildSessionTimingSection(inboundContext = {}, now) {
  const sessionTiming = inboundContext.sessionTiming && typeof inboundContext.sessionTiming === 'object'
    ? inboundContext.sessionTiming
    : {};
  const currentInboundAt = Number(sessionTiming.currentInboundAt || 0) || now.getTime();
  const previousHumanInboundAt = Number(sessionTiming.previousHumanInboundAt || 0) || 0;
  const previousBotReplyAt = Number(sessionTiming.previousBotReplyAt || 0) || 0;
  const humanTurnsSinceBotReply = Math.max(0, Number(sessionTiming.humanTurnsSinceBotReply || 0) || 0);
  const mergedSourceCount = Math.max(1, Number(sessionTiming.mergedSourceCount || 1) || 1);
  const mergedSpanMs = Math.max(0, Number(sessionTiming.mergedSpanMs || 0) || 0);
  const lines = [];

  if (previousHumanInboundAt > 0 && currentInboundAt > previousHumanInboundAt) {
    lines.push(`会话时序：距离用户上次发言约${formatRelativeDuration(currentInboundAt - previousHumanInboundAt)}`);
  }

  if (previousBotReplyAt > 0 && currentInboundAt > previousBotReplyAt) {
    lines.push(`会话时序：距离你上次回复约${formatRelativeDuration(currentInboundAt - previousBotReplyAt)}`);
  }

  const freshness = previousHumanInboundAt > 0
    ? classifyConversationFreshness(currentInboundAt - previousHumanInboundAt)
    : 'first_contact';
  if (freshness === 'continuous') {
    lines.push('会话状态：当前是连续续聊');
  } else if (freshness === 'short_pause') {
    lines.push('会话状态：短暂停顿后继续');
  } else if (freshness === 'resume_later') {
    lines.push('会话状态：间隔一段时间后续上');
  } else if (freshness === 'new_round') {
    lines.push('会话状态：间隔较久后重新开话题');
  }

  if (mergedSourceCount > 1) {
    const suffix = mergedSpanMs > 0 ? `，覆盖约${formatRelativeDuration(mergedSpanMs)}` : '';
    lines.push(`连续输入：本次由${mergedSourceCount}条消息合并而成${suffix}`);
  }

  if (previousBotReplyAt > 0 && humanTurnsSinceBotReply > 0) {
    lines.push(`续聊强度：你上次回复后，用户已连续发言${humanTurnsSinceBotReply}次`);
  }

  return {
    lines,
    meta: {
      currentInboundAt,
      previousHumanInboundAt,
      previousBotReplyAt,
      humanTurnsSinceBotReply,
      mergedSourceCount,
      mergedSpanMs,
      freshness
    }
  };
}

function buildConversationAtmosphereSection(timeMeta = {}, holidayMeta = {}, sessionTimingMeta = {}, options = {}) {
  const lines = [];
  const tags = [];
  const weekday = safeTrim(timeMeta.workdayKind);
  const period = safeTrim(timeMeta.period);
  const freshness = safeTrim(sessionTimingMeta.freshness);
  const previousBotReplyAt = Number(sessionTimingMeta.previousBotReplyAt || 0) || 0;
  const currentInboundAt = Number(sessionTimingMeta.currentInboundAt || 0) || 0;
  const replyGapMs = previousBotReplyAt > 0 && currentInboundAt > previousBotReplyAt
    ? (currentInboundAt - previousBotReplyAt)
    : 0;

  if (holidayMeta?.isHoliday) {
    tags.push('节假日氛围');
  } else if (weekday === '周末') {
    tags.push('周末氛围');
  } else if (weekday) {
    tags.push(weekday);
  }

  if (period === '上午' || period === '中午') {
    tags.push(options.passive ? '白天时段' : '白天时段，语气可自然轻一些');
  } else if (period === '晚上') {
    tags.push(options.passive ? '晚间时段' : '晚间时段，氛围偏放松');
  } else if (period === '深夜' || period === '凌晨') {
    tags.push(options.passive ? '夜间时段' : '夜间时段，语气宜更收束');
  }

  if (freshness === 'continuous' || freshness === 'short_pause') {
    tags.push(options.passive ? '会话仍然新鲜' : '会话仍然新鲜，可直接接上文');
  } else if (freshness === 'resume_later') {
    tags.push(options.passive ? '中等间隔续聊' : '间隔后续聊，必要时轻微重建上下文');
  } else if (freshness === 'new_round') {
    tags.push(options.passive ? '较久后重开话题' : '较久后重开话题，适合重新起势');
  }

  if (replyGapMs > 0 && replyGapMs < 3 * 60 * 1000) {
    tags.push('紧跟回复追问');
  } else if (replyGapMs >= 3 * 60 * 1000 && replyGapMs < 30 * 60 * 1000) {
    tags.push('温热 follow-up');
  }

  if (tags.length) {
    lines.push(`对话氛围：${tags.join('；')}`);
  }

  return {
    lines,
    meta: {
      tags
    }
  };
}

function getSolarTermValue(lunar) {
  if (!lunar) return null;
  try {
    const current = lunar.getCurrentJieQi && lunar.getCurrentJieQi();
    if (current && typeof current.getName === 'function') {
      return {
        name: safeTrim(current.getName()),
        dayOffset: 0,
        solarYmd: current.getSolar && current.getSolar() ? current.getSolar().toYmd() : ''
      };
    }
  } catch (_) {}

  try {
    const next = lunar.getNextJieQi && lunar.getNextJieQi(true);
    if (next && typeof next.getName === 'function') {
      const solar = next.getSolar && next.getSolar();
      const dayOffset = solar && typeof solar.subtract === 'function'
        ? Number(solar.subtract(lunar.getSolar ? lunar.getSolar() : solar) || 0)
        : 0;
      return {
        name: safeTrim(next.getName()),
        dayOffset,
        solarYmd: solar && typeof solar.toYmd === 'function' ? solar.toYmd() : ''
      };
    }
  } catch (_) {}

  try {
    const currentName = safeTrim(lunar.getJieQi && lunar.getJieQi());
    if (currentName) {
      return {
        name: currentName,
        dayOffset: 0,
        solarYmd: ''
      };
    }
  } catch (_) {}

  return null;
}

function buildLunarSection(date, timezone) {
  const parts = getDatePartsInTz(date, timezone);
  const solar = Solar.fromYmdHms(
    parts.year,
    parts.month,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  const lunar = solar.getLunar();
  const zodiac = safeTrim(lunar.getYearShengXiao && lunar.getYearShengXiao());
  const yearGanzhi = safeTrim(lunar.getYearInGanZhi && lunar.getYearInGanZhi());
  const monthGanzhi = safeTrim(lunar.getMonthInGanZhi && lunar.getMonthInGanZhi());
  const dayGanzhi = safeTrim(lunar.getDayInGanZhi && lunar.getDayInGanZhi());
  const lunarDate = safeTrim(lunar.toString && lunar.toString());
  const lines = [];

  if (lunarDate || zodiac || yearGanzhi || monthGanzhi || dayGanzhi) {
    const segments = [];
    if (lunarDate) segments.push(`农历=${lunarDate}`);
    if (zodiac) segments.push(`生肖=${zodiac}`);
    const ganzhi = [yearGanzhi, monthGanzhi, dayGanzhi].filter(Boolean).join(' / ');
    if (ganzhi) segments.push(`干支=${ganzhi}`);
    lines.push(`农历信息：${segments.join('，')}`);
  }

  return {
    lines,
    meta: {
      lunarDate,
      zodiac,
      yearGanzhi,
      monthGanzhi,
      dayGanzhi,
      solar,
      lunar
    }
  };
}

function buildSolarTermSection(lunarMeta = {}) {
  const term = getSolarTermValue(lunarMeta.lunar);
  if (!term || !term.name) {
    return {
      lines: [],
      meta: {
        solarTerm: null
      }
    };
  }

  const lines = [
    term.dayOffset === 0
      ? `节气信息：当前节气为${term.name}`
      : `节气信息：下一节气为${term.name}${term.dayOffset > 0 ? `（约${term.dayOffset}天后）` : ''}`
  ];

  return {
    lines,
    meta: {
      solarTerm: term
    }
  };
}

function shortenAlmanacList(list, limit = 6) {
  const items = Array.isArray(list) ? list.map((item) => safeTrim(item)).filter(Boolean) : [];
  return items.slice(0, Math.max(1, Number(limit) || 6));
}

function buildAlmanacSection(lunarMeta = {}) {
  const lunar = lunarMeta.lunar;
  if (!lunar) {
    return {
      lines: [],
      meta: {
        almanac: null
      }
    };
  }

  const yi = shortenAlmanacList(lunar.getDayYi && lunar.getDayYi(), 6);
  const ji = shortenAlmanacList(lunar.getDayJi && lunar.getDayJi(), 6);
  if (!yi.length && !ji.length) {
    return {
      lines: [],
      meta: {
        almanac: null
      }
    };
  }

  const segments = [];
  if (yi.length) segments.push(`宜：${yi.join('、')}`);
  if (ji.length) segments.push(`忌：${ji.join('、')}`);

  return {
    lines: [`黄历摘要：${segments.join('；')}`],
    meta: {
      almanac: {
        yi,
        ji
      }
    }
  };
}

function buildPassiveSectionFilter(sectionLines = [], options = {}) {
  if (!options.passive) return sectionLines;
  return sectionLines;
}

function safeSection(builder, metaKey, debug) {
  try {
    return builder();
  } catch (error) {
    if (Array.isArray(debug.failures)) {
      debug.failures.push({ section: metaKey, reason: String(error?.message || error) });
    }
    return { lines: [], meta: {} };
  }
}

function buildLlmPerception(inboundContext = {}, options = {}) {
  const resolved = getEffectiveOptions(options);
  const debug = {
    enabled: resolved.enabled,
    timezone: resolved.timezone,
    failures: []
  };

  if (!resolved.enabled) {
    return {
      text: '',
      meta: {
        ...debug,
        reason: 'disabled'
      }
    };
  }

  const now = resolveNow(options);
  const sections = [];
  const meta = {
    ...debug
  };

  try {
    const timeSection = safeSection(() => buildTimeSection(now, resolved.timezone), 'time', debug);
    sections.push(...buildPassiveSectionFilter(timeSection.lines, resolved));
    meta.time = timeSection.meta;

    if (resolved.enablePlatform) {
      const platformSection = safeSection(() => buildPlatformSection(inboundContext, resolved), 'platform', debug);
      sections.push(...buildPassiveSectionFilter(platformSection.lines, resolved));
      meta.platform = platformSection.meta;
    }

    if (resolved.enableHoliday) {
      const holidaySection = safeSection(() => buildHolidaySection(now, resolved.timezone), 'holiday', debug);
      sections.push(...buildPassiveSectionFilter(holidaySection.lines, resolved));
      meta.holiday = holidaySection.meta;
    }

    let sessionTimingSection = { lines: [], meta: {} };
    if (resolved.enableSessionTiming) {
      sessionTimingSection = safeSection(() => buildSessionTimingSection(inboundContext, now), 'session_timing', debug);
      sections.push(...buildPassiveSectionFilter(sessionTimingSection.lines, resolved));
      meta.sessionTiming = sessionTimingSection.meta;
    }

    if (resolved.enableConversationAtmosphere) {
      const atmosphereSection = safeSection(
        () => buildConversationAtmosphereSection(timeSection.meta, meta.holiday || {}, sessionTimingSection.meta, resolved),
        'conversation_atmosphere',
        debug
      );
      sections.push(...buildPassiveSectionFilter(atmosphereSection.lines, resolved));
      meta.atmosphere = atmosphereSection.meta;
    }

    let lunarSection = { lines: [], meta: {} };
    if (resolved.enableLunar || resolved.enableSolarTerm || (resolved.enableAlmanac && !resolved.passive)) {
      lunarSection = safeSection(() => buildLunarSection(now, resolved.timezone), 'lunar', debug);
      if (resolved.enableLunar) {
        sections.push(...buildPassiveSectionFilter(lunarSection.lines, resolved));
      }
      meta.lunar = {
        lunarDate: lunarSection.meta.lunarDate || '',
        zodiac: lunarSection.meta.zodiac || '',
        yearGanzhi: lunarSection.meta.yearGanzhi || '',
        monthGanzhi: lunarSection.meta.monthGanzhi || '',
        dayGanzhi: lunarSection.meta.dayGanzhi || ''
      };
    }

    if (resolved.enableSolarTerm) {
      const solarTermSection = safeSection(() => buildSolarTermSection(lunarSection.meta), 'solar_term', debug);
      sections.push(...buildPassiveSectionFilter(solarTermSection.lines, resolved));
      meta.solarTerm = solarTermSection.meta.solarTerm || null;
    }

    if (resolved.enableAlmanac && !resolved.passive) {
      const almanacSection = safeSection(() => buildAlmanacSection(lunarSection.meta), 'almanac', debug);
      sections.push(...almanacSection.lines);
      meta.almanac = almanacSection.meta.almanac || null;
    }
  } catch (error) {
    return {
      text: '',
      meta: {
        ...debug,
        reason: 'build-failed',
        failure: String(error?.message || error)
      }
    };
  }

  const text = sections.length
    ? buildRuntimePrompt('llm-perception', {
      perceptionLines: sections.join('\n')
    })
    : '';

  return {
    text,
    meta: {
      ...meta,
      passive: resolved.passive,
      lineCount: sections.length
    }
  };
}

module.exports = {
  buildLlmPerception
};
