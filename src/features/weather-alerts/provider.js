const axios = require('axios');
const { createQWeatherClient } = require('../../../api/skills_native/qweatherClient');

const COLOR_LEVELS = Object.freeze({
  blue: { label: '蓝色', rank: 1 },
  yellow: { label: '黄色', rank: 2 },
  orange: { label: '橙色', rank: 3 },
  red: { label: '红色', rank: 4 },
  '蓝色': { label: '蓝色', rank: 1 },
  '黄色': { label: '黄色', rank: 2 },
  '橙色': { label: '橙色', rank: 3 },
  '红色': { label: '红色', rank: 4 }
});

function normalizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeField(value, fields = []) {
  if (!value || typeof value !== 'object') return normalizeText(value);
  for (const field of fields) {
    const text = normalizeText(value[field]);
    if (text) return text;
  }
  return '';
}

function administrativeBase(value = '') {
  return normalizeText(value).replace(/(特别行政区|自治区|自治州|地区|省|市|区|县|州|盟)$/u, '');
}

function formatLocationName(location = {}) {
  const adm1 = normalizeText(location.adm1);
  const adm2 = normalizeText(location.adm2);
  let name = normalizeText(location.name);
  const municipality = ['北京', '上海', '天津', '重庆'].includes(administrativeBase(adm1));
  if (municipality && name && !/(市|区|县)$/u.test(name)) name = `${name}区`;

  const parts = [];
  for (const part of [adm1, adm2, name]) {
    if (!part) continue;
    const previous = parts[parts.length - 1];
    if (previous && administrativeBase(previous) === administrativeBase(part)) continue;
    parts.push(part);
  }
  return parts.join('') || name;
}

function resolveSeverity(value = {}) {
  const candidates = [
    normalizeField(value.severityColor, ['code', 'name']),
    normalizeField(value.color, ['code', 'name']),
    normalizeField(value.level, ['code', 'name']),
    normalizeField(value.severity, ['code', 'name'])
  ]
    .map((item) => item.toLowerCase())
    .filter(Boolean);
  for (const candidate of candidates) {
    for (const [key, resolved] of Object.entries(COLOR_LEVELS)) {
      if (candidate === key || candidate.includes(key)) return resolved;
    }
  }
  const severityRanks = { minor: 1, moderate: 2, severe: 3, extreme: 4 };
  for (const candidate of candidates) {
    if (severityRanks[candidate]) {
      return { label: ['未知等级', '蓝色', '黄色', '橙色', '红色'][severityRanks[candidate]], rank: severityRanks[candidate] };
    }
  }
  return { label: '未知等级', rank: 0 };
}

function getWarningSeverityRank(warning = {}) {
  const explicit = Number(warning.severityRank);
  return Number.isFinite(explicit) ? explicit : resolveSeverity(warning).rank;
}

function normalizeWarning(raw = {}, locationId = '') {
  const severity = resolveSeverity(raw);
  const eventType = normalizeField(raw.typeName || raw.eventType || raw.type, ['name', 'code']);
  return {
    id: normalizeText(raw.id),
    locationId: normalizeText(locationId),
    sender: normalizeText(raw.sender || raw.senderName),
    pubTime: normalizeText(raw.pubTime || raw.issuedTime),
    title: normalizeText(raw.title || raw.headline),
    startTime: normalizeText(raw.startTime || raw.effectiveTime || raw.onsetTime),
    endTime: normalizeText(raw.endTime || raw.expireTime),
    status: normalizeText(raw.status),
    level: normalizeField(raw.level || raw.severity, ['name', 'code']),
    severity: normalizeField(raw.severity, ['name', 'code']),
    severityColor: normalizeField(raw.severityColor || raw.color, ['code', 'name']),
    severityLabel: severity.label,
    severityRank: severity.rank,
    type: eventType,
    typeName: eventType,
    urgency: normalizeField(raw.urgency, ['name', 'code']),
    certainty: normalizeField(raw.certainty, ['name', 'code']),
    text: normalizeText(raw.text || raw.description),
    related: normalizeText(raw.related || raw.instruction),
    raw: { ...raw }
  };
}

function isWarningActive(warning = {}, now = Date.now()) {
  const status = normalizeText(warning.status);
  const messageType = normalizeText(warning.messageType?.code || warning.raw?.messageType?.code).toLowerCase();
  if (messageType === 'cancel' || /(解除|取消|失效|结束)/u.test(`${status} ${warning.title || ''} ${warning.text || ''}`)) return false;
  const endAt = Date.parse(normalizeText(warning.endTime));
  return !Number.isFinite(endAt) || endAt > Number(now);
}

function createQWeatherProvider(options = {}) {
  const client = options.client || createQWeatherClient({
    apiHost: options.apiHost,
    apiSecret: options.apiSecret ?? options.apiKey,
    httpClient: options.httpClient || axios,
    timeoutMs: options.timeoutMs
  });

  async function lookupLocations(query) {
    const location = normalizeText(query);
    if (!location) return [];
    const data = await client.request('/geo/v2/city/lookup', { location }, 'location lookup');
    return (Array.isArray(data.location) ? data.location : []).map((item) => ({
      locationId: normalizeText(item.id),
      name: normalizeText(item.name),
      adm1: normalizeText(item.adm1),
      adm2: normalizeText(item.adm2),
      country: normalizeText(item.country),
      latitude: normalizeText(item.lat),
      longitude: normalizeText(item.lon),
      displayName: formatLocationName(item),
      raw: { ...item }
    })).filter((item) => item.locationId);
  }

  async function getWarnings(location = {}) {
    const locationId = normalizeText(typeof location === 'string' ? location : location.locationId);
    let latitude = normalizeText(typeof location === 'object' ? location.latitude || location.lat : '');
    let longitude = normalizeText(typeof location === 'object' ? location.longitude || location.lon : '');
    if ((!latitude || !longitude) && locationId) {
      const candidates = await lookupLocations(locationId);
      const matched = candidates.find((item) => item.locationId === locationId) || candidates[0];
      latitude = normalizeText(matched?.latitude);
      longitude = normalizeText(matched?.longitude);
    }
    if (!locationId || !latitude || !longitude) return [];
    const data = await client.getWarning(latitude, longitude);
    return (Array.isArray(data.alerts) ? data.alerts : [])
      .map((item) => normalizeWarning(item, locationId))
      .filter((item) => item.id);
  }

  return { getWarnings, lookupLocations };
}

module.exports = {
  createQWeatherProvider,
  formatLocationName,
  getWarningSeverityRank,
  isWarningActive,
  normalizeWarning
};
