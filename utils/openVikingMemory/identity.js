const {
  normalizeArray,
  normalizeText
} = require('./text');

const VALID_ISOLATION_MODES = new Set(['venue_user', 'venue_user_fanout', 'global_user']);

function getEffectiveIsolationMode(config = {}, options = {}) {
  const mode = normalizeText(options.isolationMode || config.OPENVIKING_ISOLATION_MODE || 'venue_user').toLowerCase();
  return VALID_ISOLATION_MODES.has(mode) ? mode : 'venue_user';
}

function deriveVenueId(options = {}) {
  const platform = normalizeText(options.platform || options.channel || 'qq', 'qq');
  const groupId = normalizeText(options.groupId || options.group_id);
  const userId = normalizeText(options.userId || options.senderId || options.sender_id);
  if (groupId) return `${platform}-group-${groupId}`;
  return `${platform}-dm-${userId || 'unknown'}`;
}

function deriveSenderScope(options = {}) {
  return normalizeText(options.senderId || options.sender_id || options.userId || options.user_id || 'unknown');
}

function deriveOpenVikingUserId(config = {}, options = {}) {
  const mode = getEffectiveIsolationMode(config, options);
  if (mode === 'global_user') {
    return normalizeText(config.OPENVIKING_GLOBAL_USER_ID || options.globalUserId || 'mizukibot-global');
  }
  const groupId = normalizeText(options.groupId || options.group_id);
  if (groupId) {
    return `mizukibot-${deriveVenueId(options)}-sender-${deriveSenderScope(options)}`;
  }
  return `mizukibot-${deriveVenueId(options)}`;
}

function deriveSessionId(options = {}) {
  const groupId = normalizeText(options.groupId || options.group_id);
  const senderSuffix = groupId ? `::sender-${deriveSenderScope(options)}` : '';
  return `mizukibot::${deriveVenueId(options)}${senderSuffix}`;
}

function isGroupVenue(venueId = '') {
  return /-group-/.test(normalizeText(venueId));
}

function parseVenueOrigin(venueId = '') {
  const text = normalizeText(venueId);
  const parts = text.split('-', 3);
  if (parts.length < 3) return text;
  return `${parts[0]}-${parts[1]}:${parts[2]}`;
}

function isBypassedVenue(config = {}, options = {}) {
  const groupId = normalizeText(options.groupId || options.group_id);
  if (!groupId) return false;
  const bypassGroups = normalizeArray(config.OPENVIKING_BYPASS_GROUP_IDS)
    .map((item) => normalizeText(item))
    .filter(Boolean);
  return bypassGroups.includes(groupId);
}

function buildIdentity(config = {}, options = {}) {
  const venueId = deriveVenueId(options);
  return {
    venueId,
    sessionId: deriveSessionId(options),
    openVikingUserId: deriveOpenVikingUserId(config, options),
    isolationMode: getEffectiveIsolationMode(config, options),
    isGroup: isGroupVenue(venueId),
    originLabel: parseVenueOrigin(venueId),
    bypassed: isBypassedVenue(config, options)
  };
}

module.exports = {
  VALID_ISOLATION_MODES,
  buildIdentity,
  deriveOpenVikingUserId,
  deriveSenderScope,
  deriveSessionId,
  deriveVenueId,
  getEffectiveIsolationMode,
  isBypassedVenue,
  isGroupVenue,
  parseVenueOrigin
};
