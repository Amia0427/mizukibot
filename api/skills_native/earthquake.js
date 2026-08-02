const axios = require('axios');
const config = require('../../config');
const { normalizeEarthquakeArgs } = require('../../utils/toolPolicy/skillArgs');

const USGS_QUERY_URL = 'https://earthquake.usgs.gov/fdsnws/event/1/query';
const CHINA_BOUNDS = Object.freeze({
  minlatitude: 18,
  maxlatitude: 54,
  minlongitude: 73,
  maxlongitude: 135
});
const WINDOW_MS = Object.freeze({
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000
});

function formatDateTime(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}`;
}

function buildQueryParams(args, now) {
  const windowMs = WINDOW_MS[args.time_window];
  const params = {
    format: 'geojson',
    orderby: 'time',
    starttime: new Date(now.getTime() - windowMs).toISOString(),
    minmagnitude: args.min_magnitude,
    limit: args.limit
  };
  return args.scope === 'china' ? { ...params, ...CHINA_BOUNDS } : params;
}

function formatEarthquakeEvidence(features, args) {
  const scopeLabel = args.scope === 'china' ? '中国范围' : '全球';
  const header = `地震数据：${scopeLabel}｜${args.time_window}｜M${args.min_magnitude}+｜${features.length} 条`;
  if (features.length === 0) {
    return `${header}\n没有符合条件的地震事件。\n来源：USGS Earthquake Hazards Program`;
  }

  const rows = features.map((feature, index) => {
    const properties = feature?.properties || {};
    const coordinates = Array.isArray(feature?.geometry?.coordinates) ? feature.geometry.coordinates : [];
    const magnitude = Number(properties.mag);
    const depth = Number(coordinates[2]);
    const timestamp = Number(properties.time);
    const timeText = Number.isFinite(timestamp)
      ? `UTC ${formatDateTime(timestamp, 'UTC')} / 北京时间 ${formatDateTime(timestamp, 'Asia/Shanghai')}`
      : '时间未知';
    const depthText = Number.isFinite(depth) ? `${depth.toFixed(1)} km` : '未知';
    return [
      `${index + 1}. ${Number.isFinite(magnitude) ? `M${magnitude}` : '震级未知'}｜${String(properties.place || '地点未知').trim()}`,
      `时间：${timeText}；深度：${depthText}`,
      properties.url ? `详情：${properties.url}` : ''
    ].filter(Boolean).join('\n');
  });

  return [header, ...rows, '来源：USGS Earthquake Hazards Program'].join('\n');
}

async function queryLatestEarthquakes(rawArgs = {}, deps = {}) {
  const args = normalizeEarthquakeArgs(rawArgs);
  const httpClient = deps.httpClient || axios;
  const nowValue = typeof deps.now === 'function' ? deps.now() : new Date();
  const now = nowValue instanceof Date ? nowValue : new Date(nowValue);
  const response = await httpClient.get(USGS_QUERY_URL, {
    params: buildQueryParams(args, now),
    timeout: 10000,
    proxy: false,
    headers: {
      Accept: 'application/geo+json,application/json',
      'User-Agent': config.HTTP_USER_AGENT
    }
  });
  if (!Array.isArray(response?.data?.features)) throw new Error('USGS earthquake response is invalid');
  const features = response.data.features.slice(0, args.limit);
  return formatEarthquakeEvidence(features, args);
}

module.exports = {
  CHINA_BOUNDS,
  USGS_QUERY_URL,
  buildQueryParams,
  formatEarthquakeEvidence,
  queryLatestEarthquakes
};
