const config = require('../config');
const {
  getGroupInitiativeState,
  getGroupMute,
  recordInitiativeCandidate,
  recordInitiativeSkip,
  tryAcquireInFlightLock,
  releaseInFlightLock
} = require('./initiativeState');

const PRIORITY_RANK = Object.freeze({
  carry_over_resume: 100,
  open_loop_resume: 95,
  recent_topic_followup: 75,
  journal_followup: 70,
  life_scheduler: 60,
  daily_share: 55,
  fallback_morning_greeting: 40,
  fallback_night_greeting: 40,
  light_care_ping: 30
});

function normalizeCsvSet(value = '') {
  return new Set(
    String(value || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

function getRecentActivitySummary(groupState = {}, now = Date.now()) {
  const activity = Array.isArray(groupState?.recentHumanActivity) ? groupState.recentHumanActivity : [];
  const windowMs = Math.max(10000, Number(config.INITIATIVE_ACTIVE_CHAT_WINDOW_SECONDS || 90) * 1000);
  const recent = activity.filter((item) => now - Number(item.timestamp || 0) <= windowMs);
  const speakerCount = new Set(recent.map((item) => String(item.senderId || '').trim()).filter(Boolean)).size;
  return {
    recentCount: recent.length,
    speakerCount,
    isHotChat: recent.length >= Math.max(2, Number(config.INITIATIVE_ACTIVE_CHAT_MESSAGE_THRESHOLD || 6))
  };
}

function isStrongCandidate(candidateReason = '') {
  const reason = String(candidateReason || '').trim();
  return reason === 'carry_over_resume'
    || reason === 'open_loop_resume'
    || reason === 'fallback_morning_greeting'
    || reason === 'fallback_night_greeting';
}

function resolvePriority(candidateReason = '', explicitPriority = null) {
  if (Number.isFinite(Number(explicitPriority))) return Number(explicitPriority);
  return Number(PRIORITY_RANK[String(candidateReason || '').trim()] || 0);
}

function buildCycleKey(source = '', groupId = '', now = Date.now()) {
  const bucket = Math.floor(Number(now || Date.now()) / Math.max(1, Number(config.INITIATIVE_ACTIVE_CHAT_WINDOW_SECONDS || 90) * 1000));
  return `${String(source || '').trim()}:${String(groupId || '').trim()}:${bucket}`;
}

function resolveGroupAllowBlock(groupId = '') {
  const gid = String(groupId || '').trim();
  const allowSet = normalizeCsvSet(config.INITIATIVE_ALLOWED_GROUP_IDS || '');
  const blockSet = normalizeCsvSet(config.INITIATIVE_BLOCKED_GROUP_IDS || '');
  if (blockSet.has(gid)) return { allowed: false, reason: 'group-blocked' };
  if (allowSet.size > 0 && !allowSet.has(gid)) return { allowed: false, reason: 'group-not-allowed' };
  return { allowed: true, reason: '' };
}

function evaluateInitiativePolicy({
  source = '',
  groupId = '',
  userId = '',
  candidateReason = '',
  priority = null,
  contextHints = {}
} = {}, now = Date.now()) {
  const gid = String(groupId || '').trim();
  const allowResult = resolveGroupAllowBlock(gid);
  if (!config.INITIATIVE_POLICY_ENABLED) {
    return {
      allowed: allowResult.allowed,
      reason: allowResult.reason || 'policy-disabled',
      requireDecisionModel: true,
      style: 'default',
      minGapApplied: 0,
      strongCandidate: isStrongCandidate(candidateReason),
      priority: resolvePriority(candidateReason, priority),
      hotChat: false,
      recentCount: 0,
      cycleKey: buildCycleKey(source, gid, now)
    };
  }
  if (!allowResult.allowed) {
    recordInitiativeSkip(gid, allowResult.reason, now);
    return {
      allowed: false,
      reason: allowResult.reason,
      requireDecisionModel: true,
      style: 'default',
      minGapApplied: 0,
      strongCandidate: isStrongCandidate(candidateReason),
      priority: resolvePriority(candidateReason, priority),
      hotChat: false,
      recentCount: 0,
      cycleKey: buildCycleKey(source, gid, now)
    };
  }

  recordInitiativeCandidate(gid, { reason: candidateReason }, now);
  const groupState = getGroupInitiativeState(gid, now);
  const mute = getGroupMute(gid, now);
  if (mute.until > now) {
    recordInitiativeSkip(gid, 'group-muted', now);
    return {
      allowed: false,
      reason: 'group-muted',
      requireDecisionModel: true,
      style: 'muted',
      minGapApplied: 0,
      strongCandidate: isStrongCandidate(candidateReason),
      priority: resolvePriority(candidateReason, priority),
      hotChat: false,
      recentCount: 0,
      cycleKey: buildCycleKey(source, gid, now)
    };
  }

  const strongCandidate = isStrongCandidate(candidateReason);
  const recentActivity = getRecentActivitySummary(groupState, now);
  const minGapMs = Math.max(1000, Number(config.INITIATIVE_GROUP_MIN_GAP_MINUTES || 12) * 60 * 1000);
  const lastBotReplyAt = Number(groupState.lastBotReplyAt || 0) || 0;
  if (lastBotReplyAt > 0 && now - lastBotReplyAt < minGapMs) {
    recordInitiativeSkip(gid, 'min-gap-active', now);
    return {
      allowed: false,
      reason: 'min-gap-active',
      requireDecisionModel: true,
      style: 'cooldown',
      minGapApplied: minGapMs,
      strongCandidate,
      priority: resolvePriority(candidateReason, priority),
      hotChat: recentActivity.isHotChat,
      recentCount: recentActivity.recentCount,
      cycleKey: buildCycleKey(source, gid, now)
    };
  }

  if (recentActivity.isHotChat && !strongCandidate) {
    recordInitiativeSkip(gid, 'active-chat-suppressed', now);
    return {
      allowed: false,
      reason: 'active-chat-suppressed',
      requireDecisionModel: true,
      style: 'hold',
      minGapApplied: minGapMs,
      strongCandidate,
      priority: resolvePriority(candidateReason, priority),
      hotChat: true,
      recentCount: recentActivity.recentCount,
      cycleKey: buildCycleKey(source, gid, now)
    };
  }

  const dailyCount = Math.max(0, Number(groupState?.daily?.count || 0) || 0);
  if (dailyCount >= Math.max(1, Number(config.INITIATIVE_GROUP_MAX_PER_DAY || 8))) {
    recordInitiativeSkip(gid, 'daily-quota-reached', now);
    return {
      allowed: false,
      reason: 'daily-quota-reached',
      requireDecisionModel: true,
      style: 'quota',
      minGapApplied: minGapMs,
      strongCandidate,
      priority: resolvePriority(candidateReason, priority),
      hotChat: recentActivity.isHotChat,
      recentCount: recentActivity.recentCount,
      cycleKey: buildCycleKey(source, gid, now)
    };
  }

  const cycleKey = buildCycleKey(source, gid, now);
  if (String(groupState.lastCycleKey || '').trim() === cycleKey) {
    recordInitiativeSkip(gid, 'same-cycle-already-sent', now);
    return {
      allowed: false,
      reason: 'same-cycle-already-sent',
      requireDecisionModel: true,
      style: 'dedupe',
      minGapApplied: minGapMs,
      strongCandidate,
      priority: resolvePriority(candidateReason, priority),
      hotChat: recentActivity.isHotChat,
      recentCount: recentActivity.recentCount,
      cycleKey
    };
  }

  return {
    allowed: true,
    reason: 'allowed',
    requireDecisionModel: true,
    style: strongCandidate ? 'resume_open_loop' : (String(source || '').trim() === 'daily_share' ? 'broadcast_share' : (String(source || '').trim() === 'life_scheduler' ? 'broadcast_share' : 'light_touch')),
    minGapApplied: minGapMs,
    strongCandidate,
    priority: resolvePriority(candidateReason, priority),
    hotChat: recentActivity.isHotChat,
    recentCount: recentActivity.recentCount,
    cycleKey
  };
}

function acquireInitiativeLock({ groupId = '', owner = '', now = Date.now() } = {}) {
  return tryAcquireInFlightLock(groupId, owner, now, config.INITIATIVE_INFLIGHT_TTL_MS);
}

function releaseInitiativeLock({ groupId = '', owner = '', now = Date.now() } = {}) {
  return releaseInFlightLock(groupId, owner, now);
}

module.exports = {
  acquireInitiativeLock,
  evaluateInitiativePolicy,
  isStrongCandidate,
  releaseInitiativeLock
};
