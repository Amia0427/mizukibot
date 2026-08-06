const config = require('../../config');
const { extractWeatherLocation } = require('../../utils/environmentDataQuery');
const { normalizeWeatherArgs } = require('../../utils/toolPolicy/skillArgs');
const { createQWeatherClient } = require('./qweatherClient');

const QWEATHER_SOURCE = '和风天气 Weather API';
const CHINA_COUNTRIES = new Set(['中国', 'China', '中国大陆']);

function normalizeText(value = '') {
  return String(value || '').trim();
}

function formatNumber(value, fallback = '-') {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Number.isInteger(number) ? String(number) : number.toFixed(1).replace(/\.0$/, '');
}

function formatTemperature(value, fallback = '-') {
  if (value && typeof value === 'object') return formatNumber(value.value, fallback);
  return formatNumber(value, fallback);
}

function formatPercent(value, fallback = '-') {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return `${formatNumber(number <= 1 ? number * 100 : number)}%`;
}

function formatLocalTime(value, timeZone, options = {}) {
  const raw = normalizeText(value);
  if (!raw) return '未知';
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw.replace('T', ' ').replace(/Z$/i, '');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone || 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(options.dateOnly ? {} : { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const dateText = `${values.year}-${values.month}-${values.day}`;
  return options.dateOnly ? dateText : `${dateText} ${values.hour}:${values.minute}`;
}

function formatLocation(place = {}) {
  const parts = [place.country, place.adm1, place.adm2, place.name]
    .map(normalizeText)
    .filter(Boolean);
  const seen = new Set();
  const unique = [];
  for (const part of parts) {
    const key = part.replace(/(特别行政区|自治区|自治州|地区|省|市|区|县|州)$/u, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(part);
  }
  return unique.join('') || '未知地点';
}

function formatWind(wind = {}) {
  const direction = normalizeText(wind.direction?.text || wind.direction?.compass || wind.direction);
  const speed = formatNumber(wind.speed?.value ?? wind.speed);
  const scale = formatNumber(wind.scale);
  if (!direction && speed === '-' && scale === '-') return '未知';
  const details = [direction, speed !== '-' ? `${speed} m/s` : '', scale !== '-' ? `${scale}级` : '']
    .filter(Boolean)
    .join(' ');
  return details || '未知';
}

function formatOverview(current = {}, daily = {}, timeZone, now) {
  const condition = normalizeText(current.condition?.text || current.text) || '未知';
  const temperature = formatTemperature(current.temperature);
  const feelsLike = formatTemperature(current.feelsLike);
  const humidity = formatPercent(current.humidity);
  const precipitation = formatNumber(current.precipitation?.amount?.value ?? current.precipitation?.amount);
  const updateTime = current.updateTime || current.obsTime || current.observationTime;
  const updateLabel = updateTime
    ? formatLocalTime(updateTime, timeZone)
    : `${formatLocalTime(now, timeZone)}（查询时间）`;
  const days = Array.isArray(daily.days) ? daily.days.slice(0, 10) : [];
  if (!current || typeof current !== 'object' || !Array.isArray(daily.days)) {
    throw new Error('QWeather overview returned an invalid response');
  }
  const forecast = days.map((day) => {
    const date = formatLocalTime(day.forecastStartTime || day.fxDate || day.date, timeZone, { dateOnly: true });
    const daytime = normalizeText(day.daytime?.condition?.text || day.day?.text || day.text) || '未知';
    const nighttime = normalizeText(day.nighttime?.condition?.text || day.night?.text) || '未知';
    const min = formatTemperature(day.temperatureMin);
    const max = formatTemperature(day.temperatureMax);
    const probability = day.daytime?.precipitation?.probability ?? day.precipitation?.probability;
    const rain = Number.isFinite(Number(probability)) ? `，降水概率 ${formatPercent(Number(probability))}` : '';
    return `${date}：白天${daytime}，夜间${nighttime}，${min}~${max}℃${rain}`;
  });
  return [
    `实况：${condition}，${temperature}℃，体感 ${feelsLike}℃，湿度 ${humidity}`,
    `风况：${formatWind(current.wind)}`,
    `降水：${precipitation} mm`,
    `更新时间：${updateLabel}`,
    `近${forecast.length}日预报：${forecast.length ? `\n${forecast.join('\n')}` : '暂无数据'}`
  ].join('\n');
}

function formatHourly(data = {}, timeZone, hours) {
  if (!Array.isArray(data.hours)) throw new Error('QWeather hourly forecast returned an invalid response');
  const rows = data.hours.slice(0, hours).map((item) => {
    const time = formatLocalTime(item.forecastTime || item.fxTime, timeZone);
    const condition = normalizeText(item.condition?.text || item.text) || '未知';
    const temperature = formatTemperature(item.temperature);
    const probability = item.precipitation?.probability;
    const rain = Number.isFinite(Number(probability)) ? `，降水概率 ${formatPercent(probability)}` : '';
    return `${time}：${condition}，${temperature}℃${rain}`;
  });
  return rows.length ? rows.join('\n') : '暂无逐小时数据';
}

function formatMinutely(data = {}, timeZone) {
  if (!Array.isArray(data.minutely)) throw new Error('QWeather minutely precipitation returned an invalid response');
  const rows = data.minutely.slice(0, 24).map((item) => {
    const time = formatLocalTime(item.fxTime || item.forecastTime, timeZone);
    const precip = formatNumber(item.precip);
    return `${time}：${precip} mm`;
  });
  const summary = normalizeText(data.summary);
  return [summary ? `摘要：${summary}` : '', rows.length ? rows.join('\n') : '暂无分钟降水数据']
    .filter(Boolean)
    .join('\n');
}

function formatAir(data = {}) {
  if (!Array.isArray(data.indexes)) throw new Error('QWeather air quality returned an invalid response');
  const index = data.indexes[0] || {};
  const pollutants = Array.isArray(data.pollutants) ? data.pollutants : [];
  const pollutant = pollutants.find((item) => /pm2p5|pm25/i.test(normalizeText(item.code))) || pollutants[0];
  const pollutantText = pollutant
    ? `${normalizeText(pollutant.name) || '主要污染物'} ${formatNumber(pollutant.concentration?.value ?? pollutant.value)} ${normalizeText(pollutant.concentration?.unit || pollutant.unit)}`.trim()
    : '暂无污染物明细';
  return `AQI：${normalizeText(index.aqiDisplay || index.aqi) || '-'}（${normalizeText(index.category) || '未知'}），${pollutantText}`;
}

function formatWarnings(data = {}) {
  if (!Array.isArray(data.alerts)) throw new Error('QWeather warning returned an invalid response');
  const active = data.alerts.filter((item) => !/(解除|取消|失效|结束)/u.test(normalizeText(item.status)));
  if (active.length === 0) return '当前无有效天气预警。';
  return active.map((item) => {
    const title = normalizeText(item.title || item.typeName) || '天气预警';
    const level = normalizeText(item.severityColor || item.level);
    const text = normalizeText(item.text);
    return `${title}${level ? `（${level}）` : ''}${text ? `：${text}` : ''}`;
  }).join('\n');
}

async function getWeatherSummary(rawArgs = {}, deps = {}) {
  const args = normalizeWeatherArgs(rawArgs);
  const location = extractWeatherLocation(args.location);
  if (!location) return '请提供要查询的城市或地区，例如“上海今天天气”或“伦敦天气”。';

  const client = deps.client || createQWeatherClient({
    apiHost: deps.apiHost,
    apiSecret: deps.apiSecret ?? deps.apiKey,
    httpClient: deps.httpClient,
    timeoutMs: deps.timeoutMs
  });
  const places = await client.lookupLocations(location);
  const candidates = Array.isArray(places?.location) ? places.location : [];
  const place = candidates[0];
  if (!place?.lat || !place?.lon) return `和风天气未找到“${location}”，请换用更完整的城市或地区名称。`;

  const latitude = place.lat;
  const longitude = place.lon;
  const timeZone = normalizeText(place.tz || place.timeZone) || config.TIMEZONE || 'Asia/Shanghai';
  const sections = new Set(args.sections);
  const now = typeof deps.now === 'function' ? deps.now() : new Date();
  const requests = [];

  if (sections.has('overview')) {
    requests.push(Promise.all([
      client.getCurrent(latitude, longitude),
      client.getDaily(latitude, longitude, args.days)
    ]).then(([current, daily]) => `【实况与预报】\n${formatOverview(current, daily, timeZone, now)}`));
  }
  if (sections.has('hourly')) {
    requests.push(client.getHourly(latitude, longitude, args.hours)
      .then((hourly) => `【逐小时预报】\n${formatHourly(hourly, timeZone, args.hours)}`));
  }
  if (sections.has('minutely')) {
    const country = normalizeText(place.country);
    if (!CHINA_COUNTRIES.has(country)) {
      requests.push(Promise.resolve('【分钟降水】\n分钟降水仅支持中国区域，海外地点暂不支持。'));
    } else {
      requests.push(client.getMinutely(latitude, longitude)
        .then((minutely) => `【未来两小时分钟降水】\n${formatMinutely(minutely, timeZone)}`));
    }
  }
  if (sections.has('air')) {
    requests.push(client.getAir(latitude, longitude)
      .then((air) => `【空气质量】\n${formatAir(air)}`));
  }
  if (sections.has('warning')) {
    requests.push(client.getWarning(latitude, longitude)
      .then((warning) => `【天气预警】\n${formatWarnings(warning)}`));
  }
  const blocks = await Promise.all(requests);

  return [
    `和风天气｜${formatLocation(place)}`,
    ...blocks,
    `来源：${QWEATHER_SOURCE}`
  ].join('\n');
}

module.exports = {
  CHINA_COUNTRIES,
  QWEATHER_SOURCE,
  formatAir,
  formatHourly,
  formatLocalTime,
  formatMinutely,
  formatOverview,
  formatWarnings,
  getWeatherSummary
};
